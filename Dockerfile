# Use the official Mornye-Python image so the real signed-session host,
# Chromium/Turnstile solver, Node runtime, FFmpeg, and TIDAL extension runtime
# are present. The BitChord Node addon and private bridge are added on top.
FROM ghcr.io/mornyeapp/mornye-python:latest

USER root
WORKDIR /app/bitchord
COPY --chown=mornye:mornye . /app/bitchord
RUN chmod 0755 /app/bitchord/entrypoint.sh \
    && mkdir -p /tmp/bitchord-mornye /tmp/mornye-data /tmp/mornye-downloads \
    && chown -R mornye:mornye /app/bitchord /tmp/bitchord-mornye /tmp/mornye-data /tmp/mornye-downloads

ENV HOME=/home/mornye \
    DISPLAY=:99 \
    PYTHONPATH=/app/bitchord:/app \
    PYTHONUNBUFFERED=1 \
    MORNYE_DATA_DIR=/tmp/mornye-data \
    MORNYE_DOWNLOAD_DIR=/tmp/mornye-downloads \
    BITCHORD_TEMP_DIR=/tmp/bitchord-mornye \
    MORNYE_REGISTRIES=https://raw.githubusercontent.com/mornyeapp/Mornye-Extension/main/registry-unified.json \
    TS_MAX_CONCURRENT_BROWSERS=1 \
    TS_BROWSER_START_TIMEOUT=75 \
    TS_BROWSER_SLOT_TIMEOUT=120 \
    MORNYE_BRIDGE_URL=http://127.0.0.1:8765 \
    PROVIDER=tidal \
    BITCHORD_AUTH=0

EXPOSE 10000
USER mornye
ENTRYPOINT ["/usr/bin/tini", "--", "/app/bitchord/entrypoint.sh"]
