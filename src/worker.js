const CACHE_KEY = "https://weibo-hot-monitor.local/cache/v1/hot";
const REFRESH_INTERVAL_MS = 5 * 60 * 1000;
const CACHE_TTL_SECONDS = 60 * 60 * 24;
const USER_AGENT =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/api/hot") {
      const force = url.searchParams.get("force") === "1";
      const payload = await getHotPayload({ force, ctx });
      return json(payload, payload.ok ? 200 : 503);
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
    const currentItems = await retry(fetchWeiboHot, 3, 650);
    const previousWords = new Set((cached?.items ?? []).map((item) => item.word));
    const seen = new Set();
    const items = currentItems
      .filter((item) => {
        const key = item.word.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .map((item) => ({
        ...item,
        isNew: cached ? !previousWords.has(item.word) : false
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
        title: String(item.note || word).trim(),
        word,
        heat: formatHeat(item.raw_hot ?? item.num ?? item.hot_num ?? item.onboard_time),
        label: normalizeLabel(item.label_name || item.category || item.icon_desc),
        url: `https://s.weibo.com/weibo?q=${encodeURIComponent(word)}&Refer=top`
      };
    });
}

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
    <section class="notice" id="notice"></section>
    <section class="list" id="list"></section>
  </main>

  <script>
    const state = { items: [], query: "" };
    const list = document.querySelector("#list");
    const updated = document.querySelector("#updated");
    const status = document.querySelector("#status");
    const notice = document.querySelector("#notice");
    const filter = document.querySelector("#filter");
    const refresh = document.querySelector("#refresh");

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
        const res = await fetch("/api/hot" + (force ? "?force=1" : ""), { cache: "no-store" });
        const data = await res.json();
        state.items = Array.isArray(data.items) ? data.items : [];
        updated.textContent = data.updatedAtText ? "最后更新 " + data.updatedAtText : "--";
        notice.style.display = data.error ? "block" : "none";
        notice.textContent = data.error || "";
        status.innerHTML = '<span class="dot"></span><span>' + statusText(data.source) + '</span>';
        status.style.color = data.source === "stale-cache" ? "var(--amber)" : "var(--green)";
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
        list.innerHTML = '<div class="empty">暂无热点数据。</div>';
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
            <div class="heat">热度 \${escapeHtml(item.heat || "暂无")}</div>
          </div>
          <div class="badge">\${escapeHtml(item.label || "热")}</div>
        </a>
      \`).join("");
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
