const fs = require("node:fs/promises");
const path = require("node:path");

const CACHE_FILE = path.join("/tmp", "weibo-hot-monitor-cache.json");
let memoryCache = null;

globalThis.caches = {
  default: {
    async match() {
      if (memoryCache) return jsonResponse(memoryCache);
      try {
        const text = await fs.readFile(CACHE_FILE, "utf8");
        memoryCache = JSON.parse(text);
        return jsonResponse(memoryCache);
      } catch {
        return undefined;
      }
    },
    async put(_key, response) {
      memoryCache = await response.json();
      await fs.writeFile(CACHE_FILE, JSON.stringify(memoryCache), "utf8");
    }
  }
};

exports.main_handler = async function mainHandler(event = {}, context = {}) {
  const worker = (await import("./worker.js")).default;

  if (event.Type === "Timer" || event.type === "timer") {
    const request = new Request("https://scf.local/api/hot?force=1&source=all&view=all");
    await worker.fetch(request, {}, waitUntilContext());
    return { ok: true, refreshedAt: new Date().toISOString() };
  }

  const request = toRequest(event);
  const response = await worker.fetch(request, {}, waitUntilContext());
  return toScfResponse(response);
};

function waitUntilContext() {
  return {
    waitUntil(promise) {
      promise.catch((error) => console.error(error));
    }
  };
}

function toRequest(event) {
  const method = event.httpMethod || event.requestContext?.http?.method || "GET";
  const pathName = event.path || event.rawPath || "/";
  const query = event.queryString || event.rawQueryString || toQueryString(event.queryStringParameters);
  const protocol = event.headers?.["x-forwarded-proto"] || "https";
  const host = event.headers?.host || event.headers?.Host || "scf.local";
  const url = `${protocol}://${host}${pathName}${query ? `?${query}` : ""}`;
  const headers = new Headers(event.headers || {});
  const body = event.body && !["GET", "HEAD"].includes(method)
    ? event.isBase64Encoded
      ? Buffer.from(event.body, "base64")
      : event.body
    : undefined;

  return new Request(url, { method, headers, body });
}

async function toScfResponse(response) {
  const body = await response.text();
  const headers = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });

  return {
    isBase64Encoded: false,
    statusCode: response.status,
    headers,
    body
  };
}

function toQueryString(params = {}) {
  return new URLSearchParams(params).toString();
}

function jsonResponse(payload) {
  return new Response(JSON.stringify(payload), {
    headers: { "content-type": "application/json;charset=utf-8" }
  });
}
