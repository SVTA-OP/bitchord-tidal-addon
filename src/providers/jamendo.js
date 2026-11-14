// Working example source: Jamendo's official API (Creative Commons music).
// Needs a free client id from https://devportal.jamendo.com (JAMENDO_CLIENT_ID).
// Jamendo serves MP3, so quality options are honest MP3 tiers (no lossless label).

const API = "https://api.jamendo.com/v3.0";

export const id = "jamendo";

export const qualityOptions = [
  { value: "high", label: "High (MP3 VBR)" },
  { value: "low", label: "Low (MP3 96 kbps)" },
];

const formatFor = (quality) => (quality === "low" ? "mp31" : "mp32");

async function call(params) {
  const clientId = process.env.JAMENDO_CLIENT_ID;
  if (!clientId) throw new Error("JAMENDO_CLIENT_ID is not set");
  const qs = new URLSearchParams({ client_id: clientId, format: "json", ...params });
  const res = await fetch(`${API}/tracks/?${qs}`, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`Jamendo HTTP ${res.status}`);
  const body = await res.json();
  return body.results || [];
}

export async function search(query, { quality }) {
  const rows = await call({
    search: query,
    limit: "20",
    audioformat: formatFor(quality),
    imagesize: "300",
  });
  return rows.map((r) => ({
    id: String(r.id),
    title: r.name,
    artist: r.artist_name,
    album: r.album_name,
    duration: Number(r.duration) || undefined,
    artworkURL: r.image || r.album_image,
    format: "mp3",
    audioQuality: quality === "low" ? "LOW" : "HIGH",
  }));
}

export async function resolveStream(trackId, { quality }) {
  const rows = await call({ id: trackId, audioformat: formatFor(quality) });
  const row = rows[0];
  if (!row || !row.audio) return null;
  return {
    url: String(row.audio).replace(/^http:/, "https:"),
    format: "mp3",
    codec: "mp3",
    container: "mp3",
    manifest: "none",
    encrypted: false,
    quality: quality === "low" ? "MP3 96 kbps" : "MP3 VBR",
    ...(quality === "low" ? { bitrate: 96000 } : {}),
  };
}
