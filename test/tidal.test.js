import test from "node:test";
import assert from "node:assert/strict";
import * as tidal from "../src/providers/tidal.js";
import { createHandler, NotImplementedError } from "../src/handler.js";

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };

test.after(() => {
  globalThis.fetch = originalFetch;
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(originalEnv)) process.env[key] = value;
});

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function btsManifest({ mimeType = "audio/flac", codecs = "flac", encryptionType = "NONE" } = {}) {
  return Buffer.from(JSON.stringify({
    mimeType,
    codecs,
    encryptionType,
    urls: ["https://audio.tidal.com/example.flac?token=abc"],
  })).toString("base64");
}

function dashManifest({ protectedTrack = false } = {}) {
  const protection = protectedTrack ? '<ContentProtection schemeIdUri="urn:mpeg:dash:mp4protection:2011" />' : "";
  return Buffer.from(`<?xml version='1.0'?><MPD><Period><AdaptationSet><Representation codecs="flac" audioSamplingRate="44100">${protection}<SegmentTemplate initialization="https://audio.tidal.com/init.mp4" media="https://audio.tidal.com/$Number$.mp4"><SegmentTimeline><S d="1000" /></SegmentTimeline></SegmentTemplate></Representation></AdaptationSet></Period></MPD>`).toString("base64");
}

test("TIDAL search maps catalog tracks into BitChord's schema", async (t) => {
  process.env.TIDAL_COUNTRY_CODE = "IN";
  let requested;
  globalThis.fetch = async (url, options) => {
    requested = { url: String(url), options };
    return jsonResponse({ items: [{
      id: 123456,
      title: "Example Song",
      version: "Live",
      duration: 215,
      isrc: "USABC1234567",
      artists: [{ name: "Example Artist" }, { name: "Guest" }],
      album: { title: "Example Album", cover: "aaaa-bbbb-cccc" },
    }] });
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const tracks = await tidal.search("Example Song");
  assert.equal(tracks.length, 1);
  assert.equal(tracks[0].id, "tidal:123456");
  assert.equal(tracks[0].title, "Example Song (Live)");
  assert.equal(tracks[0].artist, "Example Artist, Guest");
  assert.equal(tracks[0].album, "Example Album");
  assert.equal(tracks[0].duration, 215);
  assert.match(tracks[0].artworkURL, /resources\.tidal\.com\/images\/aaaa\/bbbb\/cccc\/640x640\.jpg/);
  assert.match(requested.url, /search\/tracks/);
  assert.match(requested.url, /countryCode=IN/);
  assert.equal(requested.options.headers["x-tidal-token"], "49YxDN9a2aFV6RTG");
});

test("Hi-Res playback validates the MPD and resolves its HTTPS DASH URL", async (t) => {
  process.env.TIDAL_HIFI_API_URL = "https://hifi.example";
  const requests = [];
  globalThis.fetch = async (url) => {
    requests.push(String(url));
    if (String(url).includes("trackManifests")) {
      return jsonResponse({ data: { data: { attributes: {
        uri: "https://manifest.tidal.com/example.mpd?token=abc",
        formats: ["FLAC", "FLAC_HIRES"],
      } } } });
    }
    return jsonResponse({ data: {
      assetPresentation: "FULL",
      audioQuality: "HI_RES_LOSSLESS",
      manifestMimeType: "application/dash+xml",
      manifest: dashManifest(),
      bitDepth: 24,
      sampleRate: 96000,
      audioMode: "STEREO",
    } });
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const stream = await tidal.resolveStream("tidal:123456", { quality: "HI_RES_LOSSLESS" });
  assert.match(requests[0], /\/track\/\?id=123456&quality=HI_RES_LOSSLESS/);
  assert.match(requests[1], /trackManifests/);
  assert.equal(stream.codec, "flac");
  assert.equal(stream.container, "dash");
  assert.equal(stream.manifest, "dash");
  assert.equal(stream.quality, "Hi-Res Lossless (24-bit, 96 kHz)");
  assert.equal(stream.encrypted, false);
  assert.match(stream.url, /^https:\/\//);
});

test("CD Lossless playback extracts the unencrypted direct FLAC URL", async (t) => {
  process.env.TIDAL_HIFI_API_URL = "https://hifi.example";
  let requested;
  globalThis.fetch = async (url) => {
    requested = String(url);
    return jsonResponse({ data: {
      assetPresentation: "FULL",
      audioQuality: "LOSSLESS",
      manifestMimeType: "application/vnd.tidal.bts",
      manifest: btsManifest(),
      bitDepth: 16,
      sampleRate: 44100,
      audioMode: "STEREO",
    } });
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const stream = await tidal.resolveStream("tidal:123456", { quality: "LOSSLESS" });
  assert.match(requested, /\/track\/\?id=123456&quality=LOSSLESS/);
  assert.equal(stream.codec, "flac");
  assert.equal(stream.container, "flac");
  assert.equal(stream.bitDepth, 16);
  assert.equal(stream.sampleRate, 44100);
  assert.equal(stream.encrypted, false);
  assert.match(stream.url, /^https:\/\//);
});

test("Hi-Res preference accepts a confirmed CD FLAC result without relabeling it", async (t) => {
  process.env.TIDAL_HIFI_API_URL = "https://hifi.example";
  let calls = 0;
  globalThis.fetch = async (url) => {
    calls++;
    assert.match(String(url), /quality=HI_RES_LOSSLESS/);
    return jsonResponse({ data: {
      assetPresentation: "FULL", audioQuality: "LOSSLESS",
      manifestMimeType: "application/vnd.tidal.bts", manifest: btsManifest(),
      bitDepth: 16, sampleRate: 44100,
    } });
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const stream = await tidal.resolveStream("123", { quality: "HI_RES_LOSSLESS" });
  assert.equal(calls, 1);
  assert.equal(stream.quality, "Lossless (16-bit, 44.1 kHz)");
});

test("encrypted manifests and preview assets are not exposed to BitChord", async (t) => {
  process.env.TIDAL_HIFI_API_URL = "https://hifi.example";
  globalThis.fetch = async () => jsonResponse({ data: {
    assetPresentation: "FULL",
    audioQuality: "LOSSLESS",
    manifestMimeType: "application/vnd.tidal.bts",
    manifest: btsManifest({ encryptionType: "AES" }),
  } });
  t.after(() => { globalThis.fetch = originalFetch; });
  assert.equal(await tidal.resolveStream("123", { quality: "LOSSLESS" }), null);

  globalThis.fetch = async () => jsonResponse({ data: {
    assetPresentation: "PREVIEW",
    audioQuality: "LOSSLESS",
    manifestMimeType: "application/vnd.tidal.bts",
    manifest: btsManifest(),
  } });
  assert.equal(await tidal.resolveStream("123", { quality: "LOSSLESS" }), null);

  globalThis.fetch = async (url) => {
    if (String(url).includes("trackManifests")) {
      return jsonResponse({ data: { data: { attributes: {
        uri: "https://manifest.tidal.com/protected.mpd",
        formats: ["FLAC_HIRES"],
      } } } });
    }
    return jsonResponse({ data: {
      assetPresentation: "FULL", audioQuality: "HI_RES_LOSSLESS",
      manifestMimeType: "application/dash+xml", manifest: dashManifest({ protectedTrack: true }),
      bitDepth: 24, sampleRate: 96000,
    } });
  };
  assert.equal(await tidal.resolveStream("123", { quality: "HI_RES_LOSSLESS" }), null);
});

test("playback requires an explicitly configured hifi-api-compatible endpoint", async (t) => {
  delete process.env.TIDAL_HIFI_API_URL;
  await assert.rejects(
    () => tidal.resolveStream("123", { quality: "LOSSLESS" }),
    (error) => error instanceof NotImplementedError && /TIDAL_HIFI_API_URL/.test(error.message),
  );
});

test("BitChord search and stream routes work with the TIDAL source", async (t) => {
  process.env.TIDAL_HIFI_API_URL = "https://hifi.example";
  globalThis.fetch = async (url) => {
    if (String(url).includes("/search/tracks")) {
      return jsonResponse({ items: [{
        id: "789", title: "Route Test", duration: 180,
        artists: [{ name: "Tester" }], album: { title: "Test", cover: "a-b" },
      }] });
    }
    return jsonResponse({ data: {
      assetPresentation: "FULL", audioQuality: "LOSSLESS",
      manifestMimeType: "application/vnd.tidal.bts",
      manifest: btsManifest(), bitDepth: 16, sampleRate: 44100,
    } });
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const handler = createHandler({ provider: tidal });
  const searchResponse = await handler(new Request("https://addon.example/search?q=Route%20Test"));
  const search = await searchResponse.json();
  assert.equal(search.tracks[0].id, "tidal:789");

  const streamResponse = await handler(new Request("https://addon.example/stream/tidal%3A789?quality=LOSSLESS"));
  const stream = await streamResponse.json();
  assert.equal(stream.codec, "flac");
  assert.equal(stream.encrypted, false);
});
