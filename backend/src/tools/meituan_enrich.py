"""补全 POI 的美团侧演示字段。

高德负责真实地点，美团补全层负责为 Demo 推断人均、排队、预约等本地生活字段。
"""

from __future__ import annotations

import hashlib
import json
import os
import random
from pathlib import Path
from typing import Any, Dict, Iterable, Optional, Tuple

from ..state import POI

PROJECT_ROOT = Path(__file__).resolve().parents[2]
OVERRIDES_PATH = PROJECT_ROOT / "data" / "meituan_overrides.json"


def _seed_key(*parts: Any) -> int:
    raw = "|".join(str(part or "") for part in (*parts, os.getenv("DEMO_SEED", "")))
    return int(hashlib.sha256(raw.encode("utf-8")).hexdigest()[:12], 16)


def _rng(*parts: Any) -> random.Random:
    return random.Random(_seed_key(*parts))


def _text(poi: POI) -> str:
    tags = " ".join(str(t) for t in poi.get("tags", []))
    return f"{poi.get('name', '')} {poi.get('category', '')} {tags}"


def _has_any(text: str, words: Iterable[str]) -> bool:
    return any(word in text for word in words)


def _safe_float(value: Any) -> Optional[float]:
    try:
        if value in (None, ""):
            return None
        return float(value)
    except (TypeError, ValueError):
        return None


def _price_band(text: str) -> Tuple[int, int]:
    if _has_any(text, ("轻食", "沙拉", "健康餐", "咖啡", "茶饮")):
        return 45, 90
    if _has_any(text, ("亲子餐厅", "儿童餐厅")):
        return 90, 140
    if _has_any(text, ("日料", "居酒屋", "西餐", "烤肉", "火锅")):
        return 150, 260
    if _has_any(text, ("餐厅", "美食", "中餐", "川菜", "小馆", "菜馆")):
        return 80, 160
    if _has_any(text, ("乐园", "游乐场", "亲子", "展览", "博物馆", "科技馆")):
        return 60, 180
    if _has_any(text, ("公园", "citywalk", "街区", "小吃街")):
        return 0, 60
    return 40, 120


def _infer_price(poi: POI, rng: random.Random) -> Optional[float]:
    current = _safe_float(poi.get("price_per_person"))
    if current is not None:
        return round(current, 1)

    text = _text(poi)
    low, high = _price_band(text)
    if high <= 0:
        return None
    if low == 0 and _has_any(text, ("公园", "citywalk", "街区")):
        return None
    return float(rng.randint(low, high))


def _infer_needs_reservation(poi: POI) -> bool:
    if "needs_reservation" in poi:
        return bool(poi.get("needs_reservation"))
    text = _text(poi)
    if _has_any(text, ("餐厅", "美食", "亲子餐厅", "展览", "乐园", "游乐场")):
        return True
    return False


def _is_peak_time(time_hint: str) -> bool:
    return any(token in time_hint for token in ("17:", "18:", "19:", "晚餐"))


def _infer_queue(poi: POI, rng: random.Random, time_hint: str) -> Optional[int]:
    current = poi.get("queue_minutes")
    if current not in (None, ""):
        try:
            return int(current)
        except (TypeError, ValueError):
            pass

    text = _text(poi)
    if not _infer_needs_reservation(poi):
        return None

    if _has_any(text, ("轻食", "沙拉", "健康餐", "咖啡")):
        base = rng.randint(3, 15)
    elif _has_any(text, ("日料", "火锅", "烤肉", "网红", "热门", "包厢")):
        base = rng.randint(20, 45)
    elif _has_any(text, ("餐厅", "美食", "小馆")):
        base = rng.randint(10, 35)
    elif _has_any(text, ("展览", "乐园", "游乐场", "亲子")):
        base = rng.randint(5, 20)
    else:
        base = rng.randint(0, 15)

    if _is_peak_time(time_hint):
        base += rng.randint(8, 18)
    return min(base, 60)


def _infer_rating(poi: POI, rng: random.Random) -> float:
    current = _safe_float(poi.get("rating"))
    if current and current > 0:
        return round(current, 1)
    return round(rng.uniform(4.2, 4.9), 1)


def _infer_tags(poi: POI, scene: str) -> Tuple[list[str], list[str]]:
    tags = list(dict.fromkeys(str(t) for t in poi.get("tags", []) if t))
    suitable = list(dict.fromkeys(str(t) for t in poi.get("suitable_for", []) if t))
    text = _text(poi)

    rules = [
        (("亲子", "儿童", "乐园", "科技馆", "博物馆"), ("亲子", "室内"), ("孩子", "家庭")),
        (("轻食", "沙拉", "健康餐"), ("低卡", "轻食"), ("减肥", "家庭")),
        (("展览", "艺术", "文化"), ("展览", "拍照"), ("朋友", "情侣")),
        (("公园", "街区", "citywalk"), ("散步", "拍照"), ("朋友", "情侣", "家庭")),
        (("宠物", "露营"), ("宠物友好",), ("宠物",)),
        (("自习", "图书馆", "书店", "咖啡"), ("安静",), ("独处", "学习")),
    ]
    for words, add_tags, add_suitable in rules:
        if _has_any(text, words):
            tags.extend(add_tags)
            suitable.extend(add_suitable)

    scene_suitable = {
        "family": ["孩子", "家庭"],
        "friends": ["朋友"],
        "couple": ["情侣"],
        "solo": ["独处"],
        "parents": ["长辈", "家庭"],
        "pet": ["宠物"],
        "study": ["学习"],
    }
    suitable.extend(scene_suitable.get(scene, []))
    return list(dict.fromkeys(tags)), list(dict.fromkeys(suitable))


def _load_overrides() -> Dict[str, Dict[str, Dict[str, Any]]]:
    if not OVERRIDES_PATH.exists():
        return {}
    try:
        with OVERRIDES_PATH.open("r", encoding="utf-8") as fh:
            data = json.load(fh)
        if isinstance(data, dict):
            return data
    except (OSError, json.JSONDecodeError):
        return {}
    return {}


def _apply_override(poi: POI, city: Optional[str]) -> POI:
    if not city:
        return poi
    overrides = _load_overrides()
    city_overrides = overrides.get(city) or {}
    override = city_overrides.get(poi.get("name", ""))
    if isinstance(override, dict):
        poi.update(override)
    return poi


def enrich_poi(
    poi: POI,
    *,
    scene: str,
    city: Optional[str] = None,
    time_hint: str = "17:30",
) -> POI:
    """为 POI 补全美团侧演示字段，结果对同一地点稳定可复现。"""
    enriched: POI = dict(poi)  # type: ignore[assignment]
    rng = _rng(city, enriched.get("name"), enriched.get("category"), scene, time_hint)

    enriched["rating"] = _infer_rating(enriched, rng)
    enriched["needs_reservation"] = _infer_needs_reservation(enriched)
    price = _infer_price(enriched, rng)
    if price is not None:
        enriched["price_per_person"] = price
    queue = _infer_queue(enriched, rng, time_hint)
    if queue is not None:
        enriched["queue_minutes"] = queue

    tags, suitable = _infer_tags(enriched, scene)
    enriched["tags"] = tags
    enriched["suitable_for"] = suitable
    enriched["meituan_simulated"] = True
    enriched = _apply_override(enriched, city)
    return enriched
