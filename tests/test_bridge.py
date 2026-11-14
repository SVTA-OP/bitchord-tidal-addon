"""Offline tests for the private Mornye media bridge.

These tests do not contact TIDAL, Zarz, or Render. They exercise the local
bridge's access control and completed-file HTTP delivery behaviour.
"""

from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path

os.environ.setdefault("INTERNAL_BRIDGE_TOKEN", "test-internal-bridge-token-0123456789")

import mornye_bridge as bridge  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402


class BridgeHttpTests(unittest.TestCase):
    def setUp(self) -> None:
        self.client = TestClient(bridge.app)
        self.temp_dir = tempfile.TemporaryDirectory(prefix="bitchord-bridge-test-")
        self.file_path = Path(self.temp_dir.name) / "sample.flac"
        self.file_path.write_bytes(b"0123456789abcdef")
        self.job_id = "f" * 32
        job = bridge.Job(
            id=self.job_id,
            track_id="123456",
            quality="LOSSLESS",
            status="ready",
            file_path=self.file_path,
            audio_info={"codec": "flac", "sample_rate": 44100, "bit_depth": 16},
        )
        job.done.set()
        bridge.jobs[self.job_id] = job

    def tearDown(self) -> None:
        bridge.jobs.pop(self.job_id, None)
        self.temp_dir.cleanup()

    def auth(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {bridge.INTERNAL_TOKEN}"}

    def test_health_is_internal_status_only(self) -> None:
        response = self.client.get("/health")
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.json()["ok"])

    def test_resolve_requires_internal_bearer(self) -> None:
        response = self.client.post("/resolve", json={"track_id": "123456", "quality": "LOSSLESS"})
        self.assertEqual(response.status_code, 401)

    def test_media_requires_internal_bearer(self) -> None:
        response = self.client.get(f"/media/{self.job_id}")
        self.assertEqual(response.status_code, 401)

    def test_media_serves_byte_ranges(self) -> None:
        response = self.client.get(
            f"/media/{self.job_id}",
            headers={**self.auth(), "Range": "bytes=2-5"},
        )
        self.assertEqual(response.status_code, 206)
        self.assertEqual(response.content, b"2345")
        self.assertEqual(response.headers["content-range"], "bytes 2-5/16")
        self.assertEqual(response.headers["content-type"], "audio/flac")

    def test_media_serves_full_file_and_head(self) -> None:
        response = self.client.get(f"/media/{self.job_id}", headers=self.auth())
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.content, b"0123456789abcdef")
        self.assertEqual(response.headers["accept-ranges"], "bytes")

        head = self.client.head(f"/media/{self.job_id}", headers=self.auth())
        self.assertEqual(head.status_code, 200)
        self.assertEqual(head.content, b"")
        self.assertEqual(head.headers["content-length"], "16")


if __name__ == "__main__":
    unittest.main()
