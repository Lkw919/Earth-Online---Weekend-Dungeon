"""高德地图 Web 服务封装。

设计要点：
1. 优先调用真实高德 API（需要 ``AMAP_API_KEY``）。
2. 没有 Key 或调用失败时，自动退回内置 Mock 数据，保证 Demo 可演示。
3. 对外暴露统一的结构化结果，方便 LangGraph 节点直接消费。
"""

from __future__ import annotations

import logging
import os
import random
from dataclasses import dataclass
from typing import Any, Dict, List, Optional

import requests

logger = logging.getLogger(__name__)

AMAP_BASE = "https://restapi.amap.com/v3"
DEFAULT_TIMEOUT = 3


@dataclass
class AmapResult:
    ok: bool
    source: str               # "amap" | "mock"
    data: Any
    error: Optional[str] = None


def _get_key() -> Optional[str]:
    key = os.getenv("AMAP_API_KEY")
    return key.strip() if key else None


def has_api_key() -> bool:
    return bool(_get_key())


# ---------------------------------------------------------------------------
# 行政区校验
# ---------------------------------------------------------------------------

def verify_district(city: str, district: Optional[str] = None) -> AmapResult:
    """通过高德 ``/config/district`` 校验城市/区是否存在，并返回行政中心点。"""
    key = _get_key()
    keywords = district or city
    if key and keywords:
        try:
            resp = requests.get(
                f"{AMAP_BASE}/config/district",
                params={
                    "key": key,
                    "keywords": keywords,
                    "subdistrict": 1,
                    "extensions": "base",
                },
                timeout=DEFAULT_TIMEOUT,
            )
            payload = resp.json()
            if payload.get("status") == "1" and payload.get("districts"):
                d = payload["districts"][0]
                return AmapResult(
                    ok=True,
                    source="amap",
                    data={
                        "name": d.get("name"),
                        "adcode": d.get("adcode"),
                        "center": d.get("center"),
                        "level": d.get("level"),
                    },
                )
            return AmapResult(
                ok=False,
                source="amap",
                data=None,
                error=payload.get("info", "amap_no_result"),
            )
        except Exception as exc:  # pragma: no cover - 网络异常退回 mock
            logger.warning("高德行政区接口失败，退回 Mock：%s", exc)

    return _mock_verify_district(city, district)


def _mock_verify_district(city: str, district: Optional[str]) -> AmapResult:
    name = district or city
    fake_center = {
        ("北京", "朝阳区"): "116.486409,39.921489",
        ("北京", "海淀区"): "116.298056,39.959722",
        ("上海", "浦东新区"): "121.544379,31.221517",
        ("上海", "徐汇区"): "121.436503,31.188491",
        ("深圳", "南山区"): "113.930413,22.533155",
        ("广州", "天河区"): "113.361200,23.124700",
        ("杭州", "西湖区"): "120.130303,30.259244",
    }
    center = fake_center.get((city or "", district or ""), "116.397428,39.90923")
    return AmapResult(
        ok=True,
        source="mock",
        data={
            "name": name or "默认城市",
            "adcode": "000000",
            "center": center,
            "level": "district" if district else "city",
        },
    )


def format_distance(meters: Optional[int]) -> str:
    """格式化距离展示；无效距离显示「区内」而非 0.0km。"""
    if meters is None or meters <= 0:
        return "区内"
    if meters < 1000:
        return f"{meters}m"
    return f"{meters / 1000:.1f}km"


def geocode_place(name: str, city: str) -> AmapResult:
    """将地标/商圈名称解析为坐标。"""
    key = _get_key()
    if key and name:
        try:
            resp = requests.get(
                f"{AMAP_BASE}/geocode/geo",
                params={
                    "key": key,
                    "address": f"{city}{name}",
                    "city": city,
                },
                timeout=DEFAULT_TIMEOUT,
            )
            payload = resp.json()
            if payload.get("status") == "1" and payload.get("geocodes"):
                geo = payload["geocodes"][0]
                location = geo.get("location")
                if location:
                    return AmapResult(
                        ok=True,
                        source="amap",
                        data={"location": location, "formatted": geo.get("formatted_address")},
                    )
        except Exception as exc:  # pragma: no cover
            logger.warning("高德地理编码失败：%s", exc)

    return AmapResult(ok=False, source="mock", data=None, error="geocode_failed")


def regeo(location: str) -> AmapResult:
    """逆地理编码：把「经度,纬度」坐标解析为城市/区/详细地址。

    location 形如 ``121.5,31.2`` (lng,lat)。用于浏览器定位拿到坐标后,
    反查出 city / district 供后续 POI 搜索使用。
    注意：浏览器 H5 定位返回的是 GPS(WGS-84)坐标,高德按 GCJ-02 解析,
    在区/城市级别误差可忽略,故直接调用;如需街道级精度可先做坐标转换。
    """
    key = _get_key()
    if not (key and location and "," in location):
        return AmapResult(ok=False, source="mock", data=None, error="regeo_bad_input")
    try:
        resp = requests.get(
            f"{AMAP_BASE}/geocode/regeo",
            params={"key": key, "location": location, "extensions": "base"},
            timeout=max(DEFAULT_TIMEOUT, 6),
        )
        payload = resp.json()
        if payload.get("status") != "1":
            # 高德接口级错误(如 INVALID_USER_KEY / DAILY_QUERY_OVER_LIMIT / 该 key 未开通逆地理编码)
            # 直接把 info/infocode 透出来,便于定位真正原因,而不是笼统的 regeo_failed。
            info = payload.get("info") or "unknown"
            infocode = payload.get("infocode") or ""
            logger.warning("高德逆地理编码返回错误：info=%s infocode=%s", info, infocode)
            return AmapResult(
                ok=False, source="mock", data=None,
                error=f"regeo_api_error:{info}({infocode})",
            )
        if payload.get("status") == "1" and payload.get("regeocode"):
            comp = payload["regeocode"].get("addressComponent") or {}
            # 直辖市时 city 可能为空列表,需回退到 province
            city = comp.get("city") or comp.get("province") or ""
            if isinstance(city, list):
                city = comp.get("province") or ""
            district = comp.get("district") or ""
            if isinstance(district, list):
                district = ""
            return AmapResult(
                ok=True,
                source="amap",
                data={
                    "city": str(city).replace("市", ""),
                    "district": str(district),
                    "formatted": payload["regeocode"].get("formatted_address", ""),
                    "location": location,
                },
            )
    except Exception as exc:  # pragma: no cover
        logger.warning("高德逆地理编码失败：%s", exc)

    return AmapResult(ok=False, source="mock", data=None, error="regeo_failed")


_LANDMARK_TYPE_HINTS = ("公园", "地铁", "广场", "商场", "购物", "住宅", "科教", "风景", "文化")


def _safe_float(value: Any, default: Optional[float] = None) -> Optional[float]:
    try:
        if value in (None, ""):
            return default
        return float(value)
    except (TypeError, ValueError):
        return default


def _parse_poi_item(item: Dict[str, Any], keywords: str, origin: Optional[str]) -> Dict[str, Any]:
    biz_ext = item.get("biz_ext") or {}
    rating = _safe_float(biz_ext.get("rating"), 0.0) or 4.5
    cost = _safe_float(biz_ext.get("cost"))
    photos = item.get("photos") or []
    image_url = ""
    if photos and isinstance(photos, list):
        first = photos[0]
        if isinstance(first, dict):
            image_url = first.get("url", "")
    poi = {
        "name": item.get("name", ""),
        "address": item.get("address", ""),
        "category": item.get("type", keywords),
        "location": item.get("location"),
        "distance_meters": _safe_int(item.get("distance")),
        "rating": rating,
        "tags": [t for t in (item.get("tag") or "").split(";") if t],
        "source": "amap",
        "image_url": image_url,
    }
    if cost and cost > 0:
        poi["price_per_person"] = cost
    return _enrich_poi_distance(poi, origin)


def resolve_landmark(
    name: str,
    city: str,
    district: Optional[str] = None,
) -> AmapResult:
    """用地标 POI 搜索解析坐标，比 geocode/geo 更适合「紫荆山附近」类输入。"""
    key = _get_key()
    clean = name.replace("附近", "").replace("周边", "").replace("一带", "").strip()
    if not clean:
        return AmapResult(ok=False, source="amap", data=None, error="empty_name")

    search_city = district or city
    queries = [clean]
    if not clean.endswith(("公园", "地铁", "站")):
        queries.extend([f"{clean}公园", f"{clean}地铁站"])

    if key:
        for query in queries:
            try:
                resp = requests.get(
                    f"{AMAP_BASE}/place/text",
                    params={
                        "key": key,
                        "keywords": query,
                        "city": search_city,
                        "citylimit": "true",
                        "offset": 5,
                        "page": 1,
                        "extensions": "all",
                    },
                    timeout=DEFAULT_TIMEOUT,
                )
                payload = resp.json()
                if payload.get("status") != "1":
                    continue
                candidates = payload.get("pois") or []
                if not candidates:
                    continue

                def _score(item: Dict[str, Any]) -> int:
                    text = f"{item.get('name', '')} {item.get('type', '')}"
                    score = 0
                    if clean in item.get("name", ""):
                        score += 3
                    if district and district.replace("区", "") in text:
                        score += 2
                    if any(h in text for h in _LANDMARK_TYPE_HINTS):
                        score += 1
                    if "公园" in item.get("name", ""):
                        score += 2
                    if "地铁" not in clean and "地铁" in item.get("name", ""):
                        score -= 1
                    return score

                best = max(candidates, key=_score)
                location = best.get("location")
                if location:
                    logger.info(
                        "地标解析成功 query=%s -> %s (%s)",
                        query, best.get("name"), location,
                    )
                    return AmapResult(
                        ok=True,
                        source="amap",
                        data={
                            "location": location,
                            "name": best.get("name"),
                            "formatted": best.get("address"),
                            "query": query,
                        },
                    )
            except Exception as exc:  # pragma: no cover
                logger.warning("地标 POI 搜索失败 query=%s：%s", query, exc)

    geo = geocode_place(clean, city)
    if geo.ok and geo.data:
        return AmapResult(
            ok=True,
            source=geo.source,
            data={
                "location": geo.data.get("location"),
                "name": clean,
                "formatted": geo.data.get("formatted"),
                "query": clean,
            },
        )
    return AmapResult(ok=False, source="amap", data=None, error="landmark_not_found")


def search_pois_around(
    origin: str,
    keywords: str,
    radius_km: float = 3.0,
    limit: int = 6,
    allow_mock: bool = True,
    city: str = "",
    district: Optional[str] = None,
) -> AmapResult:
    """以用户坐标为圆心做周边 POI 搜索（/place/around）。"""
    key = _get_key()
    radius_m = int(radius_km * 1000)
    if key and origin:
        try:
            resp = requests.get(
                f"{AMAP_BASE}/place/around",
                params={
                    "key": key,
                    "location": origin,
                    "keywords": keywords,
                    "radius": radius_m,
                    "offset": limit,
                    "page": 1,
                    "extensions": "all",
                    "sortrule": "distance",
                },
                timeout=DEFAULT_TIMEOUT,
            )
            payload = resp.json()
            if payload.get("status") == "1":
                pois = [
                    _parse_poi_item(item, keywords, origin)
                    for item in (payload.get("pois") or [])[:limit]
                ]
                if pois:
                    return AmapResult(ok=True, source="amap", data=pois)
            logger.info("高德周边搜无结果 keywords=%s radius=%dm", keywords, radius_m)
        except Exception as exc:  # pragma: no cover
            logger.warning("高德周边搜失败，退回 text/mock：%s", exc)

    if not allow_mock:
        return AmapResult(ok=False, source="amap", data=[], error="no_result")

    return _mock_search_pois(city, keywords, district, radius_km, limit, origin=origin)


def _haversine_meters(origin: str, destination: str) -> int:
    """粗略直线距离，用于 API 未返回 distance 时的兜底。"""
    try:
        olng, olat = map(float, origin.split(","))
        dlng, dlat = map(float, destination.split(","))
    except (ValueError, AttributeError):
        return 0
    from math import asin, cos, radians, sin, sqrt

    r = 6371000
    dlat = radians(dlat - olat)
    dlng = radians(dlng - olng)
    a = sin(dlat / 2) ** 2 + cos(radians(olat)) * cos(radians(dlat)) * sin(dlng / 2) ** 2
    return int(2 * r * asin(sqrt(a)))


def _enrich_poi_distance(poi: Dict[str, Any], origin: Optional[str]) -> Dict[str, Any]:
    """补全 POI 距离（haversine），不查驾车路线。"""
    if not origin:
        return poi

    poi_loc = poi.get("location")
    dist = _safe_int(poi.get("distance_meters"))
    if dist <= 0 and poi_loc:
        dist = _haversine_meters(origin, poi_loc)
        poi["distance_meters"] = dist
    return poi


def search_pois(
    city: str,
    keywords: str,
    district: Optional[str] = None,
    radius_km: float = 8.0,
    limit: int = 6,
    origin: Optional[str] = None,
    allow_mock: bool = True,
) -> AmapResult:
    """根据关键字搜索 POI，例如 "亲子乐园"、"展览"、"小吃街"。

    ``origin`` 为 ``lng,lat``，传入后会按半径搜索并补全距离。
    ``allow_mock=False`` 时无结果则返回空列表，不注入 Mock。
    """
    if origin:
        around_result = search_pois_around(
            origin=origin,
            keywords=keywords,
            radius_km=radius_km,
            limit=limit,
            allow_mock=False,
            city=city,
            district=district,
        )
        if around_result.ok and around_result.data:
            return around_result

    key = _get_key()
    radius_m = int(radius_km * 1000)
    if key:
        try:
            params: Dict[str, Any] = {
                "key": key,
                "keywords": keywords,
                "city": district or city,
                "citylimit": "true",
                "offset": limit,
                "page": 1,
                "extensions": "all",
            }

            resp = requests.get(
                f"{AMAP_BASE}/place/text",
                params=params,
                timeout=DEFAULT_TIMEOUT,
            )
            payload = resp.json()
            if payload.get("status") == "1":
                pois = [
                    _parse_poi_item(item, keywords, origin)
                    for item in (payload.get("pois") or [])[:limit]
                ]
                if pois:
                    return AmapResult(ok=True, source="amap", data=pois)
            logger.info("高德 POI 无结果，keywords=%s", keywords)
        except Exception as exc:  # pragma: no cover
            logger.warning("高德 POI 接口失败：%s", exc)

    if not allow_mock:
        return AmapResult(ok=False, source="amap", data=[], error="no_result")

    return _mock_search_pois(city, keywords, district, radius_km, limit, origin=origin)


def _mock_search_pois(
    city: str,
    keywords: str,
    district: Optional[str],
    radius_km: float,
    limit: int,
    origin: Optional[str] = None,
) -> AmapResult:
    """根据关键字生成可演示的 Mock POI 数据。"""

    catalog: Dict[str, List[Dict[str, Any]]] = {
        "亲子": [
            {
                "name": "奇幻森林亲子乐园",
                "address": f"{city}{district or ''}花园路 88 号",
                "tags": ["室内", "适合 3-8 岁", "雨天也能玩"],
                "rating": 4.7,
                "suitable_for": ["孩子", "家庭"],
            },
            {
                "name": "童趣科学馆",
                "address": f"{city}{district or ''}科技园路 12 号",
                "tags": ["亲子", "互动展览", "STEM"],
                "rating": 4.6,
                "suitable_for": ["孩子", "家庭"],
            },
        ],
        "展览": [
            {
                "name": "城市当代艺术馆·光影特展",
                "address": f"{city}{district or ''}文创园 A 座",
                "tags": ["艺术", "拍照", "适合朋友"],
                "rating": 4.8,
                "suitable_for": ["朋友", "情侣"],
            },
            {
                "name": "数字孪生未来展",
                "address": f"{city}{district or ''}滨江会展中心",
                "tags": ["科技", "互动", "适合男女"],
                "rating": 4.5,
                "suitable_for": ["朋友"],
            },
        ],
        "小吃街": [
            {
                "name": "老巷子风味小吃街",
                "address": f"{city}{district or ''}和平路 5 段",
                "tags": ["citywalk", "小吃", "拍照"],
                "rating": 4.4,
                "suitable_for": ["朋友", "家庭"],
            },
        ],
        "公园": [
            {
                "name": "城市中央公园",
                "address": f"{city}{district or ''}中山北路 1 号",
                "tags": ["亲子", "野餐", "免费"],
                "rating": 4.6,
                "suitable_for": ["孩子", "家庭", "朋友"],
            },
        ],
        "餐厅": [
            {
                "name": "绿食轻餐厅（减脂友好）",
                "address": f"{city}{district or ''}悦动 Mall 3F",
                "tags": ["低卡", "沙拉", "适合减肥"],
                "rating": 4.6,
                "suitable_for": ["减肥", "家庭"],
                "needs_reservation": True,
                "queue_minutes": 10,
                "price_per_person": 78,
            },
            {
                "name": "童心亲子餐厅",
                "address": f"{city}{district or ''}悦动 Mall 4F",
                "tags": ["儿童菜单", "游乐区", "家庭"],
                "rating": 4.5,
                "suitable_for": ["孩子", "家庭"],
                "needs_reservation": True,
                "queue_minutes": 25,
                "price_per_person": 120,
            },
            {
                "name": "胡同小馆·新派川菜",
                "address": f"{city}{district or ''}文创园 B 座",
                "tags": ["川菜", "朋友聚餐", "适合 4 人"],
                "rating": 4.7,
                "suitable_for": ["朋友"],
                "needs_reservation": True,
                "queue_minutes": 40,
                "price_per_person": 150,
            },
            {
                "name": "海风日料居酒屋",
                "address": f"{city}{district or ''}滨江壹号 2F",
                "tags": ["日料", "包厢", "朋友"],
                "rating": 4.8,
                "suitable_for": ["朋友", "情侣"],
                "needs_reservation": True,
                "queue_minutes": 30,
                "price_per_person": 220,
            },
        ],
        "citywalk": [
            {
                "name": "运河文艺街区 citywalk",
                "address": f"{city}{district or ''}运河北路",
                "tags": ["散步", "拍照", "咖啡"],
                "rating": 4.5,
                "suitable_for": ["朋友", "情侣"],
            },
        ],
    }

    bucket: List[Dict[str, Any]] = []
    for key_word, items in catalog.items():
        if key_word in keywords:
            bucket.extend(items)
    if not bucket:
        bucket = catalog["公园"]

    rng = random.Random(hash((city, district, keywords)) & 0xFFFF)
    pois: List[Dict[str, Any]] = []
    for item in bucket[:limit]:
        distance = int(rng.uniform(0.5, radius_km) * 1000)
        pois.append(
            {
                "name": item["name"],
                "address": item["address"],
                "category": keywords,
                "distance_meters": distance,
                "rating": item.get("rating", 4.5),
                "tags": item.get("tags", []),
                "suitable_for": item.get("suitable_for", []),
                "needs_reservation": item.get("needs_reservation", False),
                "queue_minutes": item.get("queue_minutes"),
                "price_per_person": item.get("price_per_person"),
                "source": "mock",
            }
        )
    if origin:
        pois = [_enrich_poi_distance(p, origin) for p in pois]
    return AmapResult(ok=True, source="mock", data=pois)


# ---------------------------------------------------------------------------
# 天气查询
# ---------------------------------------------------------------------------

def get_weather(city: str, adcode: Optional[str] = None) -> AmapResult:
    """查询指定城市/行政区的实时天气。``city`` 参数优先使用 ``adcode``。"""
    key = _get_key()
    query = adcode or city
    if key and query:
        try:
            resp = requests.get(
                f"{AMAP_BASE}/weather/weatherInfo",
                params={
                    "key": key,
                    "city": query,
                    "extensions": "base",
                },
                timeout=DEFAULT_TIMEOUT,
            )
            payload = resp.json()
            if payload.get("status") == "1" and payload.get("lives"):
                live = payload["lives"][0]
                return AmapResult(
                    ok=True,
                    source="amap",
                    data={
                        "condition": live.get("weather", ""),
                        "temperature": live.get("temperature", ""),
                        "winddirection": live.get("winddirection", ""),
                        "windpower": live.get("windpower", ""),
                        "humidity": live.get("humidity", ""),
                        "reporttime": live.get("reporttime", ""),
                        "city": live.get("city", city),
                    },
                )
            return AmapResult(
                ok=False,
                source="amap",
                data=None,
                error=payload.get("info", "amap_weather_no_result"),
            )
        except Exception as exc:  # pragma: no cover
            logger.warning("高德天气接口失败，退回 Mock：%s", exc)

    return _mock_weather(city)


def _mock_weather(city: str) -> AmapResult:
    presets = {
        "北京": {"condition": "晴", "temperature": "26", "humidity": "40"},
        "上海": {"condition": "多云", "temperature": "28", "humidity": "65"},
        "深圳": {"condition": "阵雨", "temperature": "30", "humidity": "80"},
        "广州": {"condition": "小雨", "temperature": "27", "humidity": "75"},
    }
    base = presets.get(city, {"condition": "晴", "temperature": "25", "humidity": "50"})
    return AmapResult(
        ok=True,
        source="mock",
        data={
            "condition": base["condition"],
            "temperature": base["temperature"],
            "winddirection": "东南",
            "windpower": "≤3",
            "humidity": base["humidity"],
            "reporttime": "",
            "city": city,
        },
    )


# ---------------------------------------------------------------------------
# 驾车/步行距离
# ---------------------------------------------------------------------------

def driving_distance(origin: str, destination: str) -> AmapResult:
    """origin/destination 为 ``lng,lat`` 字符串，返回估算行驶时间(分钟)。"""
    key = _get_key()
    if key:
        try:
            resp = requests.get(
                f"{AMAP_BASE}/direction/driving",
                params={"key": key, "origin": origin, "destination": destination},
                timeout=DEFAULT_TIMEOUT,
            )
            payload = resp.json()
            if payload.get("status") == "1" and payload.get("route", {}).get("paths"):
                path = payload["route"]["paths"][0]
                return AmapResult(
                    ok=True,
                    source="amap",
                    data={
                        "distance_meters": _safe_int(path.get("distance")),
                        "duration_minutes": round(_safe_int(path.get("duration")) / 60, 1),
                    },
                )
        except Exception as exc:  # pragma: no cover
            logger.warning("高德路径规划失败，退回 Mock：%s", exc)

    return AmapResult(
        ok=True,
        source="mock",
        data={"distance_meters": 3500, "duration_minutes": 18.0},
    )


# ---------------------------------------------------------------------------
# 工具
# ---------------------------------------------------------------------------

def _safe_int(value: Any, default: int = 0) -> int:
    try:
        return int(float(value))
    except (TypeError, ValueError):
        return default
