"""Download the live Google My Maps KML and rebuild places.json when it changes."""

from __future__ import annotations

import hashlib
import io
import json
import sys
import time
import urllib.error
import urllib.request
import zipfile
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

from convert_kml import KML_PATH, OUT_PATH, convert_kml_text, write_places  # noqa: E402

MAP_ID = "1LIB62nT_OvNPpVft2NAqyAluF5I"
KML_URL = f"https://www.google.com/maps/d/kml?mid={MAP_ID}&forcekml=1"
META_PATH = ROOT / "data" / "sync-meta.json"
USER_AGENT = "RandyGuideSync/1.0 (+local map mirror)"


def utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def read_meta() -> dict:
    if not META_PATH.exists():
        return {}
    try:
        return json.loads(META_PATH.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return {}


def write_meta(meta: dict) -> None:
    META_PATH.parent.mkdir(parents=True, exist_ok=True)
    META_PATH.write_text(json.dumps(meta, indent=2), encoding="utf-8")


def decode_kml_bytes(raw: bytes) -> str:
    """Accept raw KML or KMZ (zipped KML)."""
    if raw[:2] == b"PK":
        with zipfile.ZipFile(io.BytesIO(raw)) as zf:
            names = [n for n in zf.namelist() if n.lower().endswith(".kml")]
            if not names:
                raise ValueError("KMZ archive contained no .kml file")
            return zf.read(names[0]).decode("utf-8")
    return raw.decode("utf-8")


def fetch_kml(timeout: float = 120.0) -> tuple[str, str]:
    req = urllib.request.Request(
        KML_URL,
        headers={"User-Agent": USER_AGENT, "Accept": "*/*"},
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        raw = resp.read()
    text = decode_kml_bytes(raw)
    digest = hashlib.sha256(text.encode("utf-8")).hexdigest()
    return text, digest


def places_digest(payload: dict) -> str:
    """Hash only the place records so volatile KML markup doesn't force reloads."""
    canonical = json.dumps(payload["places"], ensure_ascii=False, separators=(",", ":"), sort_keys=True)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def sync(*, force: bool = False) -> dict:
    """
    Fetch the public My Maps KML and rebuild local data if places changed.

    Returns a status dict suitable for /api/sync-meta.
    """
    previous = read_meta()
    started = utc_now()

    try:
        kml_text, kml_digest = fetch_kml()
    except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, ValueError) as err:
        meta = {
            **previous,
            "ok": False,
            "mapId": MAP_ID,
            "sourceUrl": KML_URL,
            "lastAttemptAt": started,
            "lastError": str(err),
            "syncing": False,
        }
        write_meta(meta)
        return meta

    # Fast path: identical KML bytes and existing output
    if (
        not force
        and previous.get("kmlHash") == kml_digest
        and OUT_PATH.exists()
        and previous.get("contentHash")
    ):
        meta = {
            **previous,
            "ok": True,
            "mapId": MAP_ID,
            "sourceUrl": KML_URL,
            "lastAttemptAt": started,
            "lastCheckedAt": started,
            "changed": False,
            "lastError": None,
            "syncing": False,
        }
        write_meta(meta)
        return meta

    KML_PATH.write_text(kml_text, encoding="utf-8")
    payload = convert_kml_text(kml_text)
    content_hash = places_digest(payload)
    places_changed = previous.get("contentHash") != content_hash or not OUT_PATH.exists()

    if places_changed or force:
        write_places(payload)

    meta = {
        "ok": True,
        "mapId": MAP_ID,
        "sourceUrl": KML_URL,
        "kmlHash": kml_digest,
        "contentHash": content_hash,
        "placeCount": payload["count"],
        "lastAttemptAt": started,
        "lastCheckedAt": started,
        "lastSyncedAt": started if (places_changed or force) else previous.get("lastSyncedAt"),
        "changed": places_changed,
        "lastError": None,
        "syncing": False,
    }
    # Keep lastSyncedAt fresh on successful manual sync even when unchanged
    if force and not places_changed:
        meta["lastSyncedAt"] = started
    write_meta(meta)
    return meta


def main() -> None:
    force = "--force" in sys.argv
    print(f"Syncing from {KML_URL} …")
    t0 = time.time()
    meta = sync(force=force)
    elapsed = time.time() - t0
    if not meta.get("ok"):
        print(f"Sync failed: {meta.get('lastError')}")
        sys.exit(1)
    if meta.get("changed"):
        print(f"Updated places.json ({meta.get('placeCount')} places) in {elapsed:.1f}s")
    else:
        print(f"No changes ({meta.get('placeCount', '?')} places) in {elapsed:.1f}s")


if __name__ == "__main__":
    main()
