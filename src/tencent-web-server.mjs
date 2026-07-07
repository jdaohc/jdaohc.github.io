import http from "node:http";
import worker from "./worker.mjs";

const port = Number(process.env.PORT || 9000);

http
  .createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);

      const host = req.headers.host || "localhost";
      const protocol = req.headers["x-forwarded-proto"] || "https";
      const url = `${protocol}://${host}${req.url || "/"}`;
      const method = req.method || "GET";
      const body = ["GET", "HEAD"].includes(method) ? undefined : Buffer.concat(chunks);
      const request = new Request(url, { method, headers: req.headers, body });
      const response = await worker.fetch(request, {}, waitUntilContext());

      res.statusCode = response.status;
      response.headers.forEach((value, key) => res.setHeader(key, value));
      res.removeHeader("content-disposition");
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch (error) {
      console.error(error);
      res.statusCode = 500;
      res.setHeader("content-type", "application/json;charset=utf-8");
      res.end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : "unknown error" }));
    }
  })
  .listen(port, "0.0.0.0", () => {
    console.log(`weibo hot monitor web server listening on ${port}`);
  });

function waitUntilContext() {
  return {
    waitUntil(promise) {
      promise.catch((error) => console.error(error));
    }
  };
}
