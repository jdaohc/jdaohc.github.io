import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  fetchAllHotSources,
  filterPublicOpinionItems,
  updateOpinionPool
} from "../src/worker.js";
import { OPINION_RULES } from "../src/opinion-rules.js";

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = path.join(ROOT_DIR, "data");
const DATA_FILE = path.join(DATA_DIR, "hot-data.json");

export async function collectHotData({
  previous = null,
  nowMs = Date.now(),
  fetcher = fetchAllHotSources
} = {}) {
  try {
    const result = await fetcher(previous);
    const previousWords = new Set((previous?.items ?? []).map((item) => `${item.source || "weibo"}:${item.word || item.title}`));
    const seen = new Set();
    const items = result.items
      .filter((item) => {
        const key = `${item.source || "weibo"}:${item.word || item.title}`.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .map((item) => {
        const isNew = previous ? !previousWords.has(`${item.source || "weibo"}:${item.word || item.title}`) : false;
        return { ...item, isNew, is_new: isNew };
      });

    const opinionResult = updateOpinionPool(previous?.opinionPool ?? [], items, nowMs);
    return buildStaticPayload({
      ok: true,
      source: result.statuses.some((status) => status.ok) ? "github-actions" : "stale-cache",
      updatedAt: nowMs,
      items,
      opinionPool: opinionResult.pool,
      filteredOut: opinionResult.filteredOut,
      sourceStatus: result.statuses,
      error: result.statuses.some((status) => status.ok)
        ? null
        : "\u6240\u6709\u70ed\u70b9\u6765\u6e90\u672c\u6b21\u6293\u53d6\u5931\u8d25\uff0c\u6b63\u5728\u4f7f\u7528\u4e0a\u6b21\u7f13\u5b58\u3002"
    });
  } catch (error) {
    if (previous?.items?.length) {
      return buildStaticPayload({
        ...previous,
        ok: true,
        source: "stale-cache",
        updatedAt: nowMs,
        error: "\u672c\u6b21\u6293\u53d6\u5931\u8d25\uff0c\u6b63\u5728\u4f7f\u7528\u4e0a\u6b21\u7f13\u5b58\u3002"
      });
    }

    return buildStaticPayload({
      ok: false,
      source: "empty",
      updatedAt: nowMs,
      items: [],
      opinionPool: [],
      filteredOut: [],
      sourceStatus: [],
      error: error?.message || String(error)
    });
  }
}

export function buildStaticPayload(payload) {
  const items = Array.isArray(payload.items) ? payload.items : [];
  const updatedAt = Number(payload.updatedAt || Date.now());
  return {
    ok: Boolean(payload.ok),
    source: payload.source || "github-actions",
    updatedAt,
    updatedAtText: formatChinaTime(updatedAt),
    generatedAt: new Date(updatedAt).toISOString(),
    items,
    publicOpinionItems: filterPublicOpinionItems(items, new Date(updatedAt)),
    opinionPool: Array.isArray(payload.opinionPool) ? payload.opinionPool : [],
    filteredOut: Array.isArray(payload.filteredOut) ? payload.filteredOut : [],
    categories: OPINION_RULES.categories.map((category) => category.name).concat(["\u5176\u4ed6"]),
    sourceCounts: countSources(items),
    sourceStatus: Array.isArray(payload.sourceStatus) ? payload.sourceStatus : [],
    error: payload.error || null
  };
}

export async function readPreviousPayload(filePath = DATA_FILE) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}

export async function writePayload(payload, filePath = DATA_FILE) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function countSources(items) {
  const counts = { all: items.length, weibo: 0, xinhua: 0, zhihu: 0, toutiao: 0, douyin: 0, people: 0, news: 0 };
  for (const item of items) {
    const source = item.source || "weibo";
    counts[source] = (counts[source] || 0) + 1;
  }
  return counts;
}

function formatChinaTime(value) {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).format(new Date(value));
}

async function main() {
  const previous = await readPreviousPayload();
  const payload = await collectHotData({ previous });
  await writePayload(payload);
  console.log(`wrote ${path.relative(ROOT_DIR, DATA_FILE)} with ${payload.items.length} hot items and ${payload.opinionPool.length} opinion items`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
