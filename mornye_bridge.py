"""Private in-process bridge from the BitChord addon to Mornye-Python.

Mornye-Python owns the TIDAL extension runtime, Zarz signed-session handling,
Turnstile browser handling, and segmented downloads. This bridge deliberately
uses Mornye's supported Python client rather than reimplementing the signing
protocol in Node.

Playback model: resolve starts a Mornye download job; BitChord receives a
short-lived media URL immediately. The media endpoint waits for that job to
finish, then serves the resulting audio file with HTTP Range support. This is
not live CDN streaming: it is download-then-play, with the finished file served
from the Render instance.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import os
import re
import shutil
import subprocess
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.responses import JSONResponse, Response, StreamingResponse
from pydantic import BaseModel, Field

logger = logging.getLogger("bitchord.mornye")

QUALITY_VALUES = {"HI_RES_LOSSLESS", "LOSSLESS", "HIGH", "LOW"}
REGISTRY_DEFAULT = (
    "https://raw.githubusercontent.com/mornyeapp/Mornye-Extension/main/registry-unified.json"
)
DATA_ROOT = Path(os.environ.get("BITCHORD_TEMP_DIR", "/tmp/bitchord-mornye")).resolve()
JOBS_ROOT = DATA_ROOT / "jobs"
JOB_TTL_SECONDS = max(900, int(os.environ.get("BITCHORD_MEDIA_TTL_SECONDS", "7200")))
DOWNLOAD_TIMEOUT_SECONDS = max(60, int(os.environ.get("MORNYE_DOWNLOAD_TIMEOUT_SECONDS", "900")))
MAX_TRACK_JOBS = max(1, int(os.environ.get("MORNYE_MAX_TRACK_JOBS", "2")))
INTERNAL_TOKEN = os.environ.get("INTERNAL_BRIDGE_TOKEN", "").strip()


class ResolveRequest(BaseModel):
    track_id: str = Field(min_length=1, max_length=40)
    quality: str = "LOSSLESS"


@dataclass
class Job:
    id: str
    track_id: str
    quality: str
    status: str = "queued"
    created_at: float = field(default_factory=time.time)
    started_at: float | None = None
    finished_at: float | None = None
    file_path: Path | None = None
    audio_info: dict[str, Any] = field(default_factory=dict)
    error: str | None = None
    done: asyncio.Event = field(default_factory=asyncio.Event)
    task: asyncio.Task | None = None


jobs: dict[str, Job] = {}
client: Any = None
client_lock = asyncio.Lock()
download_lock = asyncio.Semaphore(MAX_TRACK_JOBS)


class MornyeNotReady(Exception):
    pass


def _require_internal_token(authorization: str | None) -> None:
    if not INTERNAL_TOKEN:
        raise HTTPException(status_code=503, detail="Internal bridge token is not configured")
    supplied = ""
    if authorization and authorization.lower().startswith("bearer "):
        supplied = authorization[7:].strip()
    # compare_digest avoids a timing-sensitive token comparison.
    import hmac

    if not supplied or not hmac.compare_digest(supplied, INTERNAL_TOKEN):
        raise HTTPException(status_code=401, detail="Unauthorized")


def _quality(value: str) -> str:
    normalized = str(value or "LOSSLESS").strip().upper()
    if normalized not in QUALITY_VALUES:
        raise HTTPException(status_code=422, detail="Unsupported TIDAL quality")
    return normalized


def _safe_error(value: object) -> str:
    """Keep useful diagnostics without leaking URL query tokens or headers."""
    text = str(value or "Playback failed").replace("\n", " ").strip()
    text = re.sub(r"https?://\S+", "[upstream URL]", text)
    text = re.sub(r"(?i)(authorization|cookie|token|signature|secret)\s*[:=]\s*\S+", r"\1=[redacted]", text)
    return text[:500] or "Playback failed"


def _purge_old_jobs() -> None:
    now = time.time()
    stale = [job_id for job_id, item in jobs.items() if item.finished_at and now - item.finished_at > JOB_TTL_SECONDS]
    for job_id in stale:
        item = jobs.pop(job_id, None)
        if item and item.file_path:
            parent = item.file_path.parent
            try:
                shutil.rmtree(parent, ignore_errors=True)
            except Exception:
                logger.debug("Could not clean expired media directory")

    # Keep a strict cap on retained jobs/files even if a job never reaches its
    # normal expiry path. The oldest finished entries are evicted first.
    finished = sorted(
        (item for item in jobs.values() if item.finished_at),
        key=lambda item: item.finished_at or item.created_at,
    )
    while len(jobs) > 24 and finished:
        item = finished.pop(0)
        jobs.pop(item.id, None)
        if item.file_path:
            shutil.rmtree(item.file_path.parent, ignore_errors=True)


async def _get_client():
    global client
    async with client_lock:
        if client is not None:
            return client
        try:
            from mornye import AsyncMornye
        except Exception as exc:  # pragma: no cover - depends on the Docker base image
            raise MornyeNotReady("Mornye-Python is not installed in this container") from exc

        registry = os.environ.get("MORNYE_REGISTRIES", REGISTRY_DEFAULT).strip()
        registries = [part.strip() for part in registry.split(",") if part.strip()]
        output_root = Path(os.environ.get("MORNYE_DOWNLOAD_DIR", str(DATA_ROOT / "downloads")))
        output_root.mkdir(parents=True, exist_ok=True)

        instance = AsyncMornye(
            output_dir=str(output_root),
            services=["ext:tidal-web"],
            quality="LOSSLESS",
            allow_fallback=False,
            max_concurrent_downloads=MAX_TRACK_JOBS,
            registries=registries,
            sync_extensions=True,
            log_level=logging.WARNING,
        )
        try:
            await instance.__aenter__()
        except Exception:
            with contextlib.suppress(Exception):
                await instance.aclose()
            raise
        client = instance
        logger.info("Mornye client initialised; TIDAL extension will be loaded on demand")
        return client


async def _probe_audio(path: Path, result_format: str | None) -> dict[str, Any]:
    info: dict[str, Any] = {"format": (result_format or path.suffix.lstrip(".") or "unknown").lower()}
    ffprobe = shutil.which("ffprobe")
    if not ffprobe:
        return info
    try:
        process = await asyncio.create_subprocess_exec(
            ffprobe,
            "-v", "error",
            "-select_streams", "a:0",
            "-show_entries", "stream=codec_name,sample_rate,bits_per_raw_sample,bits_per_sample,bit_rate:format=duration,format_name",
            "-of", "json",
            str(path),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
        )
        stdout, _ = await asyncio.wait_for(process.communicate(), timeout=15)
        if process.returncode == 0:
            payload = json.loads(stdout.decode("utf-8", errors="replace") or "{}")
            stream = (payload.get("streams") or [{}])[0]
            fmt = payload.get("format") or {}
            codec = str(stream.get("codec_name") or "").lower()
            if codec:
                info["codec"] = codec
            if stream.get("sample_rate"):
                info["sample_rate"] = int(stream["sample_rate"])
            bit_depth = stream.get("bits_per_raw_sample") or stream.get("bits_per_sample")
            if bit_depth:
                info["bit_depth"] = int(bit_depth)
            if stream.get("bit_rate"):
                info["bitrate"] = int(stream["bit_rate"])
            elif fmt.get("bit_rate"):
                info["bitrate"] = int(fmt["bit_rate"])
            if fmt.get("duration"):
                info["duration"] = float(fmt["duration"])
            if fmt.get("format_name"):
                info["container"] = str(fmt["format_name"]).split(",")[0]
    except Exception:
        logger.debug("ffprobe could not inspect completed TIDAL audio", exc_info=True)
    return info


async def _run_job(job: Job) -> None:
    async with download_lock:
        job.status = "starting"
        job.started_at = time.time()
        output_dir = JOBS_ROOT / job.id
        output_dir.mkdir(parents=True, exist_ok=True)
        try:
            mornye = await _get_client()
            from mornye.core.config import DownloadRequest

            # AsyncMornye builds a legacy-compatible DownloadService once in
            # its constructor. That adapter reads the client's DownloadOptions
            # object when it creates the per-provider downloader; changing only
            # DownloadRequest.config would not change that legacy object. We
            # therefore apply this one-track request to the client's options
            # under download_lock, then restore them immediately afterwards.
            options = getattr(mornye, "_opts", None)
            if options is None:
                raise RuntimeError("This Mornye-Python build has no compatible download options")
            previous = {
                "output_dir": getattr(options, "output_dir", None),
                "quality": getattr(options, "quality", None),
                "services": getattr(options, "services", None),
                "allow_fallback": getattr(options, "allow_fallback", None),
                "max_concurrent_downloads": getattr(options, "max_concurrent_downloads", None),
                "track_max_retries": getattr(options, "track_max_retries", None),
            }
            try:
                options.output_dir = str(output_dir)
                options.quality = job.quality
                options.services = ["ext:tidal-web"]
                options.allow_fallback = False
                options.max_concurrent_downloads = 1
                options.track_max_retries = 0

                config = mornye.application_config()
                config.output.directory = output_dir
                config.download.quality = job.quality
                config.download.services = ["ext:tidal-web"]
                config.download.allow_fallback = False
                config.download.max_concurrent = 1
                config.download.retries = 0

                # Mornye's own provider parses this canonical URL, loads the
                # official tidal-web extension, and performs its Zarz signed
                # ticket/session workflow through Mornye's Python host runtime.
                track_url = f"https://tidal.com/browse/track/{job.track_id}"
                job.status = "downloading"
                report = await asyncio.wait_for(
                    mornye.download_request(DownloadRequest(sources=[track_url], config=config)),
                    timeout=DOWNLOAD_TIMEOUT_SECONDS,
                )
            finally:
                for key, value in previous.items():
                    if value is not None:
                        setattr(options, key, value)
            succeeded = list(getattr(report, "succeeded", []) or [])
            if not succeeded:
                failures = list(getattr(report, "failed", []) or [])
                reason = getattr(failures[0], "reason", "") if failures else "No audio file was produced"
                raise RuntimeError(_safe_error(reason))

            result = succeeded[0]
            raw_path = getattr(result, "file_path", None)
            if not raw_path:
                raise RuntimeError("Mornye reported success without an audio file path")
            path = Path(raw_path).resolve(strict=True)
            if not path.is_file() or not path.is_relative_to(output_dir.resolve()):
                raise RuntimeError("Mornye returned an unexpected audio file location")
            if path.stat().st_size <= 0:
                raise RuntimeError("Mornye produced an empty audio file")

            job.file_path = path
            job.audio_info = await _probe_audio(path, getattr(result, "format", None))
            job.status = "ready"
            logger.info("Mornye produced media job %s (%s bytes)", job.id, path.stat().st_size)
        except asyncio.TimeoutError:
            job.status = "failed"
            job.error = f"Mornye playback exceeded {DOWNLOAD_TIMEOUT_SECONDS} seconds"
        except Exception as exc:
            job.status = "failed"
            job.error = _safe_error(exc)
            logger.warning("Mornye playback job failed: %s", job.error)
        finally:
            job.finished_at = time.time()
            if job.status != "ready":
                shutil.rmtree(output_dir, ignore_errors=True)
            job.done.set()
            _purge_old_jobs()


app = FastAPI(title="Private BitChord Mornye bridge", docs_url=None, redoc_url=None)


@app.get("/health")
async def health():
    active = sum(1 for item in jobs.values() if item.status in {"queued", "starting", "downloading"})
    last = max(jobs.values(), key=lambda item: item.created_at, default=None)
    return {
        "ok": True,
        "mornye_client_ready": client is not None,
        "active_jobs": active,
        "last_job": _job_summary(last) if last else None,
        "storage": "ephemeral-container-filesystem",
    }


def _job_summary(item: Job | None) -> dict[str, Any] | None:
    if item is None:
        return None
    return {
        "id": item.id,
        "track_id": item.track_id,
        "quality": item.quality,
        "status": item.status,
        "created_at": item.created_at,
        "started_at": item.started_at,
        "finished_at": item.finished_at,
        "error": item.error,
        "audio": item.audio_info if item.status == "ready" else None,
    }


@app.post("/resolve", status_code=202)
async def resolve(payload: ResolveRequest, authorization: str | None = Header(default=None)):
    _require_internal_token(authorization)
    track_id = str(payload.track_id).strip().removeprefix("tidal:")
    if not track_id.isdigit():
        raise HTTPException(status_code=422, detail="track_id must be a numeric TIDAL ID")
    quality = _quality(payload.quality)
    _purge_old_jobs()

    # Avoid duplicate concurrent work for the same track+quality. A recent
    # ready job can be reused, saving time and upstream requests.
    for existing in jobs.values():
        if existing.track_id == track_id and existing.quality == quality and existing.status in {"queued", "starting", "downloading", "ready"}:
            return {"job_id": existing.id, "status": existing.status, "audio": existing.audio_info or None}

    active = sum(1 for item in jobs.values() if item.status in {"queued", "starting", "downloading"})
    if active >= MAX_TRACK_JOBS:
        raise HTTPException(status_code=429, detail="The personal playback service is busy")

    job = Job(id=uuid.uuid4().hex, track_id=track_id, quality=quality)
    jobs[job.id] = job
    job.task = asyncio.create_task(_run_job(job), name=f"mornye-track-{job.id}")
    return {"job_id": job.id, "status": job.status}


@app.get("/jobs/{job_id}")
async def get_job(job_id: str, authorization: str | None = Header(default=None)):
    _require_internal_token(authorization)
    job = jobs.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Playback job not found")
    return _job_summary(job)


def _range_for_file(header: str | None, size: int) -> tuple[int, int, bool]:
    if not header:
        return 0, max(0, size - 1), False
    if not header.startswith("bytes=") or "," in header:
        raise HTTPException(status_code=416, detail="Only one byte range is supported", headers={"Content-Range": f"bytes */{size}"})
    value = header[6:].strip()
    match = re.fullmatch(r"(\d*)-(\d*)", value)
    if not match or (not match.group(1) and not match.group(2)):
        raise HTTPException(status_code=416, detail="Invalid byte range", headers={"Content-Range": f"bytes */{size}"})
    first, last = match.groups()
    if not first:
        suffix = int(last)
        if suffix <= 0:
            raise HTTPException(status_code=416, detail="Invalid byte range", headers={"Content-Range": f"bytes */{size}"})
        start = max(0, size - suffix)
        end = size - 1
    else:
        start = int(first)
        end = int(last) if last else size - 1
    if start >= size or end < start:
        raise HTTPException(status_code=416, detail="Range not satisfiable", headers={"Content-Range": f"bytes */{size}"})
    return start, min(end, size - 1), True


def _file_chunks(path: Path, start: int, length: int, chunk_size: int = 128 * 1024):
    with path.open("rb") as handle:
        handle.seek(start)
        remaining = length
        while remaining > 0:
            chunk = handle.read(min(chunk_size, remaining))
            if not chunk:
                break
            remaining -= len(chunk)
            yield chunk


@app.api_route("/media/{job_id}", methods=["GET", "HEAD"])
async def media(job_id: str, request: Request, authorization: str | None = Header(default=None)):
    _require_internal_token(authorization)
    job = jobs.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Media job not found or expired")

    if job.status not in {"ready", "failed"}:
        try:
            await asyncio.wait_for(job.done.wait(), timeout=DOWNLOAD_TIMEOUT_SECONDS + 30)
        except asyncio.TimeoutError:
            raise HTTPException(status_code=504, detail="Playback job did not finish in time")

    if job.status != "ready" or not job.file_path:
        raise HTTPException(status_code=502, detail=job.error or "Mornye could not prepare this track")

    path = job.file_path
    size = path.stat().st_size
    start, end, partial = _range_for_file(request.headers.get("range"), size)
    length = end - start + 1
    suffix = path.suffix.lower()
    mime = {
        ".flac": "audio/flac",
        ".mp3": "audio/mpeg",
        ".m4a": "audio/mp4",
        ".mp4": "audio/mp4",
        ".wav": "audio/wav",
        ".opus": "audio/ogg",
        ".ogg": "audio/ogg",
        ".aiff": "audio/aiff",
    }.get(suffix, "application/octet-stream")
    headers = {
        "Accept-Ranges": "bytes",
        "Content-Length": str(length),
        "Content-Type": mime,
        "Content-Disposition": f'inline; filename="tidal-{job.track_id}{suffix}"',
        "Cache-Control": "private, no-store",
        "X-Audio-Codec": str(job.audio_info.get("codec") or ""),
        "X-Audio-Sample-Rate": str(job.audio_info.get("sample_rate") or ""),
        "X-Audio-Bit-Depth": str(job.audio_info.get("bit_depth") or ""),
    }
    status = 206 if partial else 200
    if partial:
        headers["Content-Range"] = f"bytes {start}-{end}/{size}"
    if request.method == "HEAD":
        return Response(content=b"", status_code=status, headers=headers)
    return StreamingResponse(_file_chunks(path, start, length), status_code=status, headers=headers, media_type=None)


@app.on_event("shutdown")
async def shutdown():
    global client
    if client is not None:
        try:
            await client.aclose()
        except Exception:
            logger.debug("Mornye client shutdown failed", exc_info=True)
        client = None
    for item in list(jobs.values()):
        if item.task and not item.task.done():
            item.task.cancel()
    await asyncio.gather(*(item.task for item in jobs.values() if item.task), return_exceptions=True)
