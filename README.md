# Personal BitChord TIDAL addon — Mornye backend

This is an upgraded version of the original BitChord addon. It keeps the
working TIDAL public-catalog search adapter and adds a private bridge to the
official Mornye-Python runtime.

## Important: how playback works

This build does **not** reimplement Zarz HMAC signing in Node. It runs on top of
the official `ghcr.io/mornyeapp/mornye-python` image and uses Mornye's own
`AsyncMornye` client and the official `tidal-web` extension. Mornye-Python owns
the signed-session/bootstrap/refresh and browser-challenge workflow.

The playback path is **download-then-play**, not direct CDN streaming:

1. BitChord calls the addon's `/stream/{id}` route.
2. The addon asks the local Mornye bridge to start a TIDAL download.
3. The addon immediately returns a private, time-limited media URL.
4. When BitChord requests that URL, the media endpoint waits for Mornye to
   finish preparing the file, then serves it with HTTP byte-range support.

This means the first play can take noticeably longer than a normal stream,
particularly on the first request or when the Zarz gateway asks Mornye to solve
a browser challenge. A track has to finish downloading before the media body
is sent. If BitChord gives up waiting for the first audio bytes, this approach
will not be suitable for that client; a true live stream resolver would require
a separate supported interface that the current Mornye-Python client does not
expose.

No DRM decryption is added. The Mornye/TIDAL extension and host must produce a
usable audio file through their supported flow.

## Private-use security model

This is intended for one person, not as a public shared service.

- `ADDON_PATH_SECRET` creates an unguessable URL prefix. The manifest, search,
  stream and admin paths are below that prefix.
- `MEDIA_URL_SECRET` signs short-lived media URLs. The audio player fetches a
  separate media URL, so that URL uses HMAC instead of an addon authorization
  header.
- `INTERNAL_BRIDGE_TOKEN` protects Node-to-Python bridge requests. The Python
  bridge listens only on `127.0.0.1`, not on Render's public interface.
- `ADMIN_PASSWORD` protects the status dashboard with HTTP Basic Auth.
- The TIDAL session is managed by Mornye-Python and stored using Mornye's
  encrypted session/storage mechanism under `/tmp/mornye-data`. This path is
  ephemeral: after a container replacement or redeploy, expect to authenticate
  again. It is not stored in GitHub or exposed by the addon API.

The secret path is a bearer secret, not a device identity check. Anyone who
obtains the full manifest URL can use the addon until you rotate the path
secret. Do not post it publicly or commit it to Git.

The private dashboard is a status page, **not** a TIDAL password form and not a
manual CAPTCHA page. Mornye-Python's host performs its supported Turnstile and
signed-session flow. The dashboard shows whether the bridge is initialised and
the latest playback job/error. If Mornye's automated verification fails, the
job fails and the reason appears there; this implementation does not promise a
manual browser hand-off.

## Deploy on Render

The current Render deployment was created as a Node service. This upgraded
build needs the Mornye-Python Docker image, Chromium, FFmpeg, Python and Node.
Create a **new Docker Web Service** from this repository rather than replacing
the working Node deployment immediately. Keep the old service as a fallback
until the Docker build, status page and playback test succeed.

1. Put the contents of this folder at the root of a GitHub repository and push
   them to the default branch. The root must contain `Dockerfile`,
   `entrypoint.sh`, `mornye_bridge.py`, `package.json` and `src/`.
2. In Render, choose **New → Web Service**, connect that repository, and select
   **Docker** as the runtime. Leave the Dockerfile path as `./Dockerfile`.
3. Set the health check path to `/healthz`.
4. Use one instance. Do not scale this service horizontally: the playback job
   table and signed media URLs are held in the process/container.
5. Add the environment variables below. Render supplies `PORT` automatically;
   do not hard-code it.
6. Deploy. The server binds its public Node listener to `0.0.0.0:$PORT`; the
   Python Mornye bridge stays on `127.0.0.1:8765`.
7. After deployment, open the private dashboard at
   `https://YOUR-NEW-SERVICE.onrender.com/YOUR_ADDON_PATH_SECRET/admin` and sign
   in with the admin username/password.
8. Add the manifest URL to BitChord:
   `https://YOUR-NEW-SERVICE.onrender.com/YOUR_ADDON_PATH_SECRET/manifest.json`

### Generate three independent secrets

Run these commands locally three separate times:

```bash
openssl rand -hex 32
openssl rand -hex 32
openssl rand -hex 32
```

Use the outputs for `ADDON_PATH_SECRET`, `MEDIA_URL_SECRET` and
`INTERNAL_BRIDGE_TOKEN`, respectively. Generate a separate long password for
`ADMIN_PASSWORD` (at least 16 characters). Do not use the same value for more
than one setting.

### Required Render environment variables

| Variable | Value |
|---|---|
| `ADDON_PATH_SECRET` | First random 64-character hex string |
| `MEDIA_URL_SECRET` | Second random 64-character hex string |
| `INTERNAL_BRIDGE_TOKEN` | Third random 64-character hex string |
| `ADMIN_USERNAME` | `admin` (or another username) |
| `ADMIN_PASSWORD` | A unique password, at least 16 characters |
| `ADDON_ID` | `personal.bitchord.tidal.mornye` |
| `ADDON_NAME` | `Personal TIDAL (Mornye)` |
| `BITCHORD_AUTH` | `0` (the random private URL prefix is the addon access secret) |
| `PROVIDER` | `tidal` |
| `TIDAL_COUNTRY_CODE` | `IN` |
| `TIDAL_LOCALE` | `en_US` |
| `TIDAL_DEVICE_TYPE` | `BROWSER` |
| `MORNYE_REGISTRIES` | `https://raw.githubusercontent.com/mornyeapp/Mornye-Extension/main/registry-unified.json` |
| `MORNYE_BRIDGE_URL` | `http://127.0.0.1:8765` |
| `MORNYE_DATA_DIR` | `/tmp/mornye-data` |
| `MORNYE_DOWNLOAD_DIR` | `/tmp/mornye-downloads` |
| `BITCHORD_TEMP_DIR` | `/tmp/bitchord-mornye` |
| `MORNYE_DOWNLOAD_TIMEOUT_SECONDS` | `900` |
| `MORNYE_MAX_TRACK_JOBS` | `1` |
| `BITCHORD_MEDIA_TTL_SECONDS` | `7200` |
| `MEDIA_URL_TTL_SECONDS` | `3600` |
| `TS_MAX_CONCURRENT_BROWSERS` | `1` |
| `TS_BROWSER_START_TIMEOUT` | `75` |
| `TS_BROWSER_SLOT_TIMEOUT` | `120` |

`TIDAL_PUBLIC_TOKEN` is optional; the adapter has a public default. You can set
it to `49YxDN9a2aFV6RTG` explicitly if desired. `PORT` is supplied by Render.
Do not set `TIDAL_HIFI_API_URL`: this build uses the Mornye bridge instead.

### Render plan / resource notes

The official Mornye Docker image includes the browser and audio tools used by
its signed-session runtime. Mornye's own Docker guide says the Turnstile browser
can consume a few hundred MB of RAM and recommends a 1 GB shared-memory area
for Docker. Render's Free instance has 512 MB RAM, so it may run out of memory
when a challenge browser starts. Try it only as a smoke test; a 2 GB instance
is a more realistic target for this combined Node + Python + Chromium service.
Mornye's Compose guide also recommends `shm_size: 1gb` for Chromium. Render's
standard Docker Web Service configuration does not document a Compose-style
`shm_size` setting, so the browser challenge solver still needs a real Render
test. If Chromium exits with shared-memory errors, a larger RAM plan alone may
not fix it; we may need a Docker host that lets us size `/dev/shm`.

Render web services have an ephemeral filesystem by default. That is
intentional here: session state and temporary audio files are kept under `/tmp`
and do not survive a replacement/redeploy. No Render persistent disk is
required for this first personal-use version.

## Test locally (Node portion)

The Node addon unit tests do not contact TIDAL or Zarz:

```bash
npm test
python -m unittest discover -s tests -v
```

These offline tests check the Node addon routes and the bridge's private
HTTP/range-delivery behaviour. They do not contact TIDAL or Zarz.

To run the complete service locally, use the official Mornye-Python Docker
image and the supplied Dockerfile. The normal Node-only `npm start` command is
not enough by itself because the Python Mornye bridge must also be running.

## Verify deployment

- Health check: `https://YOUR-NEW-SERVICE.onrender.com/healthz`
- Manifest: `https://YOUR-NEW-SERVICE.onrender.com/YOUR_ADDON_PATH_SECRET/manifest.json`
- Status page: `https://YOUR-NEW-SERVICE.onrender.com/YOUR_ADDON_PATH_SECRET/admin`
- Search: use BitChord or test `.../YOUR_ADDON_PATH_SECRET/search?q=Daft%20Punk`

The first TIDAL playback may take longer because the Python extension runtime may
need to initialise/install its extension before it can resolve a track. The
status page refreshes automatically every 15 seconds and shows the most recent
job state.

## Troubleshooting

- **Docker image fails to pull:** check that Render can pull
  `ghcr.io/mornyeapp/mornye-python:latest`.
- **Out of memory:** reduce concurrent jobs/browsers to `1`, or move to a larger
  Render plan. The Chromium challenge solver is memory-intensive.
- **Mornye extension unavailable:** inspect Render logs for registry/package
  errors. Confirm `MORNYE_REGISTRIES` points to the `registry-unified.json`
  catalog.
- **No audio file produced:** open the dashboard, inspect the last job error,
  then inspect Render logs. A TIDAL account, regional, subscription or upstream
  service restriction may prevent the extension from resolving a track.
- **Media URL expires:** press Play again; the addon obtains a fresh short-lived
  media URL and can reuse a finished file while its in-memory job record exists.
- **After redeploy:** reopen the dashboard and try playback; Mornye may need to
  initialise its signed-session state again.

## Important limitations

1. The media URL points back to your Render service. BitChord receives it
   immediately, but the first byte is not served until the Mornye download has
   completed.
2. Job and media metadata are in memory. Container restart/redeploy clears the
   job table and media URLs.
3. The Mornye extension's own signed-session/verification implementation is
   upstream code. This project calls the Mornye-Python API rather than copying
   or independently implementing Zarz cryptography.
4. This is an unofficial personal integration. It is not endorsed by TIDAL,
   BitChord or Mornye, and compatibility can change as upstream services or
   extension requirements change.
