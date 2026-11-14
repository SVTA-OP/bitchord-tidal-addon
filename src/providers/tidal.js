// TIDAL source for BitChord.
// Search uses TIDAL's public catalog API. Playback is delegated to the local
// Mornye-Python host, which runs the official tidal-web extension and signed
// Zarz session flow. The completed audio file is then served through a private
// short-lived URL (download-then-play, not live CDN streaming).

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

/**
 * Resolve TIDAL through the local Mornye-Python host.
 *
 * The host runs the official tidal-web extension and its Zarz signed-session
 * implementation. It queues a Mornye download and immediately returns a job
 * id; BitChord's media URL waits for the completed, unencrypted output file.
 * This is download-then-play, not direct CDN streaming.
 */
export async function resolveStream(trackId, { quality = "LOSSLESS", mediaUrlBuilder } = {}) {
  const id = normalizeTrackId(trackId);
  if (!id) return null;
  if (typeof mediaUrlBuilder !== "function") {
    throw new Error("Private media URL builder is unavailable");
  }

  const bridgeBase = String(process.env.MORNYE_BRIDGE_URL || "http://127.0.0.1:8765").trim().replace(/\/+$/, "");
  const bridgeToken = String(process.env.INTERNAL_BRIDGE_TOKEN || "").trim();
  if (!bridgeToken) {
    throw new NotImplementedError("Mornye playback bridge is not configured");
  }

  const selectedQuality = QUALITY_VALUES.has(String(quality || "").toUpperCase())
    ? String(quality).toUpperCase()
    : "LOSSLESS";

  const response = await fetch(`${bridgeBase}/resolve`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: `Bearer ${bridgeToken}`,
    },
    body: JSON.stringify({ track_id: id, quality: selectedQuality }),
    signal: AbortSignal.timeout(12_000),
  });

  let payload;
  try { payload = await response.json(); } catch { payload = {}; }
  if (!response.ok) {
    const detail = String(payload?.detail || payload?.error || `HTTP ${response.status}`);
    throw new Error(`Mornye could not queue this TIDAL track: ${detail}`);
  }

  const jobId = String(payload?.job_id || "");
  if (!/^[a-f0-9]{32}$/.test(jobId)) {
    throw new Error("Mornye returned an invalid playback job id");
  }

  return {
    url: mediaUrlBuilder(jobId),
    // BitChord will sniff the completed audio file. We intentionally omit
    // codec/sample-rate claims until the final file has been produced.
    encrypted: false,
  };
}
