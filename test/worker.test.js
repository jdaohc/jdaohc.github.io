import test from "node:test";
import assert from "node:assert/strict";
import { fetchWeiboHot, formatHeat, getHotPayload } from "../src/worker.js";

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
