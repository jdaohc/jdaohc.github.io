import test from "node:test";
import assert from "node:assert/strict";
import worker, {
  buildViewPayload,
  fetchWeiboHot,
  filterPublicOpinionItems,
  formatHeat,
  getHotPayload,
  parseXinhuaLinks
} from "../src/worker.js";

test("formats heat values for mobile display", () => {
  assert.equal(formatHeat(0), "暂无");
  assert.equal(formatHeat(9832), "9832");
  assert.equal(formatHeat(120000), "12万");
  assert.equal(formatHeat(125500000), "1.25亿");
});

test("normalizes the Weibo hot search response", async () => {
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        data: {
          realtime: [
            { word: "OpenAI", note: "OpenAI 发布更新", raw_hot: 123456, label_name: "新" },
            { word: "电影", note: "暑期档电影", raw_hot: 98765, label_name: "" }
          ]
        }
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );

  const items = await fetchWeiboHot();
  assert.equal(items.length, 2);
  assert.equal(items[0].rank, 1);
  assert.equal(items[0].title, "OpenAI 发布更新");
  assert.equal(items[0].heat, "12.35万");
  assert.match(items[0].url, /s\.weibo\.com/);
  assert.equal(items[1].label, "热");
});

test("serves stale cache if live fetch fails", async () => {
  const cachedPayload = {
    ok: true,
    source: "live",
    updatedAt: Date.now() - 10 * 60 * 1000,
    updatedAtText: "07/06 10:00:00",
    items: [{ rank: 1, title: "缓存热点", word: "缓存热点", heat: "1万", label: "热", url: "#", isNew: false }],
    error: null
  };

  installCache(cachedPayload);
  globalThis.fetch = async () => new Response("blocked", { status: 403 });

  const payload = await getHotPayload({ force: true });
  assert.equal(payload.ok, true);
  assert.equal(payload.source, "stale-cache");
  assert.equal(payload.items[0].title, "缓存热点");
  assert.match(payload.error, /缓存/);
});

test("marks newly entered topics after refresh", async () => {
  installCache({
    ok: true,
    source: "live",
    updatedAt: Date.now() - 10 * 60 * 1000,
    updatedAtText: "07/06 10:00:00",
    items: [{ rank: 1, title: "旧热点", word: "旧热点", heat: "1万", label: "热", url: "#", isNew: false }],
    error: null
  });

  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        data: {
          realtime: [
            { word: "旧热点", note: "旧热点", raw_hot: 88888, label_name: "热" },
            { word: "新热点", note: "新热点", raw_hot: 66666, label_name: "新" }
          ]
        }
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );

  const payload = await getHotPayload({ force: true });
  assert.equal(payload.items[0].isNew, false);
  assert.equal(payload.items[1].isNew, true);
});

test("keeps public opinion topics and filters foreign or entertainment topics", () => {
  const items = [
    topic("广西洪水"),
    topic("2人造谣人贩抓人卖器官被行政处罚"),
    topic("博物馆通报国家一级文物现TCL字样"),
    topic("美国队红牌引发全球二创热潮"),
    topic("印度嫌犯奸杀12岁女孩遭民众打死"),
    topic("王俊凯坚持只买1980内场"),
    topic("迪丽热巴代言投广功夫女足")
  ];

  assert.deepEqual(
    filterPublicOpinionItems(items).map((item) => item.title),
    ["广西洪水", "2人造谣人贩抓人卖器官被行政处罚", "博物馆通报国家一级文物现TCL字样"]
  );
});

test("api defaults to filtered view and supports view=all", async () => {
  installCache(null);
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        data: {
          realtime: [
            { word: "广西洪水", note: "广西洪水", raw_hot: 100000, label_name: "热" },
            { word: "美国队红牌引发全球二创热潮", note: "美国队红牌引发全球二创热潮", raw_hot: 90000, label_name: "热" },
            { word: "博物馆通报国家一级文物现TCL字样", note: "博物馆通报国家一级文物现TCL字样", raw_hot: 80000, label_name: "新" },
            { word: "王俊凯坚持只买1980内场", note: "王俊凯坚持只买1980内场", raw_hot: 70000, label_name: "新" }
          ]
        }
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );

  const filtered = await worker.fetch(new Request("https://example.com/api/hot?force=1"));
  const filteredPayload = await filtered.json();
  assert.equal(filteredPayload.view, "filtered");
  assert.equal(filteredPayload.totalItems, 4);
  assert.deepEqual(
    filteredPayload.items.map((item) => item.title),
    ["广西洪水", "博物馆通报国家一级文物现TCL字样"]
  );

  const all = await worker.fetch(new Request("https://example.com/api/hot?view=all"));
  const allPayload = await all.json();
  assert.equal(allPayload.view, "all");
  assert.equal(allPayload.items.length, 4);
});

test("parses useful Xinhua links from public pages", () => {
  const links = parseXinhuaLinks(
    `
      <a href="/politics/20260706/example-id/c.html">国务院部署防汛救灾和民生保障工作</a>
      <a href="javascript:void(0)">更多</a>
      <a href="https://www.news.cn/legal/20260706/court-id/c.html"><span>法院通报电信诈骗案件审理情况</span></a>
    `,
    "https://www.news.cn/"
  );

  assert.deepEqual(
    links.map((link) => link.title),
    ["国务院部署防汛救灾和民生保障工作", "法院通报电信诈骗案件审理情况"]
  );
  assert.equal(links[0].url, "https://www.news.cn/politics/20260706/example-id/c.html");
});

test("filters the aggregated payload by source", () => {
  const payload = {
    ok: true,
    source: "live",
    updatedAt: Date.now(),
    updatedAtText: "07/06 10:00:00",
    items: [
      { ...topic("广西洪水"), source: "weibo", sourceName: "微博" },
      { ...topic("国务院部署防汛救灾和民生保障工作"), source: "xinhua", sourceName: "新华网/新华社", label: "新华" }
    ],
    error: null
  };

  const xinhua = buildViewPayload(payload, "filtered", "xinhua");
  assert.equal(xinhua.sourceFilter, "xinhua");
  assert.equal(xinhua.totalItems, 1);
  assert.equal(xinhua.items[0].source, "xinhua");

  const all = buildViewPayload(payload, "all", "all");
  assert.deepEqual(all.sourceCounts, { all: 2, weibo: 1, xinhua: 1 });
});

function topic(title) {
  return { rank: 1, source: "weibo", sourceName: "微博", title, word: title, heat: "1万", label: "热", url: "#", isNew: false };
}

function installCache(payload) {
  let stored = payload;
  globalThis.caches = {
    default: {
      async match() {
        return stored
          ? new Response(JSON.stringify(stored), { headers: { "content-type": "application/json" } })
          : undefined;
      },
      async put(_key, response) {
        stored = await response.json();
      }
    }
  };
}
