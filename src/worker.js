import { OPINION_RULES } from "./opinion-rules.js";

const CACHE_KEY = "https://weibo-hot-monitor.local/cache/v1/hot";
const REFRESH_INTERVAL_MS = 5 * 60 * 1000;
const CACHE_TTL_SECONDS = 60 * 60 * 24;
const XINHUA_SECTIONS = [
  "https://www.news.cn/",
  "https://www.news.cn/politics/",
  "https://www.news.cn/legal/"
];
const TOUTIAO_HOT_URL = "https://www.toutiao.com/hot-event/hot-board/?origin=toutiao_pc";
const PEOPLE_RSS_URL = "https://www.people.com.cn/rss/politics.xml";
const OTHER_NEWS_RSS_URL = "https://www.chinanews.com.cn/rss/china.xml";
const ZHIHU_BILLBOARD_URL = "https://www.zhihu.com/billboard";
const DOUYIN_PUBLIC_HOT_URL = "https://www.douyin.com/aweme/v1/web/hot/search/list/";
const SOURCE_DEFINITIONS = [
  { id: "weibo", name: "\u5fae\u535a", fetcher: fetchWeiboHot },
  { id: "xinhua", name: "\u65b0\u534e\u7f51/\u65b0\u534e\u793e", fetcher: fetchXinhuaHot },
  { id: "toutiao", name: "\u4eca\u65e5\u5934\u6761", fetcher: fetchToutiaoHot },
  { id: "douyin", name: "\u6296\u97f3", fetcher: fetchDouyinHot },
  { id: "people", name: "\u4eba\u6c11\u65e5\u62a5", fetcher: fetchPeopleDailyHot },
  { id: "news", name: "\u5176\u4ed6\u65b0\u95fb", fetcher: fetchOtherNewsHot },
  { id: "zhihu", name: "\u77e5\u4e4e", fetcher: fetchZhihuHot }
];
const SOURCE_IDS = SOURCE_DEFINITIONS.map((source) => source.id);
const USER_AGENT =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/api/hot") {
      const force = url.searchParams.get("force") === "1";
      const view = normalizeView(url.searchParams.get("view"));
      const sourceFilter = normalizeSourceFilter(url.searchParams.get("source"));
      const payload = await getHotPayload({ force, ctx });
      return json(buildViewPayload(payload, view, sourceFilter), payload.ok ? 200 : 503);
    }

    if (url.pathname === "/api/opinion") {
      const force = url.searchParams.get("force") === "1";
      const payload = await getHotPayload({ force, ctx });
      return json(buildOpinionPayload(payload, url.searchParams), payload.ok ? 200 : 503);
    }

    if (url.pathname === "/health") {
      return new Response("ok", { headers: { "content-type": "text/plain;charset=utf-8" } });
    }

    return new Response(renderPage(), {
      headers: {
        "content-type": "text/html;charset=utf-8",
        "cache-control": "public, max-age=60"
      }
    });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(getHotPayload({ force: true, ctx }));
  }
};

export async function getHotPayload({ force = false, ctx } = {}) {
  const cached = await readCache();
  const isFresh = cached && Date.now() - cached.updatedAt < REFRESH_INTERVAL_MS;

  if (!force && isFresh) {
    return { ...cached, source: "cache", ok: true };
  }

  try {
    const result = await fetchAllHotSources(cached);
    const previousWords = new Set((cached?.items ?? []).map((item) => `${item.source || "weibo"}:${item.word || item.title}`));
    const seen = new Set();
    const items = result.items
      .filter((item) => {
        const key = `${item.source || "weibo"}:${item.word || item.title}`.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .map((item) => {
        const isNew = cached ? !previousWords.has(`${item.source || "weibo"}:${item.word || item.title}`) : false;
        return { ...item, isNew, is_new: isNew };
      });
    const opinionResult = updateOpinionPool(cached?.opinionPool ?? [], items, Date.now());

    const payload = {
      ok: true,
      source: result.statuses.some((status) => status.ok) ? "live" : "stale-cache",
      updatedAt: Date.now(),
      updatedAtText: formatDate(Date.now()),
      items,
      opinionPool: opinionResult.pool,
      filteredOut: opinionResult.filteredOut,
      sourceStatus: result.statuses,
      error: result.statuses.some((status) => status.ok)
        ? null
        : "\u90e8\u5206\u70ed\u70b9\u6765\u6e90\u6682\u65f6\u4e0d\u53ef\u7528\uff0c\u6b63\u5728\u5c55\u793a\u6700\u8fd1\u4e00\u6b21\u6210\u529f\u7f13\u5b58\u3002"
    };

    const write = writeCache(payload);
    if (ctx?.waitUntil) ctx.waitUntil(write);
    else await write;

    return payload;
  } catch (error) {
    if (cached) {
      return {
        ...cached,
        ok: true,
        source: "stale-cache",
        error: "\u90e8\u5206\u70ed\u70b9\u6765\u6e90\u6682\u65f6\u4e0d\u53ef\u7528\uff0c\u6b63\u5728\u5c55\u793a\u6700\u8fd1\u4e00\u6b21\u6210\u529f\u7f13\u5b58\u3002"
      };
    }

    return {
      ok: false,
      source: "empty",
      updatedAt: Date.now(),
      updatedAtText: formatDate(Date.now()),
      items: [],
      sourceStatus: SOURCE_DEFINITIONS.map((source) => ({
        id: source.id,
        name: source.name,
        ok: false,
        fallback: false,
        count: 0,
        error: readableError(error)
      })),
      error: readableError(error)
    };
  }
}

export function toViewPayload(payload, view = "filtered") {
  const normalizedView = normalizeView(view);
  return buildViewPayload(payload, normalizedView, "all");
}

export function buildViewPayload(payload, view = "filtered", sourceFilter = "all") {
  const normalizedView = normalizeView(view);
  const normalizedSource = normalizeSourceFilter(sourceFilter);
  const allItems = Array.isArray(payload.items) ? payload.items : [];
  const sourceItems = (normalizedSource === "all"
    ? allItems
    : allItems.filter((item) => (item.source || "weibo") === normalizedSource))
    .filter((item) => isRecentPublicOpinionItem(item));
  const items = normalizedView === "all" ? sourceItems : filterPublicOpinionItems(sourceItems);

  return {
    ...payload,
    view: normalizedView,
    sourceFilter: normalizedSource,
    sourceCounts: countSources(allItems),
    sourceStatus: payload.sourceStatus || [],
    totalItems: sourceItems.length,
    visibleItems: items.length,
    items
  };
}

export function filterPublicOpinionItems(items, now = new Date()) {
  return items.filter((item) => isPublicOpinionItem(item) && isRecentPublicOpinionItem(item, now));
}

export function buildOpinionPayload(payload, params = new URLSearchParams()) {
  const platform = normalizeOpinionFilter(params.get("platform"), SOURCE_IDS);
  const category = normalizeOpinionFilter(params.get("category"));
  const day = normalizeOpinionFilter(params.get("day"), ["today", "yesterday"]);
  const status = normalizeOpinionFilter(params.get("status"), ["current", "dropped"]);
  const value = normalizeOpinionFilter(params.get("value"), ["high"]);
  const multi = params.get("multi") === "1";
  const debug = params.get("debug") === "1";
  const sort = normalizeOpinionFilter(params.get("sort"), [
    "score", "current_heat", "peak_heat", "first_seen", "last_seen", "duration"
  ]) || "score";
  const today = getChinaDateKey(new Date());
  const yesterday = getChinaDateKey(new Date(Date.now() - 24 * 60 * 60 * 1000));
  let items = Array.isArray(payload.opinionPool) ? payload.opinionPool : [];

  items = items.filter((item) => item.date === today || item.date === yesterday);
  if (platform) items = items.filter((item) => item.platforms?.includes(platform));
  if (category) items = items.filter((item) => item.category === category);
  if (day === "today") items = items.filter((item) => item.date === today);
  if (day === "yesterday") items = items.filter((item) => item.date === yesterday);
  if (status === "current") items = items.filter((item) => item.is_currently_hot);
  if (status === "dropped") items = items.filter((item) => !item.is_currently_hot);
  if (value === "high") items = items.filter((item) => item.score >= 80);
  if (multi) items = items.filter((item) => item.platform_count > 1);

  return {
    ok: payload.ok,
    source: payload.source,
    updatedAt: payload.updatedAt,
    updatedAtText: payload.updatedAtText,
    filters: { platform, category, day, status, value, multi, sort },
    categories: OPINION_RULES.categories.map((categoryConfig) => categoryConfig.name).concat(["\u5176\u4ed6"]),
    totalItems: items.length,
    items: sortOpinionItems(items, sort),
    filteredOut: debug ? (payload.filteredOut || []) : undefined,
    sourceStatus: payload.sourceStatus || [],
    error: payload.error
  };
}

export function updateOpinionPool(previousPool, currentItems, nowMs = Date.now()) {
  const now = new Date(nowMs);
  const today = getChinaDateKey(now);
  const yesterday = getChinaDateKey(new Date(nowMs - 24 * 60 * 60 * 1000));
  const retained = new Map();
  const filteredOut = [];

  for (const record of previousPool || []) {
    if (record?.date !== today && record?.date !== yesterday) continue;
    retained.set(record.event_key, {
      ...record,
      is_currently_hot: false,
      status: "\u5df2\u4e0b\u699c",
      current_rank: null,
      hot_value: null,
      hot_value_text: "--",
      sources: markSourcesDropped(record.sources || {})
    });
  }

  const currentEvaluations = [];
  for (const item of currentItems || []) {
    if (!isRecentPublicOpinionItem(item, now)) continue;
    const evaluation = evaluateOpinionItem(item);
    if (!evaluation.keep) {
      filteredOut.push({
        title: item.title,
        source: item.source,
        reason: evaluation.reason,
        score: evaluation.score
      });
      continue;
    }
    currentEvaluations.push({ item, evaluation });
  }

  for (const { item, evaluation } of currentEvaluations) {
    const eventKey = findOpinionEventKey(item, retained);
    const existing = retained.get(eventKey);
    const next = mergeOpinionRecord(existing, item, evaluation, eventKey, now);
    retained.set(eventKey, next);
  }

  const pool = [...retained.values()]
    .map((record) => finalizeOpinionRecord(record, now))
    .filter((record) => record.score >= OPINION_RULES.minScore)
    .sort((a, b) => b.score - a.score || new Date(b.last_seen) - new Date(a.last_seen));

  return { pool, filteredOut };
}

export function isPublicOpinionItem(item) {
  const text = `${item?.title ?? ""} ${item?.word ?? ""} ${item?.label ?? ""} ${item?.sourceName ?? ""}`.toLowerCase();
  if (!text.trim()) return false;

  if (containsAny(text, STRONG_PUBLIC_OPINION_KEYWORDS)) return true;
  if (containsAny(text, EXCLUDE_KEYWORDS)) return false;
  if (containsAny(text, FOREIGN_KEYWORDS) && !containsAny(text, DOMESTIC_CONTEXT_KEYWORDS)) return false;

  return containsAny(text, PUBLIC_OPINION_KEYWORDS);
}

export function isRecentPublicOpinionItem(item, now = new Date()) {
  if (!item?.dateKey) return false;
  return getRecentChinaDateKeys(now).has(item.dateKey);
}

export async function fetchAllHotSources(cached) {
  const previousBySource = groupCachedItemsBySource(cached?.items ?? []);
  const results = await Promise.all(
    SOURCE_DEFINITIONS.map((source) => fetchSourceWithFallback(source, previousBySource))
  );

  if (results.every((result) => !result.ok && !result.items.length)) throw new Error("All hot sources failed");
  const items = dedupeAcrossSources(results.flatMap((result) => result.items));
  if (!items.length) throw new Error("All hot sources failed");
  return {
    items,
    statuses: results.map(({ id, name, ok, fallback, error, count }) => ({ id, name, ok, fallback, error, count }))
  };
}

async function fetchSourceWithFallback(source, previousBySource) {
  try {
    const items = await retry(source.fetcher, 2, 650);
    return { id: source.id, name: source.name, ok: true, fallback: false, items, count: items.length, error: null };
  } catch (error) {
    const fallbackItems = previousBySource.get(source.id) ?? [];
    return {
      id: source.id,
      name: source.name,
      ok: false,
      fallback: Boolean(fallbackItems.length),
      items: fallbackItems,
      count: fallbackItems.length,
      error: readableError(error)
    };
  }
}

export async function fetchWeiboHot() {
  const response = await fetch("https://weibo.com/ajax/side/hotSearch", {
    headers: {
      accept: "application/json,text/plain,*/*",
      "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
      referer: "https://weibo.com/",
      "user-agent": USER_AGENT
    },
    cf: { cacheTtl: 60, cacheEverything: false }
  });

  if (!response.ok) {
    throw new Error(`Weibo responded with HTTP ${response.status}`);
  }

  const data = await response.json();
  const rawItems = data?.data?.realtime;
  if (!Array.isArray(rawItems)) {
    throw new Error("Unexpected Weibo response shape");
  }

  const now = new Date();
  return rawItems
    .filter((item) => item?.word || item?.note)
    .slice(0, 50)
    .map((item, index) => {
      const word = String(item.word || item.note || "").trim();
      const hotValue = item.raw_hot ?? item.num ?? item.hot_num ?? item.onboard_time ?? 0;
      const tag = normalizeLabel(item.label_name || item.category || item.icon_desc);
      return normalizeHotItem({
        rank: index + 1,
        source: "weibo",
        sourceName: "\u5fae\u535a",
        title: String(item.note || word).trim(),
        word,
        hot_value: hotValue,
        heat: formatHeat(hotValue),
        tag,
        label: tag,
        publish_time: now.toISOString(),
        dateKey: getChinaDateKey(now),
        url: `https://s.weibo.com/weibo?q=${encodeURIComponent(word)}&Refer=top`
      });
    });
}

export async function fetchXinhuaHot() {
  const pages = await Promise.all(
    XINHUA_SECTIONS.map(async (url) => ({
      url,
      html: await fetchText(url)
    }))
  );
  const seen = new Set();
  const items = [];

  for (const page of pages) {
    for (const link of parseXinhuaLinks(page.html, page.url)) {
      const key = normalizeTopicKey(link.title);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      items.push(normalizeHotItem({
        rank: items.length + 1,
        source: "xinhua",
        sourceName: "\u65b0\u534e\u7f51/\u65b0\u534e\u793e",
        title: link.title,
        word: link.title,
        hot_value: "\u65b0\u534e\u7f51",
        heat: "\u65b0\u534e\u7f51",
        tag: "\u65b0\u534e",
        label: "\u65b0\u534e",
        publish_time: dateKeyToIso(link.dateKey),
        url: link.url,
        dateKey: link.dateKey
      }));
      if (items.length >= 50) return items;
    }
  }

  if (!items.length) throw new Error("No Xinhua links found");
  return items;
}

export async function fetchToutiaoHot() {
  const response = await fetch(TOUTIAO_HOT_URL, {
    headers: {
      accept: "application/json,text/plain,*/*",
      "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
      referer: "https://www.toutiao.com/",
      "user-agent": USER_AGENT
    },
    cf: { cacheTtl: 120, cacheEverything: false }
  });
  if (!response.ok) throw new Error(`Toutiao responded with HTTP ${response.status}`);
  const data = await response.json();
  const rows = Array.isArray(data?.data) ? data.data : [];
  const now = new Date();
  return rows
    .filter((item) => item?.Title)
    .slice(0, 50)
    .map((item, index) => normalizeHotItem({
      rank: index + 1,
      source: "toutiao",
      sourceName: "\u4eca\u65e5\u5934\u6761",
      title: String(item.Title).trim(),
      word: String(item.Title).trim(),
      hot_value: item.HotValue ?? 0,
      heat: formatHeat(item.HotValue),
      tag: normalizeToutiaoLabel(item.Label),
      label: normalizeToutiaoLabel(item.Label),
      publish_time: now.toISOString(),
      dateKey: getChinaDateKey(now),
      url: item.Url || `https://www.toutiao.com/search/?keyword=${encodeURIComponent(item.Title)}`
    }));
}

export async function fetchPeopleDailyHot() {
  const xml = await fetchText(PEOPLE_RSS_URL);
  return parseRssItems(xml, {
    source: "people",
    sourceName: "\u4eba\u6c11\u65e5\u62a5",
    tag: "\u65f6\u653f",
    limit: 50
  });
}

export async function fetchOtherNewsHot() {
  const xml = await fetchText(OTHER_NEWS_RSS_URL);
  return parseRssItems(xml, {
    source: "news",
    sourceName: "\u5176\u4ed6\u65b0\u95fb",
    tag: "\u4e2d\u65b0\u7f51",
    limit: 50
  });
}

export async function fetchZhihuHot() {
  const response = await fetch(ZHIHU_BILLBOARD_URL, {
    headers: {
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
      "user-agent": USER_AGENT
    },
    cf: { cacheTtl: 120, cacheEverything: false }
  });
  if (!response.ok) throw new Error(`Zhihu public billboard unavailable: HTTP ${response.status}`);
  const html = await response.text();
  const links = parseGenericArticleLinks(html, "https://www.zhihu.com/", /\/question\/\d+/i);
  const now = new Date();
  const items = links.slice(0, 30).map((link, index) => normalizeHotItem({
    rank: index + 1,
    source: "zhihu",
    sourceName: "\u77e5\u4e4e",
    title: link.title,
    word: link.title,
    hot_value: "\u77e5\u4e4e",
    heat: "\u77e5\u4e4e",
    tag: "\u70ed\u699c",
    label: "\u70ed\u699c",
    publish_time: now.toISOString(),
    dateKey: getChinaDateKey(now),
    url: link.url
  }));
  if (!items.length) throw new Error("No Zhihu public billboard links found");
  return items;
}

export async function fetchDouyinHot() {
  const response = await fetch(DOUYIN_PUBLIC_HOT_URL, {
    headers: {
      accept: "application/json,text/plain,*/*",
      "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
      referer: "https://www.douyin.com/",
      "user-agent": USER_AGENT
    },
    cf: { cacheTtl: 120, cacheEverything: false }
  });
  const text = await response.text();
  if (!response.ok || !text.trim()) {
    throw new Error("\u6296\u97f3\u516c\u5f00\u70ed\u699c\u6682\u4e0d\u53ef\u7528");
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("\u6296\u97f3\u516c\u5f00\u70ed\u699c\u54cd\u5e94\u4e0d\u662f\u7a33\u5b9a JSON");
  }
  const rows = data?.data?.word_list || data?.word_list || [];
  if (!Array.isArray(rows) || !rows.length) throw new Error("\u6296\u97f3\u516c\u5f00\u70ed\u699c\u6682\u65e0\u6570\u636e");
  const now = new Date();
  return rows.slice(0, 50).map((item, index) => {
    const title = String(item.word || item.sentence || item.title || "").trim();
    return normalizeHotItem({
      rank: index + 1,
      source: "douyin",
      sourceName: "\u6296\u97f3",
      title,
      word: title,
      hot_value: item.hot_value ?? item.hot_score ?? 0,
      heat: formatHeat(item.hot_value ?? item.hot_score),
      tag: "\u70ed\u699c",
      label: "\u70ed\u699c",
      publish_time: now.toISOString(),
      dateKey: getChinaDateKey(now),
      url: `https://www.douyin.com/search/${encodeURIComponent(title)}`
    });
  }).filter((item) => item.title);
}

async function fetchText(url) {
  const response = await fetch(url, {
    headers: {
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
      "user-agent": USER_AGENT
    },
    cf: { cacheTtl: 120, cacheEverything: false }
  });

  if (!response.ok) throw new Error(`${url} responded with HTTP ${response.status}`);
  return response.text();
}

export function parseXinhuaLinks(html, baseUrl = "https://www.news.cn/") {
  const links = [];
  const anchorPattern = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match;

  while ((match = anchorPattern.exec(html))) {
    const url = toAbsoluteUrl(match[1], baseUrl);
    const title = cleanHtmlText(match[2]);
    if (!url || !isXinhuaArticleUrl(url) || !isUsefulXinhuaTitle(title)) continue;
    links.push({ title, url, dateKey: extractXinhuaDateKey(url) });
  }

  return links;
}

function isXinhuaArticleUrl(url) {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    const isAllowedHost =
      host === "news.cn" ||
      host.endsWith(".news.cn") ||
      host === "xinhuanet.com" ||
      host.endsWith(".xinhuanet.com") ||
      host === "piyao.org.cn" ||
      host.endsWith(".piyao.org.cn");
    return isAllowedHost && /\/20\d{6}\/.+\/c\.html/i.test(parsed.pathname);
  } catch {
    return false;
  }
}

function extractXinhuaDateKey(url) {
  return new URL(url).pathname.match(/\/(20\d{6})\//)?.[1] || "";
}

function isUsefulXinhuaTitle(title) {
  if (title.length < 6 || title.length > 80) return false;
  if (/^(\u65b0\u534e\u7f51|\u65b0\u534e\u793e|\u9996\u9875|\u66f4\u591a|\u89c6\u9891|\u56fe\u7247|\u5ba2\u6237\u7aef|English)$/i.test(title)) return false;
  if (/[{}<>]/.test(title)) return false;
  return /[\u4e00-\u9fa5]/.test(title);
}

function cleanHtmlText(html) {
  return decodeHtmlEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
  );
}

function decodeHtmlEntities(text) {
  return text
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function toAbsoluteUrl(href, baseUrl) {
  if (!href || href.startsWith("javascript:") || href.startsWith("#")) return "";
  try {
    return new URL(href, baseUrl).toString();
  } catch {
    return "";
  }
}

function parseRssItems(xml, { source, sourceName, tag, limit }) {
  const items = [];
  const itemPattern = /<item\b[\s\S]*?<\/item>/gi;
  let match;
  while ((match = itemPattern.exec(xml))) {
    const block = match[0];
    const title = cleanHtmlText(readXmlTag(block, "title"));
    const url = decodeHtmlEntities(readXmlTag(block, "link")).trim();
    const pubDate = readXmlTag(block, "pubDate") || readXmlTag(block, "date");
    const published = parsePublishDate(pubDate);
    if (!title || !url || !published || !getRecentChinaDateKeys().has(getChinaDateKey(published))) continue;
    items.push(normalizeHotItem({
      rank: items.length + 1,
      source,
      sourceName,
      title,
      word: title,
      hot_value: sourceName,
      heat: sourceName,
      tag,
      label: tag,
      publish_time: published.toISOString(),
      dateKey: getChinaDateKey(published),
      url
    }));
    if (items.length >= limit) break;
  }
  if (!items.length) throw new Error(`${sourceName} RSS has no recent items`);
  return items;
}

function parseGenericArticleLinks(html, baseUrl, urlPattern) {
  const links = [];
  const seen = new Set();
  const anchorPattern = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = anchorPattern.exec(html))) {
    const url = toAbsoluteUrl(match[1], baseUrl);
    const title = cleanHtmlText(match[2]);
    const key = normalizeTopicKey(title);
    if (!url || !urlPattern.test(new URL(url).pathname) || !key || seen.has(key) || title.length < 4) continue;
    seen.add(key);
    links.push({ title, url });
  }
  return links;
}

function readXmlTag(block, tagName) {
  const match = block.match(new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)<\\/${tagName}>`, "i"));
  if (!match) return "";
  return match[1].replace(/^<!\[CDATA\[/, "").replace(/\]\]>$/, "").trim();
}

function parsePublishDate(value) {
  if (!value) return null;
  const time = Date.parse(decodeHtmlEntities(value));
  return Number.isFinite(time) ? new Date(time) : null;
}

function normalizeHotItem(item) {
  const tag = item.tag ?? item.label ?? "";
  const hotValue = item.hot_value ?? item.heat ?? "";
  return {
    ...item,
    title: String(item.title || "").trim(),
    word: String(item.word || item.title || "").trim(),
    hot_value: hotValue,
    publish_time: item.publish_time || dateKeyToIso(item.dateKey) || new Date().toISOString(),
    tag,
    heat: item.heat ?? String(hotValue || ""),
    label: item.label ?? tag,
    is_new: Boolean(item.is_new ?? item.isNew),
    isNew: Boolean(item.isNew ?? item.is_new)
  };
}

function normalizeToutiaoLabel(label) {
  if (label === "hot") return "\u70ed";
  if (label === "new") return "\u65b0";
  return label ? String(label) : "\u70ed\u699c";
}

function dateKeyToIso(dateKey) {
  if (!/^\d{8}$/.test(String(dateKey || ""))) return "";
  return `${dateKey.slice(0, 4)}-${dateKey.slice(4, 6)}-${dateKey.slice(6, 8)}T00:00:00+08:00`;
}

function normalizeView(view) {
  return view === "all" ? "all" : "filtered";
}

function normalizeSourceFilter(source) {
  return SOURCE_IDS.includes(source) ? source : "all";
}

function groupCachedItemsBySource(items) {
  const grouped = new Map();
  for (const item of items) {
    const source = item?.source || "weibo";
    const current = grouped.get(source) ?? [];
    current.push(item);
    grouped.set(source, current);
  }
  return grouped;
}

function dedupeAcrossSources(items) {
  const seen = new Set();
  const deduped = [];
  for (const item of items) {
    const key = normalizeTopicKey(item.title || item.word);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    deduped.push(item);
  }
  return deduped.map((item, index) => ({ ...item, rank: index + 1 }));
}

function normalizeTopicKey(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^\p{Script=Han}a-z0-9]/gu, "")
    .slice(0, 40);
}

function countSources(items) {
  return items.reduce(
    (counts, item) => {
      const source = item?.source || "weibo";
      counts[source] = (counts[source] || 0) + 1;
      counts.all += 1;
      return counts;
    },
    Object.fromEntries([["all", 0], ...SOURCE_IDS.map((source) => [source, 0])])
  );
}

function containsAny(text, keywords) {
  return keywords.some((keyword) => text.includes(keyword));
}

function evaluateOpinionItem(item) {
  const title = String(item?.title || item?.word || "");
  const text = `${title} ${item?.tag || ""} ${item?.label || ""} ${item?.sourceName || ""}`.toLowerCase();
  if (!title.trim()) return { keep: false, reason: "\u6570\u636e\u5f02\u5e38", score: 0, category: "\u5176\u4ed6" };
  if (containsAny(text, OPINION_RULES.entertainmentKeywords)) {
    return { keep: false, reason: "\u5a31\u4e50\u660e\u661f\u5185\u5bb9", score: 0, category: "\u5176\u4ed6" };
  }
  if (containsAny(text, OPINION_RULES.foreignKeywords) && !containsAny(text, OPINION_RULES.domesticImpactKeywords) && !containsAny(text, OPINION_RULES.opinionKeywords)) {
    return { keep: false, reason: "\u7eaf\u56fd\u5916\u4e8b\u4ef6", score: 0, category: "\u5176\u4ed6" };
  }

  const category = classifyOpinion(text);
  const keywordHit = containsAny(text, OPINION_RULES.opinionKeywords);
  const score = scoreOpinionItem(item, category, 1, 0);
  if (!keywordHit && score < OPINION_RULES.minScore) {
    return { keep: false, reason: "\u4f4e\u8206\u60c5\u4ef7\u503c", score, category };
  }
  return { keep: score >= OPINION_RULES.minScore, reason: score >= OPINION_RULES.minScore ? "" : "\u4f4e\u8206\u60c5\u4ef7\u503c", score, category };
}

function classifyOpinion(text) {
  for (const category of OPINION_RULES.categories) {
    if (containsAny(text, category.keywords)) return category.name;
  }
  return "\u5176\u4ed6";
}

function scoreOpinionItem(item, category, platformCount = 1, durationHours = 0) {
  const rules = OPINION_RULES.scoring;
  let score = rules.base;
  const rank = Number(item.current_rank || item.rank || 999);
  const rankRule = rules.rank.find((rule) => rank <= rule.max);
  if (rankRule) score += rankRule.points;
  const heat = numericHeat(item.hot_value ?? item.heat);
  const heatRule = rules.heat.find((rule) => heat >= rule.min);
  if (heatRule) score += heatRule.points;
  if (category && category !== "\u5176\u4ed6") score += rules.categoryBonus;
  if (OPINION_RULES.highConcernCategories.includes(category)) score += rules.highConcernBonus;
  if (platformCount > 1) score += rules.multiPlatformBonus + Math.min(8, (platformCount - 2) * 3);
  score += Math.min(rules.maxDurationBonus, Math.floor(durationHours) * rules.durationHourBonus);
  return Math.max(0, Math.min(100, Math.round(score)));
}

function mergeOpinionRecord(existing, item, evaluation, eventKey, now) {
  const source = item.source || "weibo";
  const sourceKey = `${source}:${normalizeTopicKey(item.title || item.word)}`;
  const hot = numericHeat(item.hot_value ?? item.heat);
  const rank = Number(item.rank || item.current_rank || 999);
  const firstSeen = existing?.first_seen || now.toISOString();
  const sources = { ...(existing?.sources || {}) };
  sources[source] = {
    source,
    sourceName: item.sourceName || source,
    url: item.url || "#",
    current_rank: rank,
    current_hot_value: item.hot_value ?? item.heat ?? "",
    last_seen: now.toISOString(),
    is_currently_hot: true,
    status: "\u5f53\u524d\u5728\u699c"
  };
  const platforms = Object.keys(sources);
  const durationHours = (now - new Date(firstSeen)) / (60 * 60 * 1000);
  const bestRank = Math.min(existing?.best_rank ?? rank, rank);
  const peakHot = Math.max(numericHeat(existing?.peak_hot_value), hot);
  const score = scoreOpinionItem(item, evaluation.category, platforms.length, durationHours);
  return {
    event_key: eventKey,
    title: chooseOpinionTitle(existing?.title, item.title),
    source,
    url: item.url || existing?.url || "#",
    category: existing?.category && existing.category !== "\u5176\u4ed6" ? existing.category : evaluation.category,
    hot_value: item.hot_value ?? item.heat ?? "",
    peak_hot_value: peakHot,
    current_rank: rank,
    best_rank: bestRank,
    first_seen: firstSeen,
    last_seen: now.toISOString(),
    last_hot_seen: now.toISOString(),
    is_currently_hot: true,
    status: "\u5f53\u524d\u5728\u699c",
    date: item.dateKey || getChinaDateKey(now),
    score,
    score_level: scoreLevel(score),
    platform_count: platforms.length,
    platforms,
    source_keys: [...new Set([...(existing?.source_keys || []), sourceKey])],
    multi_platform: platforms.length > 1,
    sources
  };
}

function finalizeOpinionRecord(record, now) {
  const platforms = Object.keys(record.sources || {});
  const durationHours = (new Date(record.last_seen || now) - new Date(record.first_seen || now)) / (60 * 60 * 1000);
  const score = Math.max(record.score || 0, scoreOpinionItem(record, record.category, platforms.length, durationHours));
  return {
    ...record,
    platform_count: platforms.length,
    platforms,
    multi_platform: platforms.length > 1,
    score,
    score_level: scoreLevel(score)
  };
}

function findOpinionEventKey(item, records) {
  const sourceKey = `${item.source || "weibo"}:${normalizeTopicKey(item.title || item.word)}`;
  for (const [key, record] of records.entries()) {
    if (record.source_keys?.includes(sourceKey)) return key;
    if (similarOpinionKey(item.title, record.title)) return key;
  }
  const eventKey = normalizeEventKey(item.title || item.word);
  const record = records.get(eventKey);
  if (record) return eventKey;
  return eventKey || sourceKey;
}

function normalizeEventKey(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^\p{Script=Han}a-z0-9]/gu, "")
    .replace(/(回应|通报|最新|官方|警方|网友|女子|男子|一|二|三|多名|多人)/gu, "")
    .slice(0, 28);
}

function similarOpinionKey(a, b) {
  const left = normalizeEventKey(a);
  const right = normalizeEventKey(b);
  if (!left || !right) return false;
  if (left.includes(right) || right.includes(left)) return Math.min(left.length, right.length) >= 8;
  const common = [...new Set([...left])].filter((char) => right.includes(char)).length;
  return common / Math.max(left.length, right.length) >= 0.72;
}

function chooseOpinionTitle(current, next) {
  if (!current) return next;
  if (!next) return current;
  return next.length > current.length && next.length <= 36 ? next : current;
}

function markSourcesDropped(sources) {
  return Object.fromEntries(Object.entries(sources).map(([key, value]) => [key, {
    ...value,
    is_currently_hot: false,
    status: "\u5df2\u4e0b\u699c"
  }]));
}

function scoreLevel(score) {
  return OPINION_RULES.scoreLevels.find((level) => score >= level.min)?.label || "\u4f4e\u8206\u60c5\u4ef7\u503c";
}

function numericHeat(value) {
  if (typeof value === "number") return value;
  const text = String(value || "");
  const number = Number(text.replace(/[^\d.]/g, ""));
  if (!Number.isFinite(number)) return 0;
  if (text.includes("\u4ebf")) return number * 100000000;
  if (text.includes("\u4e07")) return number * 10000;
  return number;
}

function sortOpinionItems(items, sort) {
  const sorters = {
    score: (a, b) => b.score - a.score,
    current_heat: (a, b) => numericHeat(b.hot_value) - numericHeat(a.hot_value),
    peak_heat: (a, b) => numericHeat(b.peak_hot_value) - numericHeat(a.peak_hot_value),
    first_seen: (a, b) => new Date(b.first_seen) - new Date(a.first_seen),
    last_seen: (a, b) => new Date(b.last_seen) - new Date(a.last_seen),
    duration: (a, b) => (new Date(b.last_seen) - new Date(b.first_seen)) - (new Date(a.last_seen) - new Date(a.first_seen))
  };
  return [...items].sort(sorters[sort] || sorters.score);
}

function normalizeOpinionFilter(value, allowed) {
  if (!value || value === "all") return "";
  if (allowed && !allowed.includes(value)) return "";
  return value;
}

const STRONG_PUBLIC_OPINION_KEYWORDS = [
  "\u8f9f\u8c23",
  "\u901a\u62a5",
  "\u5904\u7f5a",
  "\u7acb\u6848",
  "\u5224\u5211",
  "\u6b7b\u4ea1",
  "\u6551\u63f4",
  "\u6551\u707e",
  "\u66b4\u96e8",
  "\u6d2a\u6c34",
  "\u53f0\u98ce",
  "\u5730\u9707",
  "\u706b\u707e",
  "\u4e8b\u6545",
  "\u8bc8\u9a97",
  "\u9020\u8c23",
  "\u7ef4\u6743",
  "\u4e3e\u62a5",
  "\u8c03\u67e5",
  "\u56de\u5e94",
  "\u8b66\u65b9",
  "\u516c\u5b89",
  "\u6cd5\u9662",
  "\u68c0\u5bdf",
  "\u76d1\u7ba1",
  "\u6574\u6cbb",
  "\u4e13\u9879\u884c\u52a8",
  "\u516c\u5171\u5b89\u5168",
  "\u98df\u54c1\u5b89\u5168",
  "\u6821\u56ed",
  "\u533b\u9662",
  "\u533b\u4fdd",
  "\u9ad8\u8003",
  "\u4e2d\u8003",
  "\u4e49\u52a1\u6559\u80b2",
  "\u623f\u79df",
  "\u6b20\u85aa",
  "\u5c31\u4e1a",
  "\u6d88\u8d39\u8005",
  "\u4fb5\u6743"
];

const PUBLIC_OPINION_KEYWORDS = [
  "\u4e2d\u56fd",
  "\u5168\u56fd",
  "\u56fd\u5185",
  "\u5b98\u65b9",
  "\u653f\u5e9c",
  "\u56fd\u52a1\u9662",
  "\u90e8\u95e8",
  "\u653f\u7b56",
  "\u89c4\u5212",
  "\u6cd5\u89c4",
  "\u6761\u4f8b",
  "\u6c11\u751f",
  "\u793e\u4f1a",
  "\u5e02\u6c11",
  "\u5c45\u6c11",
  "\u7fa4\u4f17",
  "\u7f51\u53cb",
  "\u8001\u4eba",
  "\u513f\u7ae5",
  "\u672a\u6210\u5e74\u4eba",
  "\u5b66\u751f",
  "\u8001\u5e08",
  "\u5b66\u6821",
  "\u6559\u80b2",
  "\u533b\u7597",
  "\u533b\u751f",
  "\u62a4\u58eb",
  "\u60a3\u8005",
  "\u836f",
  "\u793e\u4fdd",
  "\u517b\u8001",
  "\u4f4f\u623f",
  "\u623f\u4ef7",
  "\u7269\u4e1a",
  "\u4ea4\u901a",
  "\u5730\u94c1",
  "\u516c\u4ea4",
  "\u94c1\u8def",
  "\u822a\u73ed",
  "\u9ad8\u901f",
  "\u5929\u6c14",
  "\u964d\u96e8",
  "\u9ad8\u6e29",
  "\u4f4e\u6e29",
  "\u707e\u5bb3",
  "\u5e94\u6025",
  "\u9632\u6c5b",
  "\u6297\u65f1",
  "\u6551\u707e\u7269\u8d44",
  "\u5e94\u6025\u54cd\u5e94",
  "\u5b89\u5168",
  "\u5211\u4e8b",
  "\u6848\u4ef6",
  "\u5acc\u7591\u4eba",
  "\u8fdd\u6cd5",
  "\u72af\u7f6a",
  "\u5e02\u573a",
  "\u6d88\u8d39",
  "\u4ef7\u683c",
  "\u6536\u8d39",
  "\u6587\u7269",
  "\u535a\u7269\u9986",
  "\u73af\u4fdd",
  "\u6c61\u67d3",
  "\u52b3\u52a8",
  "\u804c\u573a",
  "\u4f01\u4e1a",
  "\u5e73\u53f0",
  "\u7f51\u7edc\u5e73\u53f0",
  "\u4e13\u9879\u6574\u6cbb",
  "AI\u5e94\u7528"
];

const DOMESTIC_CONTEXT_KEYWORDS = [
  "\u4e2d\u56fd",
  "\u6211\u56fd",
  "\u56fd\u5185",
  "\u5e7f\u897f",
  "\u5317\u4eac",
  "\u4e0a\u6d77",
  "\u5e7f\u4e1c",
  "\u6df1\u5733",
  "\u5e7f\u5dde",
  "\u6d59\u6c5f",
  "\u6c5f\u82cf",
  "\u5c71\u4e1c",
  "\u6cb3\u5357",
  "\u6cb3\u5317",
  "\u56db\u5ddd",
  "\u91cd\u5e86",
  "\u6e56\u5357",
  "\u6e56\u5317",
  "\u798f\u5efa",
  "\u6c5f\u897f",
  "\u5b89\u5fbd",
  "\u5c71\u897f",
  "\u9655\u897f",
  "\u8fbd\u5b81",
  "\u5409\u6797",
  "\u9ed1\u9f99\u6c5f",
  "\u4e91\u5357",
  "\u8d35\u5dde",
  "\u7518\u8083",
  "\u9752\u6d77",
  "\u6d77\u5357",
  "\u5185\u8499\u53e4",
  "\u65b0\u7586",
  "\u897f\u85cf",
  "\u5b81\u590f",
  "\u9999\u6e2f",
  "\u6fb3\u95e8",
  "\u53f0\u6e7e"
];

const FOREIGN_KEYWORDS = [
  "\u7f8e\u56fd",
  "\u65e5\u672c",
  "\u97e9\u56fd",
  "\u5370\u5ea6",
  "\u82f1\u56fd",
  "\u6cd5\u56fd",
  "\u5fb7\u56fd",
  "\u4fc4\u7f57\u65af",
  "\u4e4c\u514b\u5170",
  "\u4ee5\u8272\u5217",
  "\u4f0a\u6717",
  "\u6b27\u6d32",
  "\u6d77\u5916",
  "\u56fd\u5916",
  "\u5916\u5a92",
  "FIFA",
  "\u6b27\u8db3\u8054",
  "\u4e16\u754c\u676f"
];

const EXCLUDE_KEYWORDS = [
  "\u660e\u661f",
  "\u6f14\u5531\u4f1a",
  "\u65b0\u6b4c",
  "\u4ee3\u8a00",
  "\u63a2\u73ed",
  "\u6bd4\u57fa\u5c3c",
  "\u624b\u673a\u58f3",
  "\u5e94\u63f4",
  "\u7c89\u4e1d",
  "\u996d\u5708",
  "\u7efc\u827a",
  "\u7535\u5f71",
  "\u7535\u89c6\u5267",
  "\u77ed\u5267",
  "\u7968\u623f",
  "\u523a\u7ee3",
  "part",
  "\u795e\u56fe",
  "\u8db3\u7403\u660e\u661f",
  "\u7ea2\u724c",
  "\u6218\u80dc",
  "\u6bd4\u8d5b",
  "\u7535\u7ade",
  "\u6e38\u620f",
  "Dior",
  "LV"
];

async function retry(fn, attempts, delayMs) {
  let lastError;
  for (let index = 0; index < attempts; index += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (index < attempts - 1) await sleep(delayMs * (index + 1));
    }
  }
  throw lastError;
}

async function readCache() {
  const response = await caches.default.match(CACHE_KEY);
  if (!response) return null;
  try {
    return await response.json();
  } catch {
    return null;
  }
}

async function writeCache(payload) {
  await caches.default.put(
    CACHE_KEY,
    new Response(JSON.stringify(payload), {
      headers: {
        "content-type": "application/json;charset=utf-8",
        "cache-control": `public, max-age=${CACHE_TTL_SECONDS}`
      }
    })
  );
}

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json;charset=utf-8",
      "cache-control": "no-store",
      "access-control-allow-origin": "*"
    }
  });
}

export function formatHeat(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return "\u6682\u65e0";
  if (number >= 100000000) return `${trim(number / 100000000)}\u4ebf`;
  if (number >= 10000) return `${trim(number / 10000)}\u4e07`;
  return String(Math.round(number));
}

function trim(value) {
  return value.toFixed(value >= 100 ? 1 : 2).replace(/\.0+$/, "").replace(/(\.\d)0$/, "$1");
}

function normalizeLabel(label) {
  const text = String(label || "").trim();
  if (!text || text === "undefined" || text === "null") return "\u70ed";
  return text.length > 4 ? text.slice(0, 4) : text;
}

function formatDate(timestamp) {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).format(timestamp);
}

function getRecentChinaDateKeys(now = new Date()) {
  const oneDay = 24 * 60 * 60 * 1000;
  return new Set([
    getChinaDateKey(now),
    getChinaDateKey(new Date(now.getTime() - oneDay))
  ]);
}

function getChinaDateKey(date) {
  const chinaTime = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  return chinaTime.toISOString().slice(0, 10).replaceAll("-", "");
}

function readableError(error) {
  return error instanceof Error ? error.message : "\u672a\u77e5\u9519\u8bef";
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function renderPage() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
  <meta name="theme-color" content="#f7f8fb">
  <title>微博实时热点</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f7f8fb;
      --panel: #ffffff;
      --text: #151822;
      --muted: #697083;
      --line: #e7eaf1;
      --red: #e5484d;
      --amber: #f59f00;
      --blue: #2563eb;
      --green: #0f9f6e;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
    }

    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--text);
      min-height: 100vh;
      font-size: 16px;
    }

    .shell {
      width: min(100%, 760px);
      margin: 0 auto;
      padding: calc(env(safe-area-inset-top) + 18px) 14px calc(env(safe-area-inset-bottom) + 22px);
    }

    header {
      display: flex;
      align-items: flex-end;
      justify-content: space-between;
      gap: 12px;
      padding: 8px 2px 14px;
    }

    h1 {
      margin: 0;
      font-size: clamp(26px, 8vw, 36px);
      line-height: 1.05;
      letter-spacing: 0;
    }

    .meta {
      display: flex;
      flex-direction: column;
      align-items: flex-end;
      gap: 6px;
      min-width: 116px;
      color: var(--muted);
      font-size: 12px;
      line-height: 1.2;
      text-align: right;
    }

    .status {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      color: var(--green);
      font-weight: 700;
      white-space: nowrap;
    }

    .dot {
      width: 7px;
      height: 7px;
      border-radius: 99px;
      background: currentColor;
    }

    .toolbar {
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 10px;
      align-items: center;
      margin: 4px 0 12px;
    }

    .modebar {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 8px;
      margin: 0 0 10px;
    }

    .sourcebar {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 8px;
      margin: 0 0 10px;
    }

    .mode, .source {
      min-height: 38px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #fff;
      color: var(--muted);
      text-decoration: none;
      font-size: 14px;
      font-weight: 800;
      white-space: nowrap;
    }

    .source {
      min-height: 36px;
      font-size: 13px;
      padding: 0 4px;
    }

    .mode.active, .source.active {
      border-color: var(--text);
      background: var(--text);
      color: #fff;
    }

    .search {
      width: 100%;
      min-height: 44px;
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 0 13px;
      font-size: 15px;
      background: #fff;
      color: var(--text);
      outline: none;
    }

    button {
      min-width: 46px;
      min-height: 44px;
      border: 0;
      border-radius: 8px;
      background: var(--text);
      color: #fff;
      font-size: 18px;
      font-weight: 800;
    }

    .list {
      display: grid;
      gap: 8px;
    }

    .item {
      display: grid;
      grid-template-columns: 42px 1fr auto;
      gap: 10px;
      align-items: center;
      min-height: 76px;
      padding: 13px 12px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--panel);
      color: inherit;
      text-decoration: none;
    }

    .rank {
      display: grid;
      place-items: center;
      width: 34px;
      height: 34px;
      border-radius: 8px;
      background: #f0f2f6;
      color: #384052;
      font-size: 15px;
      font-weight: 800;
      font-variant-numeric: tabular-nums;
    }

    .item:nth-child(1) .rank { background: var(--red); color: #fff; }
    .item:nth-child(2) .rank { background: var(--amber); color: #fff; }
    .item:nth-child(3) .rank { background: var(--blue); color: #fff; }

    .main {
      min-width: 0;
      display: grid;
      gap: 7px;
    }

    .title {
      display: flex;
      align-items: center;
      gap: 6px;
      min-width: 0;
      font-size: 16px;
      font-weight: 750;
      line-height: 1.32;
    }

    .title span:first-child {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .heat {
      color: var(--muted);
      font-size: 13px;
      font-variant-numeric: tabular-nums;
    }

    .badge, .new {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      height: 22px;
      border-radius: 6px;
      padding: 0 7px;
      font-size: 12px;
      font-weight: 800;
      white-space: nowrap;
    }

    .badge {
      background: #fff1f1;
      color: var(--red);
    }

    .new {
      background: var(--red);
      color: #fff;
    }

    .empty, .notice {
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #fff;
      color: var(--muted);
      padding: 18px 14px;
      line-height: 1.6;
    }

    .notice {
      display: none;
      margin-bottom: 10px;
      border-color: #f2d08a;
      color: #755b18;
      background: #fff8e7;
    }

    @media (min-width: 640px) {
      .shell { padding-left: 20px; padding-right: 20px; }
      .item { grid-template-columns: 50px 1fr auto; padding: 15px 16px; }
      .rank { width: 38px; height: 38px; }
      .title { font-size: 17px; }
    }
  </style>
</head>
<body>
  <main class="shell">
    <header>
      <h1>微博实时热点</h1>
      <div class="meta">
        <div class="status" id="status"><span class="dot"></span><span>更新中</span></div>
        <div id="updated">--</div>
      </div>
    </header>
    <section class="toolbar" aria-label="热点工具">
      <input class="search" id="filter" type="search" placeholder="搜索榜单" autocomplete="off">
      <button id="refresh" type="button" aria-label="刷新">↻</button>
    </section>
    <section class="modebar" aria-label="热点视图">
      <a class="mode" id="filteredMode" href="/">舆情筛选</a>
      <a class="mode" id="allMode" href="/?view=all">全部热搜</a>
    </section>
    <section class="sourcebar" aria-label="热点来源">
      <a class="source" id="sourceAll" href="/">综合</a>
      <a class="source" id="sourceWeibo" href="/?source=weibo">微博</a>
      <a class="source" id="sourceXinhua" href="/?source=xinhua">新华网</a>
      <a class="source" id="sourceRawAll" href="/?view=all&source=all">全量</a>
    </section>
    <section class="notice" id="notice"></section>
    <section class="list" id="list"></section>
  </main>

  <script>
    const API_BASE = window.HOT_API_BASE || "";
    const params = new URLSearchParams(window.location.search);
    const initialView = params.get("view") === "all" ? "all" : "filtered";
    const initialSource = ["weibo", "xinhua"].includes(params.get("source")) ? params.get("source") : "all";
    const state = { items: [], query: "", view: initialView, sourceFilter: initialSource, totalItems: 0, visibleItems: 0, sourceCounts: { all: 0, weibo: 0, xinhua: 0 } };
    const list = document.querySelector("#list");
    const updated = document.querySelector("#updated");
    const status = document.querySelector("#status");
    const notice = document.querySelector("#notice");
    const filter = document.querySelector("#filter");
    const refresh = document.querySelector("#refresh");
    const filteredMode = document.querySelector("#filteredMode");
    const allMode = document.querySelector("#allMode");
    const sourceAll = document.querySelector("#sourceAll");
    const sourceWeibo = document.querySelector("#sourceWeibo");
    const sourceXinhua = document.querySelector("#sourceXinhua");
    const sourceRawAll = document.querySelector("#sourceRawAll");

    filter.addEventListener("input", () => {
      state.query = filter.value.trim().toLowerCase();
      renderList();
    });

    refresh.addEventListener("click", () => load(true));
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) load(false);
    });

    async function load(force) {
      status.innerHTML = '<span class="dot"></span><span>更新中</span>';
      status.style.color = "var(--green)";
      try {
        const apiParams = new URLSearchParams();
        apiParams.set("view", state.view);
        apiParams.set("source", state.sourceFilter);
        if (force) apiParams.set("force", "1");
        const res = await fetch(API_BASE + "/api/hot?" + apiParams.toString(), { cache: "no-store" });
        const data = await res.json();
        state.items = Array.isArray(data.items) ? data.items : [];
        state.view = data.view === "all" ? "all" : "filtered";
        state.sourceFilter = ["weibo", "xinhua"].includes(data.sourceFilter) ? data.sourceFilter : "all";
        state.totalItems = Number(data.totalItems || state.items.length);
        state.visibleItems = Number(data.visibleItems || state.items.length);
        state.sourceCounts = data.sourceCounts || state.sourceCounts;
        updated.textContent = data.updatedAtText ? "最后更新 " + data.updatedAtText : "--";
        notice.style.display = data.error ? "block" : "none";
        notice.textContent = data.error || "";
        status.innerHTML = '<span class="dot"></span><span>' + statusText(data.source) + '</span>';
        status.style.color = data.source === "stale-cache" ? "var(--amber)" : "var(--green)";
        renderMode();
        renderList();
      } catch (error) {
        status.innerHTML = '<span class="dot"></span><span>连接失败</span>';
        status.style.color = "var(--red)";
        notice.style.display = "block";
        notice.textContent = "网络请求失败，请稍后重试。";
      }
    }

    function renderList() {
      const items = state.query
        ? state.items.filter((item) => item.title.toLowerCase().includes(state.query))
        : state.items;

      if (!items.length) {
        const message = state.view === "filtered"
          ? "当前没有匹配的舆情热点，可切换到全部热搜查看。"
          : "暂无热点数据。";
        list.innerHTML = '<div class="empty">' + message + '</div>';
        return;
      }

      list.innerHTML = items.map((item) => \`
        <a class="item" href="\${escapeAttr(item.url)}" target="_blank" rel="noopener noreferrer">
          <div class="rank">\${item.rank}</div>
          <div class="main">
            <div class="title">
              <span>\${escapeHtml(item.title)}</span>
              \${item.isNew ? '<span class="new">新</span>' : ''}
            </div>
            <div class="heat">\${escapeHtml(item.sourceName || "热点")} · 热度 \${escapeHtml(item.heat || "暂无")}</div>
          </div>
          <div class="badge">\${escapeHtml(item.label || "热")}</div>
        </a>
      \`).join("");
    }

    function renderMode() {
      filteredMode.classList.toggle("active", state.view === "filtered");
      allMode.classList.toggle("active", state.view === "all");
      const suffix = state.view === "filtered"
        ? "舆情 " + state.visibleItems + "/" + state.totalItems
        : "全部 " + state.totalItems;
      filteredMode.textContent = "舆情筛选";
      allMode.textContent = "全部热搜";
      sourceAll.classList.toggle("active", state.sourceFilter === "all" && state.view === "filtered");
      sourceWeibo.classList.toggle("active", state.sourceFilter === "weibo");
      sourceXinhua.classList.toggle("active", state.sourceFilter === "xinhua");
      sourceRawAll.classList.toggle("active", state.sourceFilter === "all" && state.view === "all");
      sourceAll.textContent = "综合";
      sourceWeibo.textContent = "微博";
      sourceXinhua.textContent = "新华网";
      sourceRawAll.textContent = "全量";
      updated.textContent = updated.textContent + " · " + suffix;
    }

    function statusText(source) {
      if (source === "live") return "实时";
      if (source === "cache") return "缓存";
      if (source === "stale-cache") return "缓存";
      return "就绪";
    }

    function escapeHtml(value) {
      return String(value).replace(/[&<>"']/g, (char) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
      }[char]));
    }

    function escapeAttr(value) {
      return escapeHtml(value).replace(new RegExp(String.fromCharCode(96), "g"), "&#96;");
    }

    load(false);
    setInterval(() => load(false), 60 * 1000);
  </script>
</body>
</html>`;
}
