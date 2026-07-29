"""Convert Randy's Guide KML into compact places JSON for the web map."""

from __future__ import annotations

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
KML_PATH = ROOT / "map.kml"
OUT_PATH = ROOT / "data" / "places.json"

# Map My Maps style ids -> filter keys used in the UI
STYLE_META = {
    "icon-503-DB4436": {
        "key": "red-pin",
        "label": "Red pin",
        "color": "#DB4436",
        "iconUrl": "icons/503-wht-blank_maps.png",
        "tint": True,
    },
    "icon-1257": {
        "key": "purple-flag",
        "label": "Purple flag",
        "color": "#9C27B0",
        "iconUrl": "icons/1257-poi-government.png",
        "tint": False,
    },
    "icon-1057": {
        "key": "yellow-eye",
        "label": "Yellow eye",
        "color": "#F9A825",
        "iconUrl": "icons/1057-biz-optometrist.png",
        "tint": False,
    },
    "icon-1085": {
        "key": "restaurant",
        "label": "Fork & knife",
        "color": "#F9A825",
        "iconUrl": "icons/1085-biz-restaurant-generic.png",
        "tint": False,
    },
    "icon-971": {
        "key": "dollar",
        "label": "Dollar",
        "color": "#F9A825",
        "iconUrl": "icons/971-biz-bank-dollar.png",
        "tint": False,
    },
    "icon-979": {
        "key": "cocktail",
        "label": "Cocktail",
        "color": "#F9A825",
        "iconUrl": "icons/979-biz-bar.png",
        "tint": False,
    },
    "icon-1899-DB4436": {
        "key": "route-pin",
        "label": "Route pin",
        "color": "#DB4436",
        "iconUrl": "icons/503-wht-blank_maps.png",
        "tint": True,
    },
}

LAYER_ORDER = [
    "Food To Eat",
    "Coffee & Tea",
    "Drinks To Drink",
    "Places To See",
    "Places to Stay",
]

NAME_RE = re.compile(r"<name>(?:<!\[CDATA\[(.*?)\]\]>|([^<]*))</name>", re.S)
DESC_RE = re.compile(r"<description>(?:<!\[CDATA\[(.*?)\]\]>|([^<]*))</description>", re.S)
STYLE_RE = re.compile(r"<styleUrl>#([^<]+)</styleUrl>")
COORDS_RE = re.compile(
    r"<Point>\s*<coordinates>\s*([^<]+?)\s*</coordinates>\s*</Point>",
    re.S,
)
PLACEMARK_RE = re.compile(r"<Placemark>(.*?)</Placemark>", re.S)


def clean_text(value: str | None) -> str:
    if not value:
        return ""
    text = value.strip()
    # Strip simple HTML leftover from My Maps descriptions
    text = re.sub(r"<br\s*/?>", "\n", text, flags=re.I)
    text = re.sub(r"<[^>]+>", "", text)
    return text.strip()


def normalize_style(style_url: str) -> str:
    style = style_url.replace("-nodesc", "")
    for suffix in ("-normal", "-highlight"):
        if style.endswith(suffix):
            style = style[: -len(suffix)]
    return style


def extract_folder_blocks(kml: str) -> list[tuple[str, str]]:
    blocks: list[tuple[str, str]] = []
    parts = re.split(r"<Folder>", kml)[1:]
    for part in parts:
        name_m = NAME_RE.search(part)
        if not name_m:
            continue
        name = clean_text(name_m.group(1) or name_m.group(2))
        # Only keep content until this folder's closing tag at this nesting level
        # Simple approach: take until first </Folder> after placemarks — nested
        # folders are rare here; cut at first </Folder>
        end = part.find("</Folder>")
        body = part if end < 0 else part[:end]
        blocks.append((name, body))
    return blocks


def parse_placemarks(layer: str, body: str) -> list[dict]:
    places: list[dict] = []
    for pm in PLACEMARK_RE.findall(body):
        coords_m = COORDS_RE.search(pm)
        if not coords_m:
            continue
        style_m = STYLE_RE.search(pm)
        if not style_m:
            continue
        style = normalize_style(style_m.group(1))
        if style.startswith("line-"):
            continue
        meta = STYLE_META.get(style)
        if not meta:
            # Unknown icon — keep under a generic bucket
            icon_key = "other"
        else:
            icon_key = meta["key"]

        name_m = NAME_RE.search(pm)
        desc_m = DESC_RE.search(pm)
        name = clean_text(name_m.group(1) or name_m.group(2)) if name_m else "Untitled"
        desc = clean_text(desc_m.group(1) or desc_m.group(2)) if desc_m else ""

        parts = [p.strip() for p in coords_m.group(1).split(",")]
        if len(parts) < 2:
            continue
        lon, lat = float(parts[0]), float(parts[1])

        places.append(
            {
                "n": name,
                "d": desc,
                "lat": round(lat, 6),
                "lng": round(lon, 6),
                "layer": layer,
                "icon": icon_key,
            }
        )
    return places


def convert_kml_text(kml: str) -> dict:
    folders = extract_folder_blocks(kml)

    places: list[dict] = []
    layer_counts: dict[str, int] = {}
    for name, body in folders:
        # Skip direction/route layers and empty untitled layers
        if name.startswith("Directions from") or name == "Untitled layer":
            continue
        parsed = parse_placemarks(name, body)
        if not parsed:
            continue
        places.extend(parsed)
        layer_counts[name] = len(parsed)

    # Stable layer list: known order first, then any extras
    layers = [l for l in LAYER_ORDER if l in layer_counts]
    for l in layer_counts:
        if l not in layers:
            layers.append(l)

    icon_counts: dict[str, int] = {}
    for p in places:
        icon_counts[p["icon"]] = icon_counts.get(p["icon"], 0) + 1

    icons = []
    seen_keys = set()
    for _style_id, meta in STYLE_META.items():
        key = meta["key"]
        if key in seen_keys:
            continue
        seen_keys.add(key)
        if key not in icon_counts:
            continue
        icons.append(
            {
                "key": key,
                "label": meta["label"],
                "color": meta["color"],
                "iconUrl": meta["iconUrl"],
                "tint": meta["tint"],
                "count": icon_counts[key],
            }
        )
    if "other" in icon_counts:
        icons.append(
            {
                "key": "other",
                "label": "Other",
                "color": "#607D8B",
                "iconUrl": "icons/503-wht-blank_maps.png",
                "tint": False,
                "count": icon_counts["other"],
            }
        )

    return {
        "title": "Randy's Guide",
        "source": "Google My Maps export",
        "count": len(places),
        "layers": [{"key": l, "label": l, "count": layer_counts[l]} for l in layers],
        "icons": icons,
        "places": places,
    }


def write_places(payload: dict) -> Path:
    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUT_PATH.write_text(
        json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    return OUT_PATH


def convert_file(kml_path: Path = KML_PATH) -> dict:
    kml = kml_path.read_text(encoding="utf-8")
    payload = convert_kml_text(kml)
    write_places(payload)
    return payload


def main() -> None:
    payload = convert_file()
    print(f"Wrote {OUT_PATH} ({payload['count']} places)")
    print("Layers:", {l["key"]: l["count"] for l in payload["layers"]})
    print("Icons:", {i["key"]: i["count"] for i in payload["icons"]})


if __name__ == "__main__":
    main()
