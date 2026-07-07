const CACHE_KEY = "https://weibo-hot-monitor.local/cache/v1/hot";
const REFRESH_INTERVAL_MS = 5 * 60 * 1000;
const CACHE_TTL_SECONDS = 60 * 60 * 24;
const XINHUA_SECTIONS = [
  "https://www.news.cn/",
  "https://www.news.cn/politics/",
  "https://www.news.cn/legal/"
];
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
    const currentItems = await fetchAllHotSources(cached);
    const previousWords = new Set((cached?.items ?? []).map((item) => `${item.source || "weibo"}:${item.word}`));
    const seen = new Set();
    const items = currentItems
      .filter((item) => {
        const key = `${item.source || "weibo"}:${item.word}`.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .map((item) => ({
        ...item,
        isNew: cached ? !previousWords.has(`${item.source || "weibo"}:${item.word}`) : false
      }));

    const payload = {
      ok: true,
      source: "live",
      updatedAt: Date.now(),
      updatedAtText: formatDate(Date.now()),
      items,
      error: null
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
        error: "微博接口暂时不可用，正在展示最近一次成功缓存。"
      };
    }

    return {
      ok: false,
      source: "empty",
      updatedAt: Date.now(),
      updatedAtText: formatDate(Date.now()),
      items: [],
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
  const sourceItems = normalizedSource === "all"
    ? allItems
    : allItems.filter((item) => (item.source || "weibo") === normalizedSource);
  const items = normalizedView === "all" ? sourceItems : filterPublicOpinionItems(sourceItems);

  return {
    ...payload,
    view: normalizedView,
    sourceFilter: normalizedSource,
    sourceCounts: countSources(allItems),
    totalItems: sourceItems.length,
    visibleItems: items.length,
    items
  };
}

export function filterPublicOpinionItems(items) {
  return items.filter(isPublicOpinionItem);
}

export function isPublicOpinionItem(item) {
  const text = `${item?.title ?? ""} ${item?.word ?? ""} ${item?.label ?? ""} ${item?.sourceName ?? ""}`.toLowerCase();
  if (!text.trim()) return false;

  if (containsAny(text, STRONG_PUBLIC_OPINION_KEYWORDS)) return true;
  if (containsAny(text, EXCLUDE_KEYWORDS)) return false;
  if (containsAny(text, FOREIGN_KEYWORDS) && !containsAny(text, DOMESTIC_CONTEXT_KEYWORDS)) return false;

  return containsAny(text, PUBLIC_OPINION_KEYWORDS);
}

export async function fetchAllHotSources(cached) {
  const previousBySource = groupCachedItemsBySource(cached?.items ?? []);
  const [weibo, xinhua] = await Promise.all([
    fetchSourceWithFallback("weibo", fetchWeiboHot, previousBySource),
    fetchSourceWithFallback("xinhua", fetchXinhuaHot, previousBySource)
  ]);

  if (!weibo.ok && !xinhua.ok) throw new Error("All hot sources failed");
  const items = dedupeAcrossSources([...weibo.items, ...xinhua.items]);
  if (!items.length) throw new Error("All hot sources failed");
  return items;
}

async function fetchSourceWithFallback(source, fetcher, previousBySource) {
  try {
    return { source, ok: true, items: await retry(fetcher, 3, 650), error: null };
  } catch (error) {
    return {
      source,
      ok: false,
      items: previousBySource.get(source) ?? [],
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

  return rawItems
    .filter((item) => item?.word || item?.note)
    .slice(0, 50)
    .map((item, index) => {
      const word = String(item.word || item.note || "").trim();
      return {
        rank: index + 1,
        source: "weibo",
        sourceName: "微博",
        title: String(item.note || word).trim(),
        word,
        heat: formatHeat(item.raw_hot ?? item.num ?? item.hot_num ?? item.onboard_time),
        label: normalizeLabel(item.label_name || item.category || item.icon_desc),
        url: `https://s.weibo.com/weibo?q=${encodeURIComponent(word)}&Refer=top`
      };
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
      items.push({
        rank: items.length + 1,
        source: "xinhua",
        sourceName: "新华网/新华社",
        title: link.title,
        word: link.title,
        heat: "新华网",
        label: "新华",
        url: link.url
      });
      if (items.length >= 50) return items;
    }
  }

  if (!items.length) throw new Error("No Xinhua links found");
  return items;
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
    links.push({ title, url });
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

function isUsefulXinhuaTitle(title) {
  if (title.length < 6 || title.length > 80) return false;
  if (/^(新华网|新华社|首页|更多|视频|图片|客户端|English)$/i.test(title)) return false;
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

function normalizeView(view) {
  return view === "all" ? "all" : "filtered";
}

function normalizeSourceFilter(source) {
  return source === "weibo" || source === "xinhua" ? source : "all";
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
      if (item?.source === "weibo") counts.weibo += 1;
      if (item?.source === "xinhua") counts.xinhua += 1;
      counts.all += 1;
      return counts;
    },
    { all: 0, weibo: 0, xinhua: 0 }
  );
}

function containsAny(text, keywords) {
  return keywords.some((keyword) => text.includes(keyword));
}

const STRONG_PUBLIC_OPINION_KEYWORDS = [
  "辟谣",
  "通报",
  "处罚",
  "立案",
  "判刑",
  "死刑",
  "救援",
  "救灾",
  "暴雨",
  "洪水",
  "台风",
  "地震",
  "火灾",
  "事故",
  "诈骗",
  "造谣",
  "维权",
  "举报",
  "调查",
  "回应",
  "警方",
  "公安",
  "法院",
  "检察",
  "监管",
  "整治",
  "专项行动",
  "公共安全",
  "食品安全",
  "校园",
  "医院",
  "医保",
  "高考",
  "中考",
  "义务教育",
  "房租",
  "欠薪",
  "就业",
  "消费者",
  "侵权"
];

const PUBLIC_OPINION_KEYWORDS = [
  "中国",
  "全国",
  "国内",
  "官方",
  "政府",
  "国务院",
  "部门",
  "政策",
  "规划",
  "法规",
  "条例",
  "民生",
  "社会",
  "市民",
  "居民",
  "群众",
  "网友",
  "老人",
  "儿童",
  "未成年人",
  "学生",
  "老师",
  "学校",
  "教育",
  "医疗",
  "医生",
  "护士",
  "患者",
  "药",
  "社保",
  "养老",
  "住房",
  "房价",
  "物业",
  "交通",
  "地铁",
  "公交",
  "铁路",
  "航班",
  "高速",
  "天气",
  "降雨",
  "高温",
  "低温",
  "灾害",
  "应急",
  "防汛",
  "抗旱",
  "救灾物资",
  "应急响应",
  "安全",
  "刑事",
  "案件",
  "嫌疑人",
  "违法",
  "犯罪",
  "市场",
  "消费",
  "价格",
  "收费",
  "文物",
  "博物馆",
  "环保",
  "污染",
  "劳动",
  "职场",
  "企业",
  "平台",
  "网络平台",
  "专项整治",
  "ai应用"
];

const DOMESTIC_CONTEXT_KEYWORDS = [
  "中国",
  "我国",
  "国内",
  "广西",
  "北京",
  "上海",
  "广东",
  "深圳",
  "广州",
  "浙江",
  "江苏",
  "山东",
  "河南",
  "河北",
  "四川",
  "重庆",
  "湖南",
  "湖北",
  "福建",
  "江西",
  "安徽",
  "山西",
  "陕西",
  "辽宁",
  "吉林",
  "黑龙江",
  "云南",
  "贵州",
  "甘肃",
  "青海",
  "海南",
  "内蒙古",
  "新疆",
  "西藏",
  "宁夏",
  "香港",
  "澳门",
  "台湾"
];

const FOREIGN_KEYWORDS = [
  "美国",
  "日本",
  "韩国",
  "印度",
  "英国",
  "法国",
  "德国",
  "俄罗斯",
  "乌克兰",
  "以色列",
  "伊朗",
  "欧洲",
  "海外",
  "国外",
  "外媒",
  "fifa",
  "欧足联",
  "世界杯"
];

const EXCLUDE_KEYWORDS = [
  "演唱会",
  "新歌",
  "代言",
  "探班",
  "比基尼",
  "手机壳",
  "应援",
  "粉丝",
  "饭圈",
  "综艺",
  "电影",
  "电视剧",
  "短剧",
  "票房",
  "刺棠",
  "part",
  "神图",
  "足球明星",
  "红牌",
  "战胜",
  "比赛",
  "电竞",
  "游戏",
  "dior",
  "lv"
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
  if (!Number.isFinite(number) || number <= 0) return "暂无";
  if (number >= 100000000) return `${trim(number / 100000000)}亿`;
  if (number >= 10000) return `${trim(number / 10000)}万`;
  return String(Math.round(number));
}

function trim(value) {
  return value.toFixed(value >= 100 ? 1 : 2).replace(/\.0+$/, "").replace(/(\.\d)0$/, "$1");
}

function normalizeLabel(label) {
  const text = String(label || "").trim();
  if (!text || text === "undefined" || text === "null") return "热";
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

function readableError(error) {
  return error instanceof Error ? error.message : "未知错误";
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
