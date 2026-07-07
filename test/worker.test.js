import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import worker, {
  buildViewPayload,
  fetchWeiboHot,
  filterPublicOpinionItems,
  formatHeat,
  getHotPayload,
  parseXinhuaLinks
} from "../src/worker.js";

const require = createRequire(import.meta.url);
const { main_handler } = require("../src/tencent-scf.cjs");

const CN = {
  none: "\u6682\u65e0",
  hot: "\u70ed",
  new: "\u65b0",
  oldTopic: "\u65e7\u70ed\u70b9",
  newTopic: "\u65b0\u70ed\u70b9",
  cacheTopic: "\u7f13\u5b58\u70ed\u70b9",
  failed: "\u5931\u8d25",
  weibo: "\u5fae\u535a",
  xinhua: "\u65b0\u534e",
  xinhuaName: "\u65b0\u534e\u7f51/\u65b0\u534e\u793e",
  guangxiFlood: "\u5e7f\u897f\u6d2a\u6c34",
  rumorPenalty: "2\u4eba\u9020\u8c23\u88ab\u884c\u653f\u5904\u7f5a",
  museumNotice: "\u535a\u7269\u9986\u901a\u62a5\u4e00\u6e38\u5ba2\u635f\u574f\u6587\u7269",
  museumNoticeShort: "\u535a\u7269\u9986\u901a\u62a5\u6e38\u5ba2\u635f\u574f\u6587\u7269",
  usWorldCup: "\u7f8e\u56fd\u961f\u664b\u7ea7\u4e16\u754c\u676f",
  indiaSuspect: "\u5370\u5ea6\u5acc\u72af\u6740\u5bb312\u540d\u5973\u6027",
  concert: "\u67d0\u660e\u661f\u6f14\u5531\u4f1a\u95e8\u7968\u5f00\u552e",
  variety: "\u70ed\u95e8\u7efc\u827a\u5b98\u5ba3\u5609\u5bbe\u9635\u5bb9",
  xinhuaFlood: "\u56fd\u52a1\u9662\u90e8\u7f72\u9632\u6c5b\u6551\u707e\u5de5\u4f5c",
  courtFraud: "\u6cd5\u9662\u901a\u62a5\u8bc8\u9a97\u6848\u4ef6\u8fdb\u5c55",
  policeCrash: "\u8b66\u65b9\u901a\u62a5\u4ea4\u901a\u4e8b\u6545\u8c03\u67e5\u60c5\u51b5",
  xinhuaFloodLong: "\u56fd\u52a1\u9662\u90e8\u7f72\u9632\u6c5b\u6551\u707e\u548c\u6c11\u751f\u4fdd\u969c\u5de5\u4f5c",
  more: "\u66f4\u591a",
  courtTelecomFraud: "\u6cd5\u9662\u901a\u62a5\u7535\u4fe1\u8bc8\u9a97\u6848\u4ef6\u5ba1\u7406\u60c5\u51b5"
};

test("formats heat values for mobile display", () => {
  assert.equal(formatHeat(0), CN.none);
  assert.equal(formatHeat(9832), "9832");
  assert.equal(formatHeat(120000), "12\u4e07");
  assert.equal(formatHeat(125500000), "1.25\u4ebf");
});

test("normalizes the Weibo hot search response", async () => {
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        data: {
          realtime: [
            { word: "OpenAI", note: "OpenAI \u53d1\u5e03\u65b0\u6a21\u578b", raw_hot: 123456, label_name: CN.hot },
            { word: "\u7535\u5f71", note: "\u6691\u671f\u6863\u7535\u5f71", raw_hot: 98765, label_name: "" }
          ]
        }
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );

  const items = await fetchWeiboHot();
  assert.equal(items.length, 2);
  assert.equal(items[0].rank, 1);
  assert.equal(items[0].title, "OpenAI \u53d1\u5e03\u65b0\u6a21\u578b");
  assert.equal(items[0].heat, "12.35\u4e07");
  assert.match(items[0].url, /s\.weibo\.com/);
  assert.equal(items[1].label, CN.hot);
});

test("serves stale cache if live fetch fails", async () => {
  const cachedPayload = {
    ok: true,
    source: "live",
    updatedAt: Date.now() - 10 * 60 * 1000,
    updatedAtText: "07/06 10:00:00",
    items: [{ rank: 1, title: CN.cacheTopic, word: CN.cacheTopic, heat: "1\u4e07", label: CN.hot, url: "#", isNew: false }],
    error: null
  };

  installCache(cachedPayload);
  globalThis.fetch = async () => new Response("blocked", { status: 403 });

  const payload = await getHotPayload({ force: true });
  assert.equal(payload.ok, true);
  assert.equal(payload.source, "stale-cache");
  assert.equal(payload.items[0].title, CN.cacheTopic);
  assert.match(payload.error, /\u4e0d\u53ef\u7528/);
});

test("marks newly entered topics after refresh", async () => {
  installCache({
    ok: true,
    source: "live",
    updatedAt: Date.now() - 10 * 60 * 1000,
    updatedAtText: "07/06 10:00:00",
    items: [{ rank: 1, title: CN.oldTopic, word: CN.oldTopic, heat: "1\u4e07", label: CN.hot, url: "#", isNew: false }],
    error: null
  });

  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        data: {
          realtime: [
            { word: CN.oldTopic, note: CN.oldTopic, raw_hot: 88888, label_name: CN.hot },
            { word: CN.newTopic, note: CN.newTopic, raw_hot: 66666, label_name: CN.new }
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
    topic(CN.guangxiFlood),
    topic(CN.rumorPenalty),
    topic(CN.museumNotice),
    topic(CN.usWorldCup),
    topic(CN.indiaSuspect),
    topic(CN.concert),
    topic(CN.variety)
  ];

  assert.deepEqual(
    filterPublicOpinionItems(items).map((item) => item.title),
    [CN.guangxiFlood, CN.rumorPenalty, CN.museumNotice]
  );
});

test("filtered Xinhua public-opinion items must be from today or yesterday", () => {
  const now = new Date("2026-07-07T10:00:00+08:00");
  const items = [
    { ...topic(CN.guangxiFlood), source: "weibo", sourceName: CN.weibo },
    { ...topic(CN.xinhuaFlood), source: "xinhua", sourceName: CN.xinhuaName, label: CN.xinhua, dateKey: "20260707" },
    { ...topic(CN.courtFraud), source: "xinhua", sourceName: CN.xinhuaName, label: CN.xinhua, dateKey: "20260706" },
    { ...topic(CN.policeCrash), source: "xinhua", sourceName: CN.xinhuaName, label: CN.xinhua, dateKey: "20260705" },
    { ...topic(CN.museumNoticeShort), source: "xinhua", sourceName: CN.xinhuaName, label: CN.xinhua, dateKey: undefined }
  ];

  assert.deepEqual(
    filterPublicOpinionItems(items, now).map((item) => item.title),
    [CN.guangxiFlood, CN.xinhuaFlood, CN.courtFraud]
  );
});

test("api defaults to filtered view and supports view=all", async () => {
  installCache(null);
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        data: {
          realtime: [
            { word: CN.guangxiFlood, note: CN.guangxiFlood, raw_hot: 100000, label_name: CN.hot },
            { word: CN.usWorldCup, note: CN.usWorldCup, raw_hot: 90000, label_name: CN.hot },
            { word: CN.museumNotice, note: CN.museumNotice, raw_hot: 80000, label_name: CN.hot },
            { word: CN.concert, note: CN.concert, raw_hot: 70000, label_name: CN.hot }
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
    [CN.guangxiFlood, CN.museumNotice]
  );

  const all = await worker.fetch(new Request("https://example.com/api/hot?view=all"));
  const allPayload = await all.json();
  assert.equal(allPayload.view, "all");
  assert.equal(allPayload.items.length, 4);
});

test("parses useful Xinhua links from public pages", () => {
  const links = parseXinhuaLinks(
    `
      <a href="/politics/20260706/example-id/c.html">${CN.xinhuaFloodLong}</a>
      <a href="javascript:void(0)">${CN.more}</a>
      <a href="https://www.news.cn/legal/20260706/court-id/c.html"><span>${CN.courtTelecomFraud}</span></a>
    `,
    "https://www.news.cn/"
  );

  assert.deepEqual(
    links.map((link) => link.title),
    [CN.xinhuaFloodLong, CN.courtTelecomFraud]
  );
  assert.equal(links[0].url, "https://www.news.cn/politics/20260706/example-id/c.html");
  assert.equal(links[0].dateKey, "20260706");
});

test("filters the aggregated payload by source", () => {
  const payload = {
    ok: true,
    source: "live",
    updatedAt: Date.now(),
    updatedAtText: "07/06 10:00:00",
    items: [
      { ...topic(CN.guangxiFlood), source: "weibo", sourceName: CN.weibo },
      { ...topic(CN.xinhuaFloodLong), source: "xinhua", sourceName: CN.xinhuaName, label: CN.xinhua, dateKey: todayDateKey() }
    ],
    error: null
  };

  const xinhua = buildViewPayload(payload, "filtered", "xinhua");
  assert.equal(xinhua.sourceFilter, "xinhua");
  assert.equal(xinhua.totalItems, 1);
  assert.equal(xinhua.items[0].source, "xinhua");

  const all = buildViewPayload(payload, "all", "all");
  assert.deepEqual(all.sourceCounts, { all: 2, weibo: 1, xinhua: 1, toutiao: 0, douyin: 0, people: 0, news: 0, zhihu: 0 });
});

test("supports newly added platform source filters and unavailable status", () => {
  const payload = {
    ok: true,
    source: "live",
    updatedAt: Date.now(),
    updatedAtText: "07/07 10:00:00",
    items: [
      { ...topic(CN.guangxiFlood), source: "toutiao", sourceName: "\u4eca\u65e5\u5934\u6761" },
      { ...topic(CN.courtFraud), source: "douyin", sourceName: "\u6296\u97f3" },
      { ...topic(CN.xinhuaFloodLong), source: "news", sourceName: "\u5176\u4ed6\u65b0\u95fb" }
    ],
    sourceStatus: [
      { id: "zhihu", name: "\u77e5\u4e4e", ok: false, fallback: false, count: 0, error: "HTTP 403" }
    ],
    error: null
  };

  const toutiao = buildViewPayload(payload, "all", "toutiao");
  assert.equal(toutiao.sourceFilter, "toutiao");
  assert.equal(toutiao.items.length, 1);
  assert.equal(toutiao.items[0].source, "toutiao");
  assert.equal(toutiao.sourceStatus[0].id, "zhihu");

  const all = buildViewPayload(payload, "all", "all");
  assert.equal(all.sourceCounts.toutiao, 1);
  assert.equal(all.sourceCounts.douyin, 1);
  assert.equal(all.sourceCounts.news, 1);
});

test("Tencent SCF adapter preserves object query parameters", async () => {
  installCache(null);
  globalThis.fetch = async (url) => {
    const target = String(url);
    if (target.includes("weibo.com")) {
      return new Response(
        JSON.stringify({
          data: {
            realtime: [
              { word: CN.guangxiFlood, note: CN.guangxiFlood, raw_hot: 100000, label_name: CN.hot }
            ]
          }
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }

    return new Response(
      `<a href="/politics/${todayDateKey()}/example-id/c.html">${CN.xinhuaFloodLong}</a>`,
      { status: 200, headers: { "content-type": "text/html" } }
    );
  };

  const response = await main_handler({
    httpMethod: "GET",
    path: "/api/hot",
    queryString: { source: "xinhua", view: "all", force: "1" },
    headers: { host: "scf.local" }
  });
  const payload = JSON.parse(response.body);

  assert.equal(response.statusCode, 200);
  assert.equal(payload.sourceFilter, "xinhua");
  assert.equal(payload.view, "all");
  assert.equal(payload.items.length, 1);
  assert.equal(payload.items[0].source, "xinhua");
});

function topic(title) {
  return { rank: 1, source: "weibo", sourceName: CN.weibo, title, word: title, hot_value: 10000, heat: "1\u4e07", tag: CN.hot, label: CN.hot, publish_time: new Date().toISOString(), dateKey: todayDateKey(), url: "#", isNew: false, is_new: false };
}

function todayDateKey() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date()).replaceAll("-", "");
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
