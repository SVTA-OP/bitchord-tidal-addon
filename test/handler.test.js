import test from "node:test";
import assert from "node:assert/strict";
import { createHandler, NotImplementedError } from "../src/handler.js";
import * as custom from "../src/providers/custom.js";

const mock = {
  id: "mock",
  qualityOptions: [
    { value: "lossless", label: "Lossless" },
    { value: "low", label: "Low" },
  ],
  calls: [],
  async search(q, ctx) {
    this.calls.push(["search", q, ctx]);
    return [
      { id: "t1", title: "Midnight Signal", artist: "Example", duration: 242 },
      { id: "", title: "bad row" },
    ];
  },
  async resolveStream(id, ctx) {
    this.calls.push(["stream", id, ctx]);
    if (id === "missing") return null;
    if (id === "enc") return { url: "https://x.example/a", encrypted: true };
    if (id === "http") return { url: "http://x.example/a" };
    return { url: "https://x.example/a.flac", codec: "flac", secret: "dropped" };
  },
};

const get = (h, path) => h(new Request("https://addon.example" + path));

test("manifest is public and lists best quality first", async () => {
  const h = createHandler({ provider: mock });
  const m = await (await get(h, "/manifest.json")).json();
  assert.equal(m.settings[0].options[0].value, "lossless");
  assert.equal(m.bitchordAuth, undefined);
});

test("search drops rows without id/title and passes quality/atmos", async () => {
  const h = createHandler({ provider: mock });
  const r = await (await get(h, "/search?q=midnight&quality=low&atmos=auto")).json();
  assert.equal(r.tracks.length, 1);
  const last = mock.calls.at(-1);
  assert.deepEqual(last[2], { quality: "low", atmos: true });
});

test("stream: ok, 404 on miss, refuses encrypted and non-https", async () => {
  const h = createHandler({ provider: mock });
  const ok = await (await get(h, "/stream/t1")).json();
  assert.equal(ok.codec, "flac");
  assert.equal(ok.secret, undefined);
  assert.equal((await get(h, "/stream/missing")).status, 404);
  assert.equal((await get(h, "/stream/enc")).status, 404);
  assert.equal((await get(h, "/stream/http")).status, 404);
});

test("auth guard protects everything except the manifest", async () => {
  const auth = { guard: async () => new Response("no", { status: 401 }) };
  const h = createHandler({ provider: mock, auth });
  const m = await get(h, "/manifest.json");
  assert.equal(m.status, 200);
  assert.equal((await m.json()).bitchordAuth, true);
  assert.equal((await get(h, "/search?q=x")).status, 401);
  assert.equal((await get(h, "/stream/t1")).status, 401);
});

test("placeholder provider answers 501, not a crash", async () => {
  const h = createHandler({ provider: custom });
  assert.equal((await get(h, "/search?q=x")).status, 501);
  assert.equal((await get(h, "/stream/abc")).status, 501);
  assert.ok(new NotImplementedError() instanceof Error);
});
