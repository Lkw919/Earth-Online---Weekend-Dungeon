"""Mock 美团本地生活下单/预约接口。

比赛 Demo 不接入真实下单流程，统一返回成功/失败结构。
设计目的：让 ``agent4_executor`` 可以演示完整闭环，包括失败回退路径。
"""

from __future__ import annotations

import hashlib
import os
import random
import time
import uuid
from typing import Any, Dict, List, Optional


def _seed_key(*parts: Any) -> int:
    raw = "|".join(str(part or "") for part in (*parts, os.getenv("DEMO_SEED", "")))
    return int(hashlib.sha256(raw.encode("utf-8")).hexdigest()[:12], 16)


def _rng(*parts: Any) -> random.Random:
    return random.Random(_seed_key(*parts))


def _gen_id(prefix: str, *parts: Any) -> str:
    if parts:
        token = hashlib.sha256("|".join(str(p) for p in parts).encode("utf-8")).hexdigest()[:8]
        return f"{prefix}_{token}"
    return f"{prefix}_{uuid.uuid4().hex[:8]}"


def _safe_int(value: Any, default: int = 0) -> int:
    try:
        if value in (None, ""):
            return default
        return int(float(value))
    except (TypeError, ValueError):
        return default


def _has_seat_probability(poi_meta: Optional[Dict[str, Any]]) -> float:
    if not poi_meta:
        return 0.75
    queue = _safe_int(poi_meta.get("queue_minutes"))
    if not poi_meta.get("needs_reservation", True):
        return 0.4
    if queue >= 35:
        return 0.35
    if queue >= 20:
        return 0.55
    return 0.82


def check_restaurant_availability(
    restaurant: str,
    party_size: int,
    time_slot: str,
    poi_meta: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """检查餐厅是否有位置/需要排队。

    「有没有座位」的判定加入高精度时间戳作为随机种子(time.time_ns()),
    因此每次下单结果都不固定——大概率有座、偶尔无座触发冲突,
    用于自然演示冲突处理流程,而不是同一家店永远失败。
    """
    rng = _rng("restaurant", restaurant, time_slot, party_size, time.time_ns())
    has_seat = rng.random() < _has_seat_probability(poi_meta)
    base_queue = _safe_int((poi_meta or {}).get("queue_minutes"), rng.randint(15, 45))
    queue = 0 if has_seat else max(5, base_queue + rng.randint(-5, 8))
    return {
        "restaurant": restaurant,
        "party_size": party_size,
        "time_slot": time_slot,
        "has_seat": has_seat,
        "queue_minutes": queue,
        "checked_at": time.strftime("%Y-%m-%d %H:%M:%S"),
    }


def reserve_restaurant(
    restaurant: str,
    party_size: int,
    time_slot: str,
    contact_phone: str = "13800000000",
    notes: Optional[str] = None,
    poi_meta: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """模拟餐厅预订。"""
    avail = check_restaurant_availability(restaurant, party_size, time_slot, poi_meta)
    if avail["has_seat"]:
        return {
            "status": "success",
            "reservation_id": _gen_id("R", restaurant, party_size, time_slot),
            "restaurant": restaurant,
            "party_size": party_size,
            "time_slot": time_slot,
            "contact_phone": contact_phone,
            "notes": notes,
            "queue_minutes": _safe_int((poi_meta or {}).get("queue_minutes")),
            "price_per_person": (poi_meta or {}).get("price_per_person"),
        }
    return {
        "status": "fallback",
        "restaurant": restaurant,
        "queue_minutes": avail["queue_minutes"],
        "suggestion": "建议提前线上排队或改为附近备选餐厅",
    }


def queue_up_online(
    restaurant: str,
    party_size: int,
    poi_meta: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """美团排队取号。"""
    rng = _rng("queue", restaurant, party_size)
    base_waiting = _safe_int((poi_meta or {}).get("queue_minutes"), rng.randint(8, 25))
    waiting = max(3, base_waiting + rng.randint(-4, 6))
    return {
        "status": "success",
        "queue_id": _gen_id("Q", restaurant, party_size),
        "restaurant": restaurant,
        "party_size": party_size,
        "estimated_wait_minutes": waiting,
        "tip": f"前面还有 {waiting} 桌，临近时会推送提醒",
    }


def book_ticket(
    activity: str,
    party_size: int,
    time_slot: str,
    poi_meta: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """活动票务预约，例如亲子乐园、展览。"""
    unit_price = _safe_int((poi_meta or {}).get("price_per_person"))
    return {
        "status": "success",
        "ticket_id": _gen_id("T", activity, party_size, time_slot),
        "activity": activity,
        "party_size": party_size,
        "time_slot": time_slot,
        "check_in": "凭短信二维码入场",
        "unit_price_yuan": unit_price,
        "total_yuan": unit_price * party_size,
    }


def schedule_delivery(
    item: str,
    address: str,
    deliver_at: str,
    note: Optional[str] = None,
) -> Dict[str, Any]:
    """配送服务：例如把蛋糕/鲜花在某时间点送到餐厅。"""
    return {
        "status": "success",
        "delivery_id": _gen_id("D", item, address, deliver_at),
        "item": item,
        "address": address,
        "deliver_at": deliver_at,
        "note": note,
        "courier_distance_meters": 1800,
        "on_time_probability": "预计准时率 95%",
    }


def hail_ride(
    origin: str,
    destination: str,
    depart_at: str,
    poi_meta: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """打车/接驳。"""
    distance = _safe_int((poi_meta or {}).get("distance_meters"), 3500)
    duration = (poi_meta or {}).get("duration_minutes")
    price = max(18, round(13 + distance / 1000 * 2.8))
    return {
        "status": "success",
        "ride_id": _gen_id("CAR", origin, destination, depart_at),
        "origin": origin,
        "destination": destination,
        "depart_at": depart_at,
        "distance_meters": distance,
        "duration_minutes": duration,
        "expected_price_yuan": price,
    }


def summarize_actions(actions: List[Dict[str, Any]]) -> str:
    """把执行结果整理成一句话总结，方便发给朋友/家人。"""
    parts = []
    for act in actions:
        if act.get("status") == "success":
            parts.append(f"✅ {act.get('summary', '完成')}")
        elif act.get("status") == "fallback":
            parts.append(f"⚠️ {act.get('summary', '已备选')}")
        else:
            parts.append(f"❌ {act.get('summary', '失败')}")
    return "；".join(parts)
