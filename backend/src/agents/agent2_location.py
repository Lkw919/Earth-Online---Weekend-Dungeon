"""Agent 2：位置澄清 + 高德地图工具。

职责：
1. 从用户原始描述里抽取城市/区（LLM 优先，规则映射表兜底）。
2. 如果信息不全，写入 ``needs_clarification=True``，由主循环回到 CLI 询问用户。
3. 拿到城市/区后调用 ``tools.amap`` 校验，并基于场景关键字检索候选 POI。
4. 写入 ``candidate_places`` 给下游 planner 使用。
"""

from __future__ import annotations

import logging
import os
import re
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import List, Optional, Tuple

from ..scenes import PLAN_BUCKET_ORDER, get_scene_profile, plan_bucket_keywords, scene_keywords
from ..state import POI, Location, PlanState, Weather
from ..tools import amap, llm
from ..tools.meituan_enrich import enrich_poi
from ..tools.poi_theme import (
    filter_pois_for_scene,
    is_family_activity,
    is_family_restaurant,
    is_restaurant,
    poi_text,
)

logger = logging.getLogger(__name__)

# 本 Agent 使用的模型，可手动更换
MODEL = "qwen3.6-flash"


_CITY_KEYWORDS = [
    "北京", "上海", "广州", "深圳", "杭州", "成都", "南京", "苏州",
    "重庆", "武汉", "西安", "天津", "厦门", "青岛", "宁波", "长沙",
    "郑州", "合肥", "福州", "济南", "大连", "沈阳", "无锡", "常州",
    "南通", "扬州", "镇江", "泰州", "盐城", "连云港", "徐州", "嘉兴",
    "湖州", "绍兴", "金华", "温州", "东莞", "佛山", "中山", "珠海",
    "开封", "洛阳", "南阳", "新乡", "安阳",
]

# 县级市/区县 -> 所属地级市（便于只输入「太仓市」时反推）
_COUNTY_TO_PREFECTURE: dict[str, str] = {
    "太仓市": "苏州",
    "昆山市": "苏州",
    "常熟市": "苏州",
    "张家港市": "苏州",
    "江阴市": "无锡",
    "宜兴市": "无锡",
    "慈溪市": "宁波",
    "余姚市": "宁波",
    "义乌市": "金华",
    "诸暨市": "绍兴",
    "瑞安市": "温州",
    "乐清市": "温州",
}

# 区 / 县 / 县级市 等下级区域
_SUB_AREA_RE = re.compile(r"([\u4e00-\u9fa5]{1,8}(?:区|新区|市辖区|县|市))")
# 地级市 + 县级市，如「苏州市太仓市」
_PREFECTURE_COUNTY_RE = re.compile(r"([\u4e00-\u9fa5]{2,4})市([\u4e00-\u9fa5]{1,6}市)")


def _normalize_sub_area(name: str) -> str:
    """将「太仓」规范为「太仓市」等。"""
    if name.endswith(("区", "县", "市")):
        return name
    mapped = f"{name}市"
    if mapped in _COUNTY_TO_PREFECTURE:
        return mapped
    return name


def _find_prefecture_city(text: str) -> Optional[str]:
    for token in sorted(_CITY_KEYWORDS, key=len, reverse=True):
        if token in text:
            return token
    return None


def _extract_city_district(text: str) -> Tuple[Optional[str], Optional[str]]:
    text = text.strip().replace(" ", "")

    # 1) 仅县级市：「太仓市」「昆山」
    for county, prefecture in _COUNTY_TO_PREFECTURE.items():
        if county in text:
            return prefecture, county
        short = county[:-1]
        if short in text and county not in text:
            # 避免「苏州」误匹配；要求 short 独立出现或跟在苏州后面
            if re.search(rf"(?:{re.escape(prefecture)}(?:市)?)?{re.escape(short)}(?!市)", text):
                return prefecture, county

    # 2) 地级市 + 县级市：「苏州市太仓市」
    pref_county = _PREFECTURE_COUNTY_RE.search(text)
    if pref_county:
        pref, county = pref_county.group(1), pref_county.group(2)
        city = pref if pref in _CITY_KEYWORDS else pref
        return city, county

    city = _find_prefecture_city(text)
    district: Optional[str] = None

    # 3) 已知地级市 + 下级区域（区 / 县 / 县级市）
    if city:
        after_city = re.compile(
            rf"{re.escape(city)}(?:市)?([\u4e00-\u9fa5]{{1,8}}(?:区|新区|市辖区|县|市))"
        )
        match = after_city.search(text)
        if match:
            candidate = match.group(1)
            if candidate not in (city, f"{city}市"):
                district = candidate

        # 「苏州太仓」未带「市」
        if not district:
            bare = re.search(rf"{re.escape(city)}(?:市)?([\u4e00-\u9fa5]{{2,6}})(?!市)", text)
            if bare:
                district = _normalize_sub_area(bare.group(1))

    # 4) 兜底：在文本中找第一个下级区域
    if not district:
        for match in _SUB_AREA_RE.finditer(text):
            candidate = match.group(1)
            if city and candidate in (city, f"{city}市"):
                continue
            district = candidate
            break

    if district and city:
        for prefix in (f"{city}市", city):
            if district.startswith(prefix):
                district = district[len(prefix) :]

    # 5) 只有下级区域时，用县级市映射反推地级市
    if district and not city:
        district = _normalize_sub_area(district)
        city = _COUNTY_TO_PREFECTURE.get(district)

    if district:
        district = _normalize_sub_area(district)

    # 6) 仅地级市：「开封市」「开封」
    if not city and not district:
        standalone = re.fullmatch(r"([\u4e00-\u9fa5]{2,6})市?", text)
        if standalone:
            return standalone.group(1), None

    return city, district


def _normalize_city(name: str) -> str:
    return name.strip().rstrip("市")


def _is_prefecture_name(name: str) -> bool:
    """判断是否为地级市名（如开封市），而非县级市（如太仓市）。"""
    if not name or not name.endswith("市"):
        return False
    if name in _COUNTY_TO_PREFECTURE:
        return False
    return True


def _coalesce_location(
    city: Optional[str],
    district: Optional[str],
) -> Tuple[Optional[str], Optional[str]]:
    """归一化 LLM/规则解析结果，修正「开封市被当成 district」等情况。"""
    if district in _COUNTY_TO_PREFECTURE:
        city = city or _COUNTY_TO_PREFECTURE[district]
        return city, district

    if district and _is_prefecture_name(district):
        prefecture = _normalize_city(district)
        if not city or city == prefecture:
            return prefecture, None

    if city and district and _normalize_city(district) == city:
        return city, None

    if city and district == f"{city}市":
        return city, None

    return city, district


def _parse_location_llm(text: str) -> Optional[Tuple[Optional[str], Optional[str]]]:
    """用 LLM 从自然语言中抽取 city / district，允许仅 city 或仅 district。"""
    if not llm.is_llm_configured():
        return None

    prompt = f"""用户输入：{text}

请提取中国城市位置，只输出 JSON，不要 markdown：
{{
  "city": "地级市简称，不带「市」，如苏州、开封；未知则 null",
  "district": "区/县/县级市全称，如朝阳区、龙亭区、太仓市；未知则 null",
  "complete": true
}}

规则：
- 「苏州市太仓市」→ city=苏州, district=太仓市
- 「开封市」→ city=开封, district=null, complete=true
- 「龙亭区」且上下文能推断市 → 填 city 和 district
- 「我在太仓」→ city=苏州, district=太仓市
- 完全无法判断时设 complete=false
"""

    try:
        raw = llm.chat(
            [
                {
                    "role": "system",
                    "content": "你是中国城市地理信息解析助手，只输出合法 JSON。",
                },
                {"role": "user", "content": prompt},
            ],
            model=MODEL,
            temperature=0.1,
        )
        data = llm.extract_json(raw)
        if not data.get("complete", True):
            return None

        city_raw = str(data.get("city") or "").strip()
        district_raw = str(data.get("district") or "").strip()
        city = _normalize_city(city_raw) if city_raw else None
        district = _normalize_sub_area(district_raw) if district_raw else None

        if not city and not district:
            return None

        if district in _COUNTY_TO_PREFECTURE:
            city = city or _COUNTY_TO_PREFECTURE[district]

        city, district = _coalesce_location(city, district)
        logger.info("agent2 LLM 位置解析：city=%s district=%s", city, district)
        return city, district
    except Exception as exc:
        logger.warning("agent2 LLM 位置解析失败，退回规则：%s", exc)
        return None


def _resolve_city_district(text: str) -> Tuple[Optional[str], Optional[str], str]:
    """LLM 优先，规则映射表兜底。返回 (city, district, source)。"""
    llm_result = _parse_location_llm(text)
    if llm_result is not None:
        return llm_result[0], llm_result[1], "llm"

    city, district = _extract_city_district(text)
    city, district = _coalesce_location(city, district)
    return city, district, "rules"


def _build_clarification(goal: str, *, city: Optional[str] = None) -> str:
    origin_hint = "（可选：补充你在哪个商圈/地标附近，如「紫荆山附近」）"
    if city:
        return (
            f"已知你在{city}市，请再告诉我具体在哪个区/县/县级市？{origin_hint}"
            f"我会查当地天气和附近活动。"
            f"\n(原始需求：{goal})"
        )
    return (
        "为了帮你规划下午的行程，请告诉我你大概在哪个城市哪个区/县/县级市？"
        f"{origin_hint}我会查当地天气和附近活动。"
        f"\n(原始需求：{goal})"
    )


_ORIGIN_NEAR_RE = re.compile(r"([\u4e00-\u9fa5A-Za-z0-9]{2,20})(?:附近|周边|一带)")


def _extract_origin_label(text: str) -> Optional[str]:
    match = _ORIGIN_NEAR_RE.search(text.strip())
    if match:
        return f"{match.group(1)}附近"
    if "附近" in text and len(text.strip()) <= 20:
        return text.strip()
    return None


_KEYWORD_ALTERNATES: dict[str, List[str]] = {
    "科技馆": ["博物馆", "亲子乐园"],
    "博物馆": ["科技馆", "展览"],
    "亲子乐园": ["儿童乐园", "游乐场"],
    "儿童乐园": ["亲子乐园", "游乐场"],
    "亲子餐厅": ["轻食", "儿童餐厅"],
    "轻食": ["沙拉", "健康餐"],
}


def _resolve_origin_coords(
    city: str,
    district: Optional[str],
    loc: Location,
    extra_text: str,
    fallback: Optional[str] = None,
) -> Tuple[Optional[str], Optional[str], str]:
    """解析出发点坐标；有 origin_label 时优先 POI 级地标解析。"""
    label = loc.get("origin_label") or _extract_origin_label(extra_text)
    coords: Optional[str] = None
    origin_source = "district_center"

    if label:
        landmark_name = label.replace("附近", "").replace("周边", "").replace("一带", "").strip()
        landmark = amap.resolve_landmark(landmark_name, city, district)
        if landmark.ok and landmark.data:
            coords = landmark.data.get("location")
            resolved_name = landmark.data.get("name")
            if resolved_name:
                label = f"{resolved_name}附近"
            origin_source = "landmark"
            logger.info("出发点地标解析：%s -> %s", landmark_name, coords)
        else:
            geo = amap.geocode_place(landmark_name, city)
            if geo.ok and geo.data:
                coords = geo.data.get("location")
                origin_source = "geocode"
                logger.info("出发点 geocode 解析：%s -> %s", landmark_name, coords)

    if not coords and fallback:
        coords = fallback
        if origin_source != "landmark" and origin_source != "geocode":
            origin_source = "district_center"

    return coords, label, origin_source


def _effective_radius_km(intent: dict, loc: Location) -> float:
    radius = float(loc.get("radius_km") or 8.0)
    if "near_home" in (intent.get("constraints") or []):
        return min(radius, 3.0)
    return radius


def _is_rainy(condition: str) -> bool:
    return any(token in condition for token in ("雨", "雪", "雷", "雹"))


def _scene_keywords(intent: dict, weather: Optional[Weather] = None) -> List[str]:
    scene = intent.get("scene") or "unknown"
    constraints = set(intent.get("constraints") or [])
    condition = (weather or {}).get("condition", "")
    rainy = _is_rainy(condition)

    keywords = scene_keywords(scene, rainy=rainy)
    if scene == "family" and "low_calorie" in constraints and not rainy:
        keywords = list(keywords) + ["轻食", "健康餐", "沙拉"]
    return keywords


_CITY_FEATURE_KEYWORDS: dict[str, List[str]] = {
    "郑州": ["河南博物院", "郑州科技馆", "紫荆山公园"],
    "北京": ["中国科技馆", "自然博物馆", "奥林匹克森林公园"],
    "上海": ["上海自然博物馆", "上海科技馆", "世纪公园"],
    "杭州": ["西湖", "浙江自然博物院", "杭州植物园"],
}


def _poi_text(poi: POI) -> str:
    return poi_text(poi)


def _is_restaurant(poi: POI) -> bool:
    return is_restaurant(poi)


def _is_family_activity(poi: POI) -> bool:
    return is_family_activity(poi)


def _is_family_restaurant(poi: POI, intent: dict) -> bool:
    return is_family_restaurant(poi, intent)


def _theme_fallback_pois(
    city: str,
    district: Optional[str],
    origin: Optional[str],
    intent: dict,
    existing: List[POI],
) -> List[POI]:
    """真实 POI 过泛时，注入贴合主题的演示兜底，避免选到普通餐馆。"""
    existing_names = {p.get("name") for p in existing}
    base_addr = f"{city}{district or ''}"
    fallbacks: List[POI] = []

    if city in _CITY_FEATURE_KEYWORDS:
        for name in _CITY_FEATURE_KEYWORDS[city][:2]:
            if name not in existing_names:
                fallbacks.append(
                    {
                        "name": name,
                        "category": "城市特色亲子文化点",
                        "address": f"{base_addr}城市核心区",
                        "distance_meters": 1800,
                        "duration_minutes": 15.0,
                        "rating": 4.7,
                        "tags": ["城市特色", "亲子", "文化", "适合拍照"],
                        "suitable_for": ["孩子", "家庭"],
                        "needs_reservation": False,
                        "source": "mock",
                    }
                )

    themed_restaurants = [
        {
            "name": f"{district or city}亲子轻食餐厅",
            "tags": ["亲子", "儿童菜单", "低卡", "沙拉", "健康餐"],
            "suitable_for": ["孩子", "家庭", "减肥"],
            "price_per_person": 88,
        },
        {
            "name": f"{district or city}家庭健康餐厅",
            "tags": ["家庭", "清淡", "蒸菜", "汤粥", "适合减肥"],
            "suitable_for": ["家庭", "减肥"],
            "price_per_person": 76,
        },
    ]
    for item in themed_restaurants:
        if item["name"] in existing_names:
            continue
        fallbacks.append(
            {
                "name": item["name"],
                "category": "餐厅",
                "address": f"{base_addr}亲子友好商场",
                "distance_meters": 1200,
                "duration_minutes": 12.0,
                "rating": 4.6,
                "tags": item["tags"],
                "suitable_for": item["suitable_for"],
                "needs_reservation": True,
                "queue_minutes": 10,
                "price_per_person": item["price_per_person"],
                "source": "mock",
            }
        )
    return fallbacks


def _curate_pois_for_intent(
    city: str,
    district: Optional[str],
    origin: Optional[str],
    intent: dict,
    pois: List[POI],
    *,
    allow_mock_fallback: bool = True,
) -> List[POI]:
    scene = intent.get("scene", "unknown")
    curated = filter_pois_for_scene(intent, pois)

    if scene == "family" and allow_mock_fallback:
        activities = [p for p in curated if _is_family_activity(p)]
        restaurants = [p for p in curated if _is_family_restaurant(p, intent)]
        if not activities or not restaurants:
            curated.extend(_theme_fallback_pois(city, district, origin, intent, curated))

    seen: set[str] = set()
    deduped: List[POI] = []
    for poi in curated:
        name = poi.get("name", "")
        if not name or name in seen:
            continue
        seen.add(name)
        deduped.append(poi)
    return deduped


def _search_keyword(
    city: str,
    district: Optional[str],
    radius_km: float,
    origin: Optional[str],
    kw: str,
    allow_mock: bool,
) -> List[POI]:
    result = amap.search_pois(
        city=city,
        district=district,
        keywords=kw,
        radius_km=radius_km,
        limit=4,
        origin=origin,
        allow_mock=allow_mock,
    )
    items: List[POI] = []
    if result.ok and result.data:
        items.extend(result.data)
    if not items and kw in _KEYWORD_ALTERNATES:
        for alt in _KEYWORD_ALTERNATES[kw]:
            alt_result = amap.search_pois(
                city=city,
                district=district,
                keywords=alt,
                radius_km=radius_km,
                limit=4,
                origin=origin,
                allow_mock=allow_mock,
            )
            if alt_result.ok and alt_result.data:
                items.extend(alt_result.data)
                break
    return items


def _search_bucket_chain(
    city: str,
    district: Optional[str],
    radius_km: float,
    origin: Optional[str],
    chain: List[str],
    allow_mock: bool,
) -> List[dict]:
    """按关键词链依次搜索,命中即停(降级链)。返回原始 amap item 列表。"""
    for kw in chain:
        items = _search_keyword(city, district, radius_km, origin, kw, allow_mock)
        if items:
            return items
    return []


def _collect_bucketed_pois(
    city: str,
    district: Optional[str],
    radius_km: float,
    scene: str,
    intent: dict,
    origin: Optional[str] = None,
    allow_mock: bool = True,
) -> List[POI]:
    """按场景的三类专属关键词(景点/餐厅/咖啡)并行搜索,每个 POI 打上 plan_bucket 标签。

    并行维度=3个桶(scenic/restaurant/cafe),桶内是降级链(命中即停)。
    墙钟时间≈最慢的那个桶,不随关键词增多线性增长。
    """
    buckets = plan_bucket_keywords(scene)
    seen: set[str] = set()
    pois: List[POI] = []

    def _build(item: dict, bucket: str) -> Optional[POI]:
        name = item.get("name", "")
        if not name or name in seen:
            return None
        seen.add(name)
        poi: POI = {
            "name": name,
            "category": item.get("category", ""),
            "address": item.get("address", ""),
            "location": item.get("location"),
            "distance_meters": item.get("distance_meters", 0),
            "duration_minutes": item.get("duration_minutes"),
            "rating": float(item.get("rating", 4.5)),
            "tags": item.get("tags", []),
            "suitable_for": item.get("suitable_for", []),
            "needs_reservation": item.get("needs_reservation", False),
            "queue_minutes": item.get("queue_minutes"),
            "price_per_person": item.get("price_per_person"),
            "source": item.get("source", "amap"),
            "image_url": item.get("image_url", ""),
            "plan_bucket": bucket,
        }
        return enrich_poi(poi, scene=scene, city=city)

    with ThreadPoolExecutor(max_workers=3) as pool:
        futures = {
            pool.submit(
                _search_bucket_chain,
                city, district, radius_km, origin, buckets[bucket], allow_mock,
            ): bucket
            for bucket in PLAN_BUCKET_ORDER
        }
        # 按固定顺序收集,保证去重时景点优先保留(同名地点不会被餐厅桶抢走)
        results: dict[str, List[dict]] = {}
        for f in as_completed(futures):
            results[futures[f]] = f.result()

    for bucket in PLAN_BUCKET_ORDER:
        for item in results.get(bucket, []):
            built = _build(item, bucket)
            if built:
                pois.append(built)

    return pois


def _collect_pois(
    city: str,
    district: Optional[str],
    radius_km: float,
    keywords: List[str],
    intent: dict,
    origin: Optional[str] = None,
    allow_mock: bool = True,
) -> List[POI]:
    pois: List[POI] = []
    seen: set[str] = set()
    scene = str(intent.get("scene") or "unknown")

    def _merge(items: List[POI]) -> None:
        for item in items:
            name = item.get("name", "")
            if name in seen:
                continue
            seen.add(name)
            poi: POI = {
                "name": name,
                "category": item.get("category", ""),
                "address": item.get("address", ""),
                "location": item.get("location"),
                "distance_meters": item.get("distance_meters", 0),
                "duration_minutes": item.get("duration_minutes"),
                "rating": float(item.get("rating", 4.5)),
                "tags": item.get("tags", []),
                "suitable_for": item.get("suitable_for", []),
                "needs_reservation": item.get("needs_reservation", False),
                "queue_minutes": item.get("queue_minutes"),
                "price_per_person": item.get("price_per_person"),
                "source": item.get("source", "amap"),
                "image_url": item.get("image_url", ""),
            }
            pois.append(enrich_poi(poi, scene=scene, city=city))

    with ThreadPoolExecutor(max_workers=5) as pool:
        futures = {
            pool.submit(
                _search_keyword, city, district, radius_km, origin, kw, allow_mock
            ): kw
            for kw in keywords
        }
        for f in as_completed(futures):
            _merge(f.result())

    return pois


def run(state: PlanState) -> PlanState:
    goal = state.get("user_goal", "")
    intent = state.get("intent", {}) or {}
    loc: Location = dict(state.get("location") or {})  # type: ignore[assignment]

    extra_text = state.get("user_followup") or ""
    combined_text = f"{goal} {extra_text}".strip()
    saved_city = loc.get("city")

    # 多轮补全：已有 city、本轮只补充 district 时，拼接上下文帮助 LLM/规则解析
    if extra_text.strip() and saved_city and not loc.get("district"):
        location_text = f"{saved_city}市{extra_text.strip()}"
    else:
        location_text = extra_text.strip() if extra_text.strip() else combined_text

    city, district, parse_source = _resolve_city_district(location_text)
    city = city or saved_city or os.getenv("DEFAULT_CITY") or None

    # 仅在本轮未解析出 district 时，沿用已保存的区/县级市（不含误存的地级市名）
    if not district:
        old_district = loc.get("district")
        if old_district and (
            old_district.endswith(("区", "县"))
            or old_district in _COUNTY_TO_PREFECTURE
        ):
            district = old_district

    district = district or os.getenv("DEFAULT_DISTRICT") or None
    city, district = _coalesce_location(city, district)

    loc["city"] = city
    loc["district"] = district
    loc.setdefault("radius_km", 8.0)

    if not city and not district:
        state["needs_clarification"] = True
        state["clarification_question"] = _build_clarification(goal)
        state["location"] = loc
        logger.info("agent2 缺少城市/区，触发澄清")
        return state

    if city and not district:
        state["needs_clarification"] = True
        state["clarification_question"] = _build_clarification(goal, city=city)
        state["location"] = loc
        logger.info("agent2 已有城市 %s，追问区/县", city)
        return state

    if not city or not district:
        state["needs_clarification"] = True
        state["clarification_question"] = _build_clarification(goal, city=city)
        state["location"] = loc
        logger.info("agent2 位置信息不完整，触发澄清")
        return state

    state["needs_clarification"] = False
    state["clarification_question"] = None

    verify = amap.verify_district(city=city, district=district)
    adcode = None
    district_center: Optional[str] = None
    if not verify.ok and district:
        # 区名/县级市解析异常时，用纯下级区域名再试一次
        cleaned = district.replace(f"{city}市", "").replace(city or "", "").strip()
        if cleaned and cleaned != district:
            verify = amap.verify_district(city=city, district=cleaned)
    if not verify.ok:
        state.setdefault("errors", []).append(
            f"行政区校验失败 city={city} district={district} err={verify.error}"
        )
    else:
        district_center = verify.data.get("center")
        adcode = verify.data.get("adcode")
        loc["adcode"] = adcode

    origin_coords, origin_label, origin_source = _resolve_origin_coords(
        city, district, loc, extra_text, fallback=district_center,
    )
    if origin_coords:
        loc["origin"] = origin_coords
    if origin_label:
        loc["origin_label"] = origin_label

    radius_km = _effective_radius_km(intent, loc)
    loc["radius_km"] = radius_km
    # 配置了高德 Key 时优先真实 POI，避免演示地址（如郑州金水区）仍落回固定 mock 店名。
    allow_mock = not amap.has_api_key()

    weather_result = amap.get_weather(city=city, adcode=adcode)
    weather: Weather = {}
    if weather_result.ok and weather_result.data:
        weather = {
            **weather_result.data,
            "source": weather_result.source,  # type: ignore[typeddict-item]
        }
        state["weather"] = weather
    else:
        state.setdefault("errors", []).append(
            f"天气查询失败 city={city} err={weather_result.error}"
        )

    scene = str(intent.get("scene") or "unknown")
    search_origin = loc.get("origin")
    # 主路径: 按场景三类专属关键词(景点/餐厅/咖啡)分桶并行搜索,
    # 每个 POI 自带 plan_bucket 标签,供 agent3 直接按类别挑选。
    pois = _collect_bucketed_pois(
        city, district, radius_km, scene, intent,
        origin=search_origin, allow_mock=allow_mock,
    )
    keywords = plan_bucket_keywords(scene)  # 仅用于 debug 展示

    if not pois:
        # 兜底: 分桶全空时退回场景通用关键词 + 原有筛选/兜底管线
        logger.info("分桶搜索为空，退回场景通用关键词")
        fallback_kw = _scene_keywords(intent, weather)
        if intent.get("scene") == "family" and city in _CITY_FEATURE_KEYWORDS:
            fallback_kw = fallback_kw + _CITY_FEATURE_KEYWORDS[city][:2]
        pois = _collect_pois(
            city, district, radius_km, fallback_kw, intent, origin=search_origin, allow_mock=allow_mock,
        )
        pois = _curate_pois_for_intent(
            city, district, search_origin, intent, pois, allow_mock_fallback=allow_mock,
        )
        pois = [enrich_poi(poi, scene=scene, city=city) for poi in pois]

    if not allow_mock:
        pois = [p for p in pois if p.get("source") != "mock"]

    raw_count = len(pois)

    state["location"] = loc
    state["candidate_places"] = pois
    state.setdefault("debug", {})["agent2"] = {
        "city": city,
        "district": district,
        "parse_source": parse_source,
        "parse_model": MODEL if parse_source == "llm" else None,
        "keywords": keywords,
        "weather": weather.get("condition"),
        "temperature": weather.get("temperature"),
        "origin": loc.get("origin"),
        "origin_label": loc.get("origin_label"),
        "origin_source": origin_source,
        "radius_km": radius_km,
        "allow_mock": allow_mock,
        "poi_source": pois[0]["source"] if pois else "none",
        "poi_count": len(pois),
        "poi_raw_count": raw_count,
        "meituan_enriched_count": sum(1 for p in pois if p.get("meituan_simulated")),
    }
    logger.info(
        "agent2 完成位置澄清 (%s)：%s/%s，候选 POI %d 个",
        parse_source, city, district, len(pois),
    )
    return state
