// Framework-neutral BitChord addon: Fetch Request in, Response out.
// Routes are mounted below a private unguessable path prefix.

import crypto from "node:crypto";

export class NotImplementedError extends Error {
  constructor(message = "Not implemented") {
    super(message);
    this.name = "NotImplementedError";
  }
}

const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...headers,
    },
  });

export function buildManifest(provider, { id, name, version, auth }) {
  const manifest = {
    id,
    name,
    version,
    resources: ["search", "stream"],
    allowDownloads: 1,
  };
  if (auth) manifest.bitchordAuth = true;
  if (provider.qualityOptions?.length) {
    manifest.settings = [{
      key: "quality",
      type: "select",
      label: "Audio quality",
      default: provider.qualityOptions[0].value,
      options: provider.qualityOptions,
    }];
  }
  return manifest;
}

function readContext(url, provider) {
  const fallback = provider.qualityOptions?.[0]?.value ?? "LOSSLESS";
  return {
    quality: url.searchParams.get("quality") || fallback,
    atmos: url.searchParams.get("atmos") === "auto",
  };
}

function validTrack(track) {
  return track && String(track.id || "").length > 0 && String(track.title || "").length > 0;
}

function isAbsoluteHttps(value) {
  try { return new URL(value).protocol === "https:"; } catch { return false; }
}

export function normalizeStream(info) {
  if (!info || !isAbsoluteHttps(info.url)) return null;
  if (info.encrypted) return null;
  const out = { url: info.url, encrypted: false };
  for (const key of [
    "format", "quality", "codec", "container", "manifest",
    "sampleRate", "bitDepth", "bitrate", "audioMode",
  ]) {
    if (info[key] !== undefined && info[key] !== null) out[key] = info[key];
  }
  return out;
}

function timingSafeStringEqual(a, b) {
  const left = Buffer.from(String(a || ""));
  const right = Buffer.from(String(b || ""));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function verifyBasicAuth(request, username, password) {
  const header = request.headers.get("authorization") || "";
  const match = header.match(/^Basic\s+([A-Za-z0-9+/=]+)$/i);
  if (!match) return false;
  let decoded;
  try { decoded = Buffer.from(match[1], "base64").toString("utf8"); } catch { return false; }
  const colon = decoded.indexOf(":");
  if (colon < 0) return false;
  const suppliedUser = decoded.slice(0, colon);
  const suppliedPassword = decoded.slice(colon + 1);
  return timingSafeStringEqual(suppliedUser, username) && timingSafeStringEqual(suppliedPassword, password);
}

function basicAuthFailure() {
  return new Response("Authentication required", {
    status: 401,
    headers: {
      "WWW-Authenticate": 'Basic realm="Personal BitChord addon", charset="UTF-8"',
      "Cache-Control": "no-store",
    },
  });
}

function createMediaSignature(jobId, expires, secret) {
  return crypto.createHmac("sha256", secret).update(`${jobId}.${expires}`).digest("base64url");
}

function verifyMediaSignature(jobId, expires, signature, secret) {
  const exp = Number(expires);
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isSafeInteger(exp) || exp < now || exp > now + 24 * 60 * 60) return false;
  return timingSafeStringEqual(createMediaSignature(jobId, exp, secret), signature);
}

function getMediaUrl({ jobId, request, prefix, secret, ttlSeconds }) {
  const expires = Math.floor(Date.now() / 1000) + Math.max(300, Math.min(24 * 60 * 60, ttlSeconds));
  const signature = createMediaSignature(jobId, expires, secret);
  const url = new URL(`${prefix}/media/${encodeURIComponent(jobId)}`, request.url);
  url.searchParams.set("exp", String(expires));
  url.searchParams.set("sig", signature);
  return url.toString();
}

function dashboardHtml(prefix) {
  const statusPath = `${prefix}/admin/status`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Personal BitChord TIDAL</title>
<style>
:root{color-scheme:dark;font:16px system-ui,sans-serif;background:#101318;color:#eef2f7}body{max-width:720px;margin:40px auto;padding:0 18px}h1{font-size:1.45rem}.card{background:#1a2029;border:1px solid #303a48;border-radius:14px;padding:18px;margin:14px 0}.muted{color:#a8b3c2}.ok{color:#72d49a}.warn{color:#ffca70}pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:.9rem}button{background:#2e77df;color:white;border:0;border-radius:8px;padding:9px 13px;cursor:pointer}
</style></head><body>
<h1>Personal BitChord TIDAL</h1>
<p class="muted">Private status page. It does not ask for or store your TIDAL password.</p>
<div class="card"><strong>Playback backend</strong><p id="state" class="muted">Checking…</p><button id="refresh">Refresh status</button></div>
<div class="card"><strong>Latest playback job</strong><pre id="job" class="muted">No jobs yet.</pre></div>
<div class="card"><strong>How verification works</strong><p class="muted">Mornye-Python handles Zarz signed requests and its supported Turnstile/browser challenge flow. This page reports backend status; it is not a CAPTCHA page. If automatic verification fails, the latest error appears above.</p></div>
<script>
const state=document.getElementById('state'),job=document.getElementById('job');
async function refresh(){state.textContent='Checking…';try{const r=await fetch(${JSON.stringify(statusPath)},{cache:'no-store'});if(!r.ok)throw new Error('HTTP '+r.status);const d=await r.json();state.innerHTML=d.ok?'<span class="ok">Bridge is responding</span>':'<span class="warn">Bridge unavailable</span>';state.textContent='Bridge online · Mornye client '+(d.mornye_client_ready?'initialised':'initialises on first playback')+' · active jobs '+d.active_jobs;job.textContent=d.last_job?JSON.stringify(d.last_job,null,2):'No playback jobs yet.';}catch(e){state.innerHTML='<span class="warn">Unable to contact playback backend</span>';job.textContent=String(e);}}
document.getElementById('refresh').addEventListener('click',refresh);refresh();setInterval(refresh,15000);
</script></body></html>`;
}

async function adminStatus(bridgeUrl, bridgeToken) {
  try {
    const response = await fetch(`${bridgeUrl.replace(/\/+$/, "")}/health`, {
      headers: { Authorization: `Bearer ${bridgeToken}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return json({ ok: false, error: `Bridge returned HTTP ${response.status}` }, 503);
    return json(await response.json());
  } catch {
    return json({ ok: false, error: "Playback bridge is unavailable" }, 503);
  }
}

async function proxyMedia({ request, jobId, bridgeUrl, bridgeToken }) {
  const url = `${bridgeUrl.replace(/\/+$/, "")}/media/${encodeURIComponent(jobId)}`;
  const headers = { Authorization: `Bearer ${bridgeToken}` };
  const range = request.headers.get("range");
  if (range) headers.Range = range;
  const ifRange = request.headers.get("if-range");
  if (ifRange) headers["If-Range"] = ifRange;

  let upstream;
  try {
    upstream = await fetch(url, {
      method: request.method,
      headers,
      signal: AbortSignal.timeout(60 * 60 * 1000),
    });
  } catch {
    return json({ error: "Playback backend could not provide the audio file" }, 502);
  }

  const forwarded = new Headers();
  for (const name of ["accept-ranges", "content-length", "content-range", "content-type", "content-disposition", "last-modified", "etag", "cache-control"]) {
    const value = upstream.headers.get(name);
    if (value) forwarded.set(name, value);
  }
  forwarded.set("Cache-Control", "private, no-store");
  return new Response(request.method === "HEAD" ? null : upstream.body, {
    status: upstream.status,
    headers: forwarded,
  });
}

function failure(err) {
  if (err instanceof NotImplementedError) return json({ error: err.message }, 501);
  console.error("[addon] provider error:", err?.message || "unknown error");
  return json({ error: "Upstream source failed. Check the private admin page for details." }, 502);
}

export function createHandler({
  provider,
  auth = null,
  meta = {},
  pathSecret,
  mediaSecret,
  bridgeToken,
  adminPassword,
  adminUsername = "admin",
  bridgeUrl = "http://127.0.0.1:8765",
  mediaTtlSeconds = 3600,
}) {
  const prefix = pathSecret ? `/${pathSecret}` : "";
  const manifest = buildManifest(provider, {
    id: meta.id || "personal.bitchord.tidal.mornye",
    name: meta.name || "Personal TIDAL (Mornye)",
    version: meta.version || "0.3.0",
    auth,
  });

  return async function handle(request) {
    if (request.method !== "GET" && request.method !== "HEAD") return new Response(null, { status: 405 });
    const url = new URL(request.url);
    const originalPath = url.pathname.replace(/\/+$/, "") || "/";

    // Render's health check is intentionally shallow and reveals no secrets.
    if (originalPath === "/healthz") return json({ ok: true, service: "personal-bitchord-tidal" });

    // The path prefix acts as a private bearer URL. It is intentionally not
    // part of the JSON manifest; BitChord retains the manifest's path prefix
    // when constructing the search and stream resource URLs.
    if (prefix && originalPath !== prefix && !originalPath.startsWith(`${prefix}/`)) {
      return new Response(null, { status: 404 });
    }
    const path = prefix ? (originalPath.slice(prefix.length) || "/") : originalPath;

    if (path === "/" || path === "/manifest.json") {
      if (request.method === "HEAD") return new Response(null, { status: 200, headers: { "Content-Type": "application/json" } });
      return json(manifest);
    }

    if (path === "/admin" || path === "/admin/status") {
      if (!adminPassword || !verifyBasicAuth(request, adminUsername, adminPassword)) return basicAuthFailure();
      if (path === "/admin") {
        return new Response(dashboardHtml(prefix), {
          status: 200,
          headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
        });
      }
      return adminStatus(bridgeUrl, bridgeToken);
    }

    // The player fetches media separately from the initial BitChord resolver
    // request, so this route uses a short-lived HMAC URL instead of addon auth.
    if (path.startsWith("/media/")) {
      const jobId = decodeURIComponent(path.slice("/media/".length));
      if (!/^[a-f0-9]{32}$/.test(jobId)) return new Response(null, { status: 404 });
      if (!verifyMediaSignature(jobId, url.searchParams.get("exp"), url.searchParams.get("sig"), mediaSecret)) {
        return new Response(null, { status: 403 });
      }
      return proxyMedia({ request, jobId, bridgeUrl, bridgeToken });
    }

    if (auth) {
      const denied = await auth.guard(request);
      if (denied) return denied;
    }

    if (path === "/search") {
      const q = (url.searchParams.get("q") || "").trim();
      if (!q) return json({ tracks: [] });
      try {
        const tracks = await provider.search(q, readContext(url, provider));
        return json({ tracks: (tracks || []).filter(validTrack).slice(0, 20) });
      } catch (err) {
        return failure(err);
      }
    }

    if (path.startsWith("/stream/")) {
      let id;
      try { id = decodeURIComponent(path.slice("/stream/".length)); } catch { return new Response(null, { status: 404 }); }
      if (!id) return new Response(null, { status: 404 });
      try {
        const context = readContext(url, provider);
        context.mediaUrlBuilder = (jobId) => getMediaUrl({
          jobId,
          request,
          prefix,
          secret: mediaSecret,
          ttlSeconds: mediaTtlSeconds,
        });
        const info = await provider.resolveStream(id, context);
        const stream = normalizeStream(info);
        if (!stream) return new Response(null, { status: 404 });
        return json(stream);
      } catch (err) {
        return failure(err);
      }
    }

    return new Response(null, { status: 404 });
  };
}
