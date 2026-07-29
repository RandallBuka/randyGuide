"""Serve Randy's Guide and periodically sync from Google My Maps."""

from __future__ import annotations

import argparse
import json
import sys
import threading
import time
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT / "scripts"))

from sync_mymaps import META_PATH, read_meta, sync, write_meta  # noqa: E402

DEFAULT_PORT = 8080
DEFAULT_INTERVAL_SEC = 5 * 60  # check My Maps every 5 minutes


class SyncState:
    def __init__(self, interval_sec: int):
        self.interval_sec = interval_sec
        self.lock = threading.Lock()
        self.running = False
        self.stop_event = threading.Event()

    def get_meta(self) -> dict:
        meta = read_meta()
        meta.setdefault("pollIntervalSec", self.interval_sec)
        meta["syncing"] = self.running
        return meta

    def run_sync(self, *, force: bool = False) -> dict:
        with self.lock:
            if self.running:
                meta = self.get_meta()
                meta["ok"] = True
                meta["message"] = "Sync already in progress"
                return meta
            self.running = True
            write_meta({**read_meta(), "syncing": True})

        try:
            print(f"[{time.strftime('%H:%M:%S')}] Syncing from Google My Maps…")
            meta = sync(force=force)
            if meta.get("changed"):
                print(
                    f"[{time.strftime('%H:%M:%S')}] Updated "
                    f"({meta.get('placeCount')} places)"
                )
            elif meta.get("ok"):
                print(f"[{time.strftime('%H:%M:%S')}] No changes")
            else:
                print(f"[{time.strftime('%H:%M:%S')}] Sync error: {meta.get('lastError')}")
            return meta
        finally:
            self.running = False

    def loop(self) -> None:
        # Immediate sync on startup so the mirror is fresh
        self.run_sync(force=False)
        while not self.stop_event.wait(self.interval_sec):
            self.run_sync(force=False)


class GuideHandler(SimpleHTTPRequestHandler):
    sync_state: SyncState
    extensions_map = {
        **SimpleHTTPRequestHandler.extensions_map,
        ".webmanifest": "application/manifest+json",
        ".js": "text/javascript",
    }

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def end_headers(self) -> None:
        # Helpful for LAN/mobile testing of the PWA
        if self.path.startswith("/api/") or self.path.startswith("/data/"):
            self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, fmt: str, *args) -> None:
        # Quieter logs: skip static asset noise
        path = args[0] if args else ""
        if isinstance(path, str) and (
            path.startswith("GET /icons/")
            or path.startswith("GET /data/")
            or "leaflet" in path
        ):
            return
        super().log_message(fmt, *args)

    def _send_json(self, payload: dict, status: int = 200) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:  # noqa: N802
        path = urlparse(self.path).path
        if path in ("/api/sync-meta", "/api/meta"):
            self._send_json(self.sync_state.get_meta())
            return
        super().do_GET()

    def do_POST(self) -> None:  # noqa: N802
        path = urlparse(self.path).path
        if path == "/api/sync":
            meta = self.sync_state.run_sync(force=True)
            status = 200 if meta.get("ok") else 502
            self._send_json(meta, status=status)
            return
        self.send_error(404, "Not found")


def main() -> None:
    parser = argparse.ArgumentParser(description="Randy's Guide server with My Maps sync")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    parser.add_argument(
        "--host",
        default="0.0.0.0",
        help="Bind address (default: 0.0.0.0 so phones on Wi‑Fi can connect)",
    )
    parser.add_argument(
        "--interval",
        type=int,
        default=DEFAULT_INTERVAL_SEC,
        help="Seconds between automatic My Maps checks (default: 300)",
    )
    parser.add_argument(
        "--no-autosync",
        action="store_true",
        help="Serve files only; do not poll Google My Maps",
    )
    args = parser.parse_args()

    state = SyncState(interval_sec=max(60, args.interval))
    GuideHandler.sync_state = state

    if not args.no_autosync:
        thread = threading.Thread(target=state.loop, name="mymaps-sync", daemon=True)
        thread.start()
    elif not META_PATH.exists():
        write_meta(
            {
                "ok": True,
                "message": "Autosync disabled",
                "pollIntervalSec": state.interval_sec,
                "syncing": False,
            }
        )

    server = ThreadingHTTPServer((args.host, args.port), GuideHandler)
    print(f"Randy's Guide: http://127.0.0.1:{args.port}")
    if args.host in ("0.0.0.0", "::"):
        print(f"On your phone (same Wi-Fi): http://<this-pc-lan-ip>:{args.port}")
    if args.no_autosync:
        print("Autosync: off")
    else:
        print(f"Autosync: every {state.interval_sec}s from Google My Maps")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down…")
        state.stop_event.set()
        server.server_close()


if __name__ == "__main__":
    main()
