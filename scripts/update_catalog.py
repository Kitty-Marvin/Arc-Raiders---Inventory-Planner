#!/usr/bin/env python3
"""Fetch and cache ARC Raiders item metadata for GitHub Pages; standard library only.

Run via .github/workflows/update-catalog.yml, NOT from each visitor's browser.
Attribution: https://metaforge.app/arc-raiders
"""
import argparse
import json
import os
import pathlib
import sys
import time
import urllib.request
from datetime import datetime, timezone

ROOT = pathlib.Path(__file__).resolve().parents[1]
HEADERS = {"User-Agent": "ArcInventoryPlanner/3.0 (noncommercial cached catalog)", "Accept": "application/json"}


def request_json(url):
    req = urllib.request.Request(url, headers=HEADERS)
    with urllib.request.urlopen(req, timeout=24) as response:
        body = response.read(16 * 1024 * 1024 + 1)
    if len(body) > 16 * 1024 * 1024:
        raise RuntimeError("API response too large")
    return json.loads(body)


def txt(obj, *keys):
    for key in keys:
        value = obj.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return ""


def get_image(obj, provider):
    value = txt(obj, "image", "image_url", "imageUrl", "icon_url", "iconUrl", "icon", "thumbnail", "icon_path", "image_path")
    if not value:
        images = obj.get("images")
        if isinstance(images, dict):
            value = txt(images, "url", "src", "icon", "image")
        if isinstance(images, list):
            for row in images:
                value = row if isinstance(row, str) else txt(row, "url", "src", "path") if isinstance(row, dict) else ""
                if value:
                    break
    if value.startswith("https://"):
        return value[:700]
    if value.startswith("//"):
        return "https:" + value[:694]
    if value.startswith("http://") or not value:
        return ""
    return ("https://ardb.app/static/" if provider == "ardb" else "https://static.metaforge.app/") + value.lstrip("/")[:600]


def normalize(raw, provider):
    if not isinstance(raw, dict):
        return None
    name = txt(raw, "name", "title", "display_name", "displayName")
    if not name:
        return None
    slug = str(raw.get("id") or raw.get("slug") or name.lower().replace(" ", "-"))
    stats = raw.get("stat_block") or raw.get("statBlock") or raw.get("stats") or {}
    if not isinstance(stats, dict):
        stats = {}
    count = raw.get("stack_size", raw.get("stackSize", stats.get("stack_size", stats.get("stackSize", 0))))
    value = raw.get("value", raw.get("base_value", 0))
    try:
        count = max(0, min(9999, int(count or 0)))
    except (TypeError, ValueError):
        count = 0
    try:
        value = float(value or 0)
    except (TypeError, ValueError):
        value = 0
    return {"id": provider + ":" + slug[:150], "name": name[:180], "nameRu": txt(raw, "name_ru", "nameRu")[:180],
            "category": txt(raw, "item_type", "itemType", "category", "type")[:100] or "Предмет",
            "rarity": txt(raw, "rarity")[:60], "image": get_image(raw, provider),
            "stackMax": count, "value": value, "source": provider, "slug": slug[:150]}


def find_list(payload):
    if isinstance(payload, list):
        return payload
    if not isinstance(payload, dict):
        raise ValueError("Invalid data type")
    for outer in (payload, payload.get("data")):
        if isinstance(outer, list):
            return outer
        if isinstance(outer, dict):
            for k in ("items", "data", "results"):
                rows = outer.get(k)
                if isinstance(rows, list):
                    return rows
    raise ValueError("API did not contain list of items")


def fetch_metaforge():
    items, seen = [], set()
    for page in range(1, 31):
        payload = request_json(f"https://metaforge.app/api/arc-raiders/items?page={page}&limit=100")
        rows = find_list(payload)
        for row in rows:
            item = normalize(row, "metaforge")
            if item and item["id"] not in seen:
                items.append(item)
                seen.add(item["id"])
        pg = payload.get("pagination", {}) if isinstance(payload, dict) else {}
        if not rows:
            break
        if isinstance(pg, dict) and isinstance(pg.get("hasNextPage"), bool):
            if not pg["hasNextPage"]:
                break
        elif isinstance(pg, dict) and pg.get("totalPages") is not None:
            if page >= int(pg["totalPages"]):
                break
        elif len(rows) < 100:
            break
        time.sleep(0.3)
    if not items:
        raise RuntimeError("MetaForge returned no items. Existing catalog was kept.")
    return items


def fetch_ardb():
    payload = request_json("https://ardb.app/api/items")
    rows = find_list(payload)
    items = [item for row in rows if (item := normalize(row, "ardb"))]
    if not items:
        raise RuntimeError("ARDB returned no items. Existing catalog was kept.")
    return items



def get_verified_russian_names():
    """Read verified translations from sparse-checkout of ARC Tracker item files."""
    directory = ROOT / "external" / "arcraiders-data" / "items"
    if not directory.is_dir():
        raise RuntimeError("ARC Tracker translation folder is unavailable")
    names = {}
    for path in directory.glob("*.json"):
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            label = data.get("name") or {}
            en = label.get("en", "") if isinstance(label, dict) else ""
            ru = label.get("ru", "") if isinstance(label, dict) else ""
            if en and ru:
                names[en.strip().casefold()] = ru.strip()
        except Exception:
            continue
    if not names:
        raise RuntimeError("No validated Russian names in ARC Tracker")
    return names


def enhance(items, translations):
    for item in items:
        if translations:
            ru = translations.get(item["name"].strip().casefold())
            if ru:
                item["nameRu"] = ru[:180]
        if item.get("category", "").lower() == "blueprint" or item["name"].lower().endswith(" blueprint"):
            item["rarity"] = ""
    return items


def update(source, items):
    out = ROOT / "catalog" / f"{source}.json"
    data = {"source": source, "updatedAt": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC"), "items": items}
    tmp = out.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    os.replace(tmp, out)
    print(f"{source}: saved {len(items)} items ({out.stat().st_size} bytes)")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", choices=("metaforge", "ardb", "all"), default="all")
    args = parser.parse_args()
    success = False
    try:
        translations = get_verified_russian_names()
        print(f"Verified Russian names: {len(translations)}")
    except Exception as exc:
        print("Warning: localization unavailable: " + str(exc), file=sys.stderr)
        translations = None
    if args.source in ("metaforge", "all"):
        try:
            update("metaforge", enhance(fetch_metaforge(), translations))
            success = True
        except Exception as exc:
            if args.source == "metaforge":
                raise
            print("Warning: MetaForge unavailable, existing cache kept: " + str(exc), file=sys.stderr)
    if args.source in ("ardb", "all"):
        try:
            update("ardb", enhance(fetch_ardb(), translations))
            success = True
        except Exception as exc:
            if args.source == "ardb":
                raise
            print("Warning: ARDB unavailable, existing cache kept: " + str(exc), file=sys.stderr)
    if not success:
        raise RuntimeError("Both APIs unavailable; cached catalogs left unchanged")


if __name__ == "__main__":
    main()
