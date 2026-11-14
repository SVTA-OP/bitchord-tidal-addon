// TIDAL source for BitChord.
// Metadata: TIDAL's public web catalog API.
// Playback: a user-configured hifi-api-compatible endpoint, matching the
// customEndpoint contract used by Mornye's tidal-web extension.
//
// This adapter deliberately does not reproduce Mornye's signed Zarz session
// protocol. Configure TIDAL_HIFI_API_URL with an endpoint you operate and are
// authorized to use. Only unencrypted direct HTTPS audio URLs are returned.

import { NotImplementedError } from "../handler.js";

const API_BASE = "https://tidal.com/v1";
const DEFAULT_PUBLIC_TOKEN = "49YxDN9a2aFV6RTG";
const QUALITY_VALUES = new Set([
  "HI_RES_LOSSLESS",
  "LOSSLESS",
  "HIGH",
  "LOW",
]);

export const id = "tidal";

export const qualityOptions = [
  { value: "HI_RES_LOSSLESS", label: "Hi-Res Lossless" },
  { value: "LOSSLESS", label: "Lossless" },
  { value: "HIGH", label: "High" },
  { value: "LOW", label: "Low" },
];

function publicToken() {
  return String(process.env.TIDAL_PUBLIC_TOKEN || DEFAULT_PUBLIC_TOKEN).trim();
}

function countryCode() {
  return String(process.env.TIDAL_COUNTRY_CODE || "US").trim().toUpperCase();
}

function locale() {
  return String(process.env.TIDAL_LOCALE || "en_US").trim();
}

function deviceType() {
  return String(process.env.TIDAL_DEVICE_TYPE || "BROWSER").trim().toUpperCase();
}

function apiHeaders() {
  return {
    Accept: "application/json",
    "User-Agent": process.env.TIDAL_USER_AGENT || "Mozilla/5.0 (compatible; BitChord-TIDAL/1.0)",
    "x-tidal-token": publicToken(),
  };
}

function withCatalogParams(path, params = {}) {
  const url = new URL(path.replace(/^\/+/, ""), `${API_BASE}/`);
  url.searchParams.set("countryCode", countryCode());
  url.searchParams.set("locale", locale());
  url.searchParams.set("deviceType", deviceType());
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }
  return url;
}

async function requestJson(url, headers = {}) {
  const response = await fetch(url, {
    method: "GET",
    headers: { ...apiHeaders(), ...headers },
    signal: AbortSignal.timeout(12_000),
  });
  if (!response.ok) {
    if (response.status === 404) return null;
    throw new Error(`TIDAL request failed (HTTP ${response.status})`);
  }
  return response.json();
}

function artistNames(artists) {
  if (!Array.isArray(artists)) return "";
  return artists.map((artist) => String(artist?.name || "").trim()).filter(Boolean).join(", ");
}

function trackTitle(track) {
  const title = String(track?.title || "").trim();
  const version = String(track?.version || "").trim();
  if (!title || !version || title.toLowerCase().includes(version.toLowerCase())) return title;
  return `${title} (${version})`;
}

function artworkUrl(coverId) {
  const id = String(coverId || "").trim();
  if (!id) return "";
  return `https://resources.tidal.com/images/${id.replace(/-/g, "/")}/640x640.jpg`;
}

function mapTrack(track) {
  const id = String(track?.id || "").trim();
  const title = trackTitle(track);
  if (!/^\d+$/.test(id) || !title) return null;

  const album = track.album || {};
  const artists = artistNames(track.artists);
  const audioQuality = String(track.audioQuality || track.mediaMetadata?.audioQuality || "").trim();
  const duration = Number(track.duration);

  return {
    id: `tidal:${id}`,
    title,
    artist: artists,
    album: String(album.title || ""),
    duration: Number.isFinite(duration) && duration > 0 ? duration : undefined,
    artworkURL: artworkUrl(album.cover),
    ...(audioQuality ? { audioQuality } : {}),
    provider: "TIDAL",
    isrc: String(track.isrc || ""),
  };
}

/** Search TIDAL's public catalog and map results to BitChord's track schema. */
export async function search(query) {
  const q = String(query || "").trim();
  if (!q) return [];

  const url = withCatalogParams("search/tracks", {
    query: q,
    limit: 20,
    offset: 0,
  });
  const body = await requestJson(url);
  const items = Array.isArray(body?.items) ? body.items : [];
  return items.map(mapTrack).filter(Boolean);
}

function normalizeTrackId(value) {
  const raw = String(value || "").trim().replace(/^tidal:/i, "");
  return /^\d+$/.test(raw) ? raw : "";
}

function isPrivateIPv4(hostname) {
  const parts = hostname.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  return parts[0] === 10 || parts[0] === 127 ||
    (parts[0] === 192 && parts[1] === 168) ||
    (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
    (parts[0] === 169 && parts[1] === 254);
}

function isLocalHost(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return host === "localhost" || host === "::1" || host === "0:0:0:0:0:0:0:1" || isPrivateIPv4(host) || host.endsWith(".local");
}

function getHifiApiBase() {
  const configured = String(process.env.TIDAL_HIFI_API_URL || "").trim();
  if (!configured) {
    throw new NotImplementedError(
      "TIDAL playback needs TIDAL_HIFI_API_URL: configure your own hifi-api-compatible endpoint"
    );
  }

  let url;
  try {
    url = new URL(configured);
  } catch {
    throw new Error("TIDAL_HIFI_API_URL must be an absolute HTTP(S) URL");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("TIDAL_HIFI_API_URL must not contain credentials, query parameters, or a fragment");
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLocalHost(url.hostname))) {
    throw new Error("TIDAL_HIFI_API_URL must use HTTPS (HTTP is allowed only for a local/private host)");
  }
  return url.toString().replace(/\/+$/, "");
}

function decodeManifestText(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  if (text.startsWith("{") || text.startsWith("<?xml") || text.startsWith("<MPD")) return text;
  try {
    return Buffer.from(text, "base64").toString("utf8");
  } catch {
    return "";
  }
}

function decodeBtsManifest(value) {
  const decoded = decodeManifestText(value);
  if (!decoded) return null;

  try {
    const manifest = JSON.parse(decoded);
    if (!manifest || typeof manifest !== "object") return null;
    const encryption = String(manifest.encryptionType || "").toUpperCase();
    if (encryption !== "NONE") return null;
    const urls = Array.isArray(manifest.urls) ? manifest.urls : [];
    const url = urls.find((candidate) => {
      try { return new URL(candidate).protocol === "https:"; } catch { return false; }
    });
    if (!url) return null;
    return {
      url,
      mimeType: String(manifest.mimeType || ""),
      codecs: String(manifest.codecs || ""),
    };
  } catch {
    return null;
  }
}

function isUnencryptedFlacDash(manifestValue) {
  const xml = decodeManifestText(manifestValue);
  if (!xml || !/<MPD[\s>]/i.test(xml) || !/<SegmentTemplate[\s>]/i.test(xml)) return false;
  // Reject DRM/protected representations instead of passing them to BitChord.
  if (/<ContentProtection\b|cenc:pssh|default_KID|widevine|playready/i.test(xml)) return false;
  return /codecs=["']flac["']/i.test(xml);
}

function inferCodec(mimeType, codecs) {
  const value = `${mimeType} ${codecs}`.toLowerCase();
  if (value.includes("flac")) return { codec: "flac", container: "flac", format: "flac" };
  if (value.includes("mpeg") || value.includes("mp3")) return { codec: "mp3", container: "mp3", format: "mp3" };
  if (value.includes("aac") || value.includes("mp4") || value.includes("mp4a")) {
    return { codec: "aac", container: "mp4", format: "aac" };
  }
  if (value.includes("opus")) return { codec: "opus", container: "ogg", format: "opus" };
  return null;
}

async function hifiApiGet(path, params) {
  const base = getHifiApiBase();
  const url = new URL(`${base}/${String(path || "").replace(/^\/+/, "")}`);
  for (const [key, value] of Object.entries(params || {})) {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
  }
  const response = await fetch(url, {
    method: "GET",
    headers: {
      Accept: "application/json",
      "User-Agent": process.env.TIDAL_HIFI_API_USER_AGENT || "BitChord-TIDAL/1.0",
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`TIDAL hifi-api request failed (HTTP ${response.status})`);
  return response.json();
}

function makeQualityLabel(actualQuality, bitDepth, sampleRate) {
  const base = actualQuality === "HI_RES_LOSSLESS"
    ? "Hi-Res Lossless"
    : actualQuality === "LOSSLESS" ? "Lossless" : actualQuality;
  const details = [];
  if (bitDepth) details.push(`${bitDepth}-bit`);
  if (sampleRate) details.push(`${Math.round(sampleRate / 1000 * 10) / 10} kHz`);
  return details.length ? `${base} (${details.join(", ")})` : base;
}

function directStreamFromPayload(payload, selectedQuality) {
  const data = payload?.data;
  if (!data || String(data.assetPresentation || "FULL").toUpperCase() === "PREVIEW") return null;
  const decoded = decodeBtsManifest(data.manifest);
  if (!decoded) return null;

  const audio = inferCodec(decoded.mimeType || data.manifestMimeType, decoded.codecs);
  if (!audio) return null;

  const bitDepth = Number(data.bitDepth) || undefined;
  const sampleRate = Number(data.sampleRate) || undefined;
  const actualQuality = String(data.audioQuality || selectedQuality).toUpperCase();
  return {
    url: decoded.url,
    ...audio,
    manifest: "none",
    quality: makeQualityLabel(actualQuality, bitDepth, sampleRate),
    ...(sampleRate ? { sampleRate } : {}),
    ...(bitDepth ? { bitDepth } : {}),
    audioMode: String(data.audioMode || "STEREO"),
    encrypted: false,
  };
}

async function resolveHiResManifest(trackId) {
  // Mornye's provider uses trackManifests for adaptive Hi-Res/Atmos. For
  // BitChord, request only FLAC tiers and return the HTTPS MPD URL directly.
  const payload = await hifiApiGet("trackManifests/", {
    id: trackId,
    formats: "FLAC_HIRES,FLAC",
    adaptive: "true",
    manifestType: "MPEG_DASH",
    uriScheme: "HTTPS",
    usage: "PLAYBACK",
  });
  const attributes = payload?.data?.data?.attributes;
  if (!attributes) return null;
  const formats = Array.isArray(attributes.formats)
    ? attributes.formats.map((item) => String(item).toUpperCase())
    : [];
  const uri = String(attributes.uri || "").trim();
  try {
    if (new URL(uri).protocol !== "https:") return null;
  } catch {
    return null;
  }

  const hasHiRes = formats.includes("FLAC_HIRES") || formats.includes("FLAC_HI_RES");
  const hasLossless = formats.includes("FLAC");
  if (!hasHiRes && !hasLossless) return null;

  return {
    url: uri,
    format: "flac",
    codec: "flac",
    container: "dash",
    manifest: "dash",
    quality: hasHiRes ? "Hi-Res Lossless" : "Lossless",
    audioMode: "STEREO",
    encrypted: false,
  };
}

/** Resolve a TIDAL track through the configured hifi-api-compatible server. */
export async function resolveStream(trackId, { quality = "HI_RES_LOSSLESS" } = {}) {
  const id = normalizeTrackId(trackId);
  if (!id) return null;

  const requestedQuality = String(quality || "HI_RES_LOSSLESS").toUpperCase();
  const selectedQuality = QUALITY_VALUES.has(requestedQuality) ? requestedQuality : "HI_RES_LOSSLESS";

  const payload = await hifiApiGet("track/", { id, quality: selectedQuality });
  const data = payload?.data;
  if (!data || String(data.assetPresentation || "FULL").toUpperCase() === "PREVIEW") return null;

  // Standard BTS manifests contain a direct, unencrypted URL. This is the
  // common path for CD FLAC and the lossy quality tiers.
  const direct = directStreamFromPayload(payload, selectedQuality);
  if (direct) return direct;

  // Hi-Res TIDAL streams are commonly returned as a base64 DASH MPD instead
  // of a BTS URL. Validate the MPD is FLAC and has no DRM declarations, then
  // request its HTTPS playback URI from the compatible API.
  if (String(data.manifestMimeType || "").toLowerCase().includes("dash+xml") &&
      isUnencryptedFlacDash(data.manifest)) {
    const adaptive = await resolveHiResManifest(id);
    if (!adaptive) return null;
    const isHiRes = adaptive.quality === "Hi-Res Lossless";
    const bitDepth = isHiRes ? (Number(data.bitDepth) || undefined) : undefined;
    const sampleRate = isHiRes ? (Number(data.sampleRate) || undefined) : undefined;
    const actualQuality = isHiRes ? "HI_RES_LOSSLESS" : "LOSSLESS";
    return {
      ...adaptive,
      quality: makeQualityLabel(actualQuality, bitDepth, sampleRate),
      ...(bitDepth ? { bitDepth } : {}),
      ...(sampleRate ? { sampleRate } : {}),
      audioMode: String(data.audioMode || "STEREO"),
    };
  }
  return null;
}
