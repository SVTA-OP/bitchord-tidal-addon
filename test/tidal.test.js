import test from "node:test";
import assert from "node:assert/strict";
import * as tidal from "../src/providers/tidal.js";
import { createHandler } from "../src/handler.js";

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

test("playback queues a Mornye job and returns a signed media URL", async (t) => {
  process.env.MORNYE_BRIDGE_URL = "http://127.0.0.1:8765";
  process.env.INTERNAL_BRIDGE_TOKEN = "bridge-test-token";
  let requested;
  globalThis.fetch = async (url, options) => {
    requested = { url: String(url), options };
    return jsonResponse({ job_id: "a".repeat(32), status: "queued" }, 202);
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const stream = await tidal.resolveStream("tidal:123456", {
    quality: "HI_RES_LOSSLESS",
    mediaUrlBuilder: (id) => `https://addon.example/private/media/${id}?exp=123&sig=abc`,
  });
  assert.match(requested.url, /127\.0\.0\.1:8765\/resolve$/);
  assert.equal(requested.options.method, "POST");
  assert.equal(requested.options.headers.Authorization, "Bearer bridge-test-token");
  assert.deepEqual(JSON.parse(requested.options.body), {
    track_id: "123456",
    quality: "HI_RES_LOSSLESS",
  });
  assert.equal(stream.url, `https://addon.example/private/media/${"a".repeat(32)}?exp=123&sig=abc`);
  assert.equal(stream.encrypted, false);
  assert.equal(stream.codec, undefined); // don't claim codec before the file exists
});

test("playback rejects non-numeric ids and invalid backend responses", async (t) => {
  assert.equal(await tidal.resolveStream("not-a-track", { mediaUrlBuilder: () => "https://x" }), null);

  process.env.MORNYE_BRIDGE_URL = "http://127.0.0.1:8765";
  process.env.INTERNAL_BRIDGE_TOKEN = "bridge-test-token";
  globalThis.fetch = async () => jsonResponse({ error: "nope" }, 503);
  t.after(() => { globalThis.fetch = originalFetch; });
  await assert.rejects(
    () => tidal.resolveStream("123", { mediaUrlBuilder: () => "https://x" }),
    /Mornye could not queue this TIDAL track/,
  );
});

test("BitChord manifest and stream remain under the private path prefix", async (t) => {
  process.env.TIDAL_COUNTRY_CODE = "IN";
  process.env.MORNYE_BRIDGE_URL = "http://127.0.0.1:8765";
  process.env.INTERNAL_BRIDGE_TOKEN = "bridge-test-token";
  globalThis.fetch = async (url) => {
    if (String(url).includes("/search/tracks")) {
      return jsonResponse({ items: [{
        id: "789", title: "Route Test", duration: 180,
        artists: [{ name: "Tester" }], album: { title: "Test", cover: "a-b" },
      }] });
    }
    return jsonResponse({ job_id: "b".repeat(32), status: "queued" }, 202);
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const handler = createHandler({
    provider: tidal,
    pathSecret: "p".repeat(40),
    mediaSecret: "m".repeat(40),
    bridgeToken: "bridge-test-token",
  });
  assert.equal((await handler(new Request("https://addon.example/manifest.json"))).status, 404);

  const prefix = `/` + "p".repeat(40);
  const manifestResponse = await handler(new Request(`https://addon.example${prefix}/manifest.json`));
  assert.equal(manifestResponse.status, 200);
  assert.equal((await manifestResponse.json()).id, "personal.bitchord.tidal.mornye");

  const searchResponse = await handler(new Request(`https://addon.example${prefix}/search?q=Route%20Test`));
  const search = await searchResponse.json();
  assert.equal(search.tracks[0].id, "tidal:789");

  const streamResponse = await handler(new Request(`https://addon.example${prefix}/stream/tidal%3A789?quality=LOSSLESS`));
  const stream = await streamResponse.json();
  assert.equal(stream.encrypted, false);
  assert.match(stream.url, new RegExp(`https://addon\\.example${prefix}/media/${"b".repeat(32)}\\?exp=`));
  assert.equal(stream.codec, undefined);
});


test("signed media route requires valid signature and proxies byte ranges", async (t) => {
  const secret = "m".repeat(40);
  const jobId = "c".repeat(32);
  const expires = Math.floor(Date.now() / 1000) + 300;
  const { createHmac } = await import("node:crypto");
  const sig = createHmac("sha256", secret).update(`${jobId}.${expires}`).digest("base64url");
  let upstreamRequest;
  globalThis.fetch = async (url, options) => {
    upstreamRequest = { url: String(url), options };
    return new Response("audio-bytes", {
      status: 206,
      headers: {
        "content-type": "audio/flac",
        "content-length": "11",
        "content-range": "bytes 0-10/100",
        "accept-ranges": "bytes",
      },
    });
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const handler = createHandler({
    provider: tidal,
    pathSecret: "p".repeat(40),
    mediaSecret: secret,
    bridgeToken: "bridge-test-token",
    bridgeUrl: "http://127.0.0.1:8765",
  });
  const path = `/${"p".repeat(40)}/media/${jobId}?exp=${expires}&sig=${encodeURIComponent(sig)}`;
  const denied = await handler(new Request(`https://addon.example${path.replace(sig, "bad")}`));
  assert.equal(denied.status, 403);
  const response = await handler(new Request(`https://addon.example${path}`, { headers: { Range: "bytes=0-10" } }));
  assert.equal(response.status, 206);
  assert.equal(response.headers.get("content-type"), "audio/flac");
  assert.equal(await response.text(), "audio-bytes");
  assert.equal(upstreamRequest.options.headers.Range, "bytes=0-10");
  assert.equal(upstreamRequest.options.headers.Authorization, "Bearer bridge-test-token");
});

test("admin page is protected by HTTP Basic Auth", async () => {
  const handler = createHandler({
    provider: tidal,
    pathSecret: "p".repeat(40),
    mediaSecret: "m".repeat(40),
    bridgeToken: "bridge-test-token",
    adminPassword: "a-very-long-test-password",
    adminUsername: "admin",
  });
  const url = `https://addon.example/${"p".repeat(40)}/admin`;
  assert.equal((await handler(new Request(url))).status, 401);
  const credentials = Buffer.from("admin:a-very-long-test-password").toString("base64");
  const response = await handler(new Request(url, { headers: { Authorization: `Basic ${credentials}` } }));
  assert.equal(response.status, 200);
  assert.match(await response.text(), /Personal BitChord TIDAL/);
});
