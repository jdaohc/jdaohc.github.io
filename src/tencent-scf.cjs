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
  const worker = await loadWorker();

  if (event.Type === "Timer" || event.type === "timer") {
    const request = new Request("https://scf.local/api/hot?force=1&source=all&view=all");
    await worker.fetch(request, {}, waitUntilContext());
    return { ok: true, refreshedAt: new Date().toISOString() };
  }

  const request = toRequest(event);
  const response = await worker.fetch(request, {}, waitUntilContext());
  return toScfResponse(response);
};

async function loadWorker() {
  try {
    return (await import("./worker.mjs")).default;
  } catch (error) {
    if (error?.code !== "ERR_MODULE_NOT_FOUND") throw error;
    return (await import("./worker.js")).default;
  }
}

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
  const query = normalizeQueryString(event);
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
    headers[toHeaderCase(key)] = value;
  });
  headers["Content-Disposition"] = "inline";

  return {
    statusCode: response.status,
    headers,
    body
  };
}

function toHeaderCase(header) {
  return header
    .split("-")
    .map((part) => part ? part[0].toUpperCase() + part.slice(1).toLowerCase() : part)
    .join("-");
}

function normalizeQueryString(event) {
  if (typeof event.rawQueryString === "string" && event.rawQueryString) return event.rawQueryString;
  if (typeof event.queryString === "string" && event.queryString) return event.queryString;
  if (event.queryString && typeof event.queryString === "object") return toQueryString(event.queryString);
  return toQueryString(event.queryStringParameters);
}

function toQueryString(params = {}) {
  return new URLSearchParams(params).toString();
}

function jsonResponse(payload) {
  return new Response(JSON.stringify(payload), {
    headers: { "content-type": "application/json;charset=utf-8" }
  });
}
