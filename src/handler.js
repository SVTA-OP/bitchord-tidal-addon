// Framework-neutral BitChord addon: Fetch Request in, Response out.
// Routes: GET /manifest.json (also /), GET /search?q=, GET /stream/{id}

export class NotImplementedError extends Error {
  constructor(message = "Not implemented") {
    super(message);
    this.name = "NotImplementedError";
  }
}

const json = (body, status = 200) =>
  Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

export function buildManifest(provider, { id, name, version, auth }) {
  const manifest = {
    id,
    name,
    version,
    resources: ["search", "stream"],
    allowDownloads: 1,
  };
  if (auth) manifest.bitchordAuth = true;
  // Best option first: BitChord sends the first option when the listener has not picked one.
  if (provider.qualityOptions && provider.qualityOptions.length) {
    manifest.settings = [
      {
        key: "quality",
        type: "select",
        label: "Audio quality",
        default: provider.qualityOptions[0].value,
        options: provider.qualityOptions,
      },
    ];
  }
  return manifest;
}

function readContext(url, provider) {
  const fallback = provider.qualityOptions?.[0]?.value ?? "high";
  return {
    quality: url.searchParams.get("quality") || fallback,
    atmos: url.searchParams.get("atmos") === "auto",
  };
}

function validTrack(t) {
  return t && String(t.id || "").length > 0 && String(t.title || "").length > 0;
}

function isAbsoluteHttps(value) {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

// Keep only fields BitChord documents, and refuse anything it can't play.
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

function failure(err) {
  if (err instanceof NotImplementedError) {
    return json({ error: err.message }, 501);
  }
  console.error("[addon] provider error:", err);
  return json({ error: "Upstream source failed" }, 502);
}

export function createHandler({ provider, auth = null, meta = {} }) {
  const manifest = buildManifest(provider, {
    id: meta.id || "dev.example.bitchord-addon",
    name: meta.name || "BitChord Addon",
    version: meta.version || "0.1.0",
    auth,
  });

  return async function handle(request) {
    if (request.method !== "GET") return new Response(null, { status: 405 });

    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    // The manifest stays public: BitChord reads it without credentials.
    if (path === "/" || path === "/manifest.json") return json(manifest);

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
      try {
        id = decodeURIComponent(path.slice("/stream/".length));
      } catch {
        return new Response(null, { status: 404 });
      }
      if (!id) return new Response(null, { status: 404 });
      try {
        const info = await provider.resolveStream(id, readContext(url, provider));
        const stream = normalizeStream(info);
        // 404 means "not in this addon" and lets BitChord try the next source.
        if (!stream) return new Response(null, { status: 404 });
        return json(stream);
      } catch (err) {
        return failure(err);
      }
    }

    return new Response(null, { status: 404 });
  };
}
