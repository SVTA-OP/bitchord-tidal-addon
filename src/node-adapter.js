// Bridges Node's (req, res) to the Fetch-style handler. Used locally and on Vercel.
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
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (err) {
    console.error("[addon] fatal:", err);
    res.statusCode = 500;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ error: "Addon misconfigured", message: String(err.message || err) }));
  }
}
