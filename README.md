# BitChord addon scaffold

A BitChord addon (manifest, `/search`, `/stream/{id}`) with a pluggable source.
Everything BitChord-facing is done; the source is one small file.

## Run locally

    PROVIDER=custom npm start        # placeholder: /search and /stream answer 501
    JAMENDO_CLIENT_ID=xxxx npm start # working example (default provider)
    PROVIDER=tidal TIDAL_HIFI_API_URL=https://your-hifi-api.example npm start
    npm test

Then check `http://localhost:3000/manifest.json`.

## TIDAL (Mornye-compatible)

Set `PROVIDER=tidal` and configure `TIDAL_HIFI_API_URL` to a hifi-api-compatible
endpoint that you operate and are authorized to use. The adapter uses TIDAL's
public web catalog API for search and the endpoint's `GET /track/?id=...&quality=...`
route for playback, matching the `customEndpoint` interface in Mornye's
`tidal-web` provider. It supports `HI_RES_LOSSLESS`, `LOSSLESS`, `HIGH`, and `LOW`.

The playback adapter accepts full, unencrypted TIDAL BTS manifests containing
a direct HTTPS audio URL, and FLAC DASH manifests after checking the returned
MPD for DRM declarations. It returns 404 for missing/preview tracks, encrypted
BTS manifests, or unsupported stream formats. It does not implement Mornye's
private signed-session runtime or call the Zarz download API directly.

Use a valid TIDAL account with the self-hosted API and keep that API on a
private network; do not expose it as an open public service. The upstream
hifi-api project warns about legal and account-restriction risks, including
possible TIDAL account blocking.

Example local `.env` values (when hifi-api is running on the same host):

```dotenv
PROVIDER=tidal
TIDAL_HIFI_API_URL=http://127.0.0.1:8000
TIDAL_COUNTRY_CODE=IN
TIDAL_LOCALE=en_US
```

The BitChord addon server must be able to reach the configured hifi-api host.
Keep hifi-api bound to loopback/private networking and firewall its port; do not
publish that API directly to the internet. If BitChord needs a public HTTPS URL,
expose only the BitChord addon (for example, tunnel port 3000 with cloudflared),
not the hifi-api service. For a public BitChord addon, enable its official addon
authentication. External hifi-api URLs must use HTTPS; plain HTTP is allowed
only for localhost/private-network hosts.

## Plug in your own source

Edit `src/providers/custom.js` and implement two functions:

- `search(query, { quality, atmos })` returns an array of tracks
  (`id`, `title`, `artist`, `album`, `duration` in seconds, `artworkURL`, `format`, `audioQuality`).
- `resolveStream(id, { quality, atmos })` returns `{ url, codec, container, manifest, sampleRate, bitDepth, bitrate, quality }`
  or `null` when the id is not found.

Then set `PROVIDER=custom`. Use a source you are entitled to use.
`/stream` refuses non-HTTPS and encrypted streams, and returns 404 on `null`
so BitChord falls through to the next source.

Be accurate with `codec`, `sampleRate` and `bitDepth`: BitChord checks the codec it
really decodes, and a "lossless" label on a lossy URL gets no lossless badge.
For DASH/HLS manifests set `manifest: "dash"` or `"hls"`.
List quality options best first in `qualityOptions`.

## Deploy to Vercel

1. Push this folder to a Git repo and import it in Vercel (no build command needed).
2. Set env vars from `.env.example` (at least `PROVIDER` and any keys your source needs).
3. In BitChord: Settings, Sources, Add an addon, paste `https://<project>.vercel.app/manifest.json`.

## Addon auth (optional)

Off by default so you can test on BitChord desktop. To enable it:
download the official `bitchord-addon-auth.mjs` from the BitChord docs, save it unchanged as
`src/bitchord-addon-auth.mjs`, set `BITCHORD_AUTH=1` and `ADDON_HOSTS=<your hostname>`.
Only the official Android app can then use the addon. Tip: if audio URLs come from
your own storage, make them short-lived (see the docs section on media URLs).
