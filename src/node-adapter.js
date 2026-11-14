// Bridges Node's (req, res) to the Fetch-style handler. Streams audio bodies
// instead of buffering entire FLAC files in memory.
import { Readable } from "node:stream";
import { getHandler } from "./app.js";

export async function nodeHandler(req, res) {
  try {
    const proto = req.headers["x-forwarded-proto"] || "http";
    const url = `${proto}://${req.headers.host}${req.url}`;
    const request = new Request(url, { method: req.method, headers: req.headers });
    const handle = await getHandler();
    const response = await handle(request);
    res.statusCode = response.status;
    response.headers.forEach((value, key) => res.setHeader(key, value));
    if (!response.body || req.method === "HEAD") {
      res.end();
      return;
    }
    const body = Readable.fromWeb(response.body);
    body.on("error", (err) => {
      console.error("[addon] response stream failed:", err?.message || "unknown error");
      if (!res.headersSent) res.statusCode = 502;
      res.destroy(err);
    });
    body.pipe(res);
  } catch (err) {
    console.error("[addon] fatal:", err?.message || "unknown error");
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: "Addon misconfigured" }));
    } else {
      res.destroy(err);
    }
  }
}
