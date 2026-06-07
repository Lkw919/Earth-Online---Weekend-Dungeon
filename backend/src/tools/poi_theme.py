"""POI 主题匹配：确保推荐内容贴合场景（家庭/亲子/宠物/自习等）。"""

from __future__ import annotations

from typing import Dict, List

from ..state import POI

_FAMILY_ACTIVITY_TOKENS = (
    "亲子", "儿童", "孩子", "家庭", "公园", "游园", "游乐", "乐园",
    "科技馆", "博物馆", "博物院", "植物园", "动物园", "图书馆",
)
_FAMILY_RESTAURANT_TOKENS = (
    "亲子", "儿童", "家庭", "轻食", "低卡", "沙拉", "健康", "素食",
    "蒸", "粥", "汤", "鱼", "日料", "儿童菜单",
)
_GENERIC_RESTAURANT_TOKENS = ("餐厅", "餐饮", "中餐", "快餐", "饭店", "小馆", "食府", "酒楼")
_UNSUITABLE_TOKENS = (
    "机关", "内部", "员工", "培训", "棋牌", "酒吧", "老兵", "会所", "足浴", "夜店",
)
_PET_TOKENS = ("宠物", "狗", "猫", "户外", "公园")
_STUDY_TOKENS = ("图书馆", "自习", "书店", "咖啡", "安静", "轻食")
_PARENTS_ACTIVITY_TOKENS = ("公园", "博物馆", "博物院", "茶馆", "园林", "展览", "文化")
_PARENTS_EXCLUDE_TOKENS = ("亲子乐园", "儿童乐园", "游乐", "蹦床")
_COUPLE_TOKENS = ("咖啡", "西餐", "展览", "甜品", "夜景", "浪漫")
_SOLO_TOKENS = ("咖啡", "书店", "展览", "公园", "图书馆", "轻食")
_FRIENDS_TOKENS = ("展览", "citywalk", "小吃", "聚餐", "朋友")
_ENTERTAINMENT_TOKENS = ("酒吧", "夜店", "KTV", "蹦床", "密室")


def poi_text(poi: POI) -> str:
    return " ".join(
        [
            poi.get("name", ""),
            poi.get("category", ""),
            poi.get("address", ""),
            *poi.get("tags", []),
            *poi.get("suitable_for", []),
        ]
    )


def is_unsuitable(text: str) -> bool:
    return any(token in text for token in _UNSUITABLE_TOKENS)


def is_restaurant(poi: POI) -> bool:
    return any(token in poi_text(poi) for token in _GENERIC_RESTAURANT_TOKENS)


def is_family_activity(poi: POI) -> bool:
    text = poi_text(poi)
    if is_unsuitable(text):
        return False
    return not is_restaurant(poi) and any(token in text for token in _FAMILY_ACTIVITY_TOKENS)


def is_family_restaurant(poi: POI, intent: Dict) -> bool:
    if not is_restaurant(poi):
        return False
    text = poi_text(poi)
    if is_unsuitable(text):
        return False
    constraints = set(intent.get("constraints") or [])
    if "low_calorie" in constraints:
        return any(token in text for token in _FAMILY_RESTAURANT_TOKENS)
    return any(token in text for token in ("亲子", "儿童", "家庭")) or any(
        token in text for token in _FAMILY_RESTAURANT_TOKENS
    )


def _dedupe_pois(pois: List[POI]) -> List[POI]:
    seen: set[str] = set()
    result: List[POI] = []
    for poi in pois:
        name = poi.get("name", "")
        if not name or name in seen:
            continue
        seen.add(name)
        result.append(poi)
    return result


def filter_pois_for_family(intent: Dict, pois: List[POI]) -> List[POI]:
    """家庭场景：只保留亲子活动 + 亲子/健康餐厅，排除普通餐馆。"""
    activities = [p for p in pois if is_family_activity(p)]
    restaurants = [p for p in pois if is_family_restaurant(p, intent)]
    others = [
        p for p in pois
        if p not in activities and p not in restaurants and not is_restaurant(p)
    ]
    return _dedupe_pois(activities + restaurants + others)


def _matches_any(poi: POI, tokens: tuple[str, ...]) -> bool:
    text = poi_text(poi)
    if is_unsuitable(text):
        return False
    return any(token in text for token in tokens)


def filter_pois_for_pet(intent: Dict, pois: List[POI]) -> List[POI]:
    matched = [p for p in pois if _matches_any(p, _PET_TOKENS)]
    if not matched:
        matched = [
            p for p in pois
            if not is_restaurant(p) or "咖啡" in poi_text(p)
        ]
    return _dedupe_pois(matched)


def filter_pois_for_study(intent: Dict, pois: List[POI]) -> List[POI]:
    matched = [
        p for p in pois
        if _matches_any(p, _STUDY_TOKENS)
        and not any(token in poi_text(p) for token in _ENTERTAINMENT_TOKENS)
    ]
    light_food = [
        p for p in pois
        if is_restaurant(p)
        and any(token in poi_text(p) for token in ("轻食", "咖啡", "简餐", "沙拉"))
    ]
    return _dedupe_pois(matched + light_food)


def filter_pois_for_parents(intent: Dict, pois: List[POI]) -> List[POI]:
    activities = [
        p for p in pois
        if not is_restaurant(p)
        and _matches_any(p, _PARENTS_ACTIVITY_TOKENS)
        and not any(token in poi_text(p) for token in _PARENTS_EXCLUDE_TOKENS)
    ]
    restaurants = [
        p for p in pois
        if is_restaurant(p)
        and any(token in poi_text(p) for token in ("粤菜", "淮扬", "清淡", "茶", "家庭", "养生"))
    ]
    return _dedupe_pois(activities + restaurants)


def filter_pois_for_couple(intent: Dict, pois: List[POI]) -> List[POI]:
    matched = [p for p in pois if _matches_any(p, _COUPLE_TOKENS)]
    return _dedupe_pois(matched or pois)


def filter_pois_for_solo(intent: Dict, pois: List[POI]) -> List[POI]:
    matched = [p for p in pois if _matches_any(p, _SOLO_TOKENS)]
    return _dedupe_pois(matched or pois)


def filter_pois_for_friends(intent: Dict, pois: List[POI]) -> List[POI]:
    matched = [p for p in pois if _matches_any(p, _FRIENDS_TOKENS) or is_restaurant(p)]
    return _dedupe_pois(matched or pois)


def filter_pois_for_scene(intent: Dict, pois: List[POI]) -> List[POI]:
    scene = intent.get("scene", "unknown")
    filters = {
        "family": filter_pois_for_family,
        "friends": filter_pois_for_friends,
        "couple": filter_pois_for_couple,
        "solo": filter_pois_for_solo,
        "parents": filter_pois_for_parents,
        "pet": filter_pois_for_pet,
        "study": filter_pois_for_study,
    }
    fn = filters.get(scene)
    if fn:
        return fn(intent, pois)
    return pois


def validate_family_plan(intent: Dict, steps: List[Dict]) -> bool:
    """校验家庭行程是否主题一致。"""
    if intent.get("scene") != "family":
        return True
    if not steps:
        return False

    has_activity = False
    for step in steps:
        poi = step.get("poi") or {}
        title = step.get("title", "")
        text = poi_text(poi)

        if is_restaurant(poi):
            if not is_family_restaurant(poi, intent):
                return False
        elif is_family_activity(poi) or any(
            token in text for token in ("公园", "游园", "乐园", "科技馆", "博物馆")
        ):
            has_activity = True
        elif "晚餐" in title and not is_family_restaurant(poi, intent):
            return False

    return has_activity


def _validate_pet_plan(intent: Dict, steps: List[Dict]) -> bool:
    if not steps:
        return False
    for step in steps:
        text = poi_text(step.get("poi") or {})
        if is_restaurant(step.get("poi") or {}) and "宠物" not in text and "咖啡" not in text:
            return False
        if any(token in text for token in _ENTERTAINMENT_TOKENS):
            return False
    return True


def _validate_study_plan(intent: Dict, steps: List[Dict]) -> bool:
    if not steps:
        return False
    has_study = False
    for step in steps:
        text = poi_text(step.get("poi") or {})
        if any(token in text for token in _ENTERTAINMENT_TOKENS):
            return False
        if any(token in text for token in _STUDY_TOKENS):
            has_study = True
    return has_study


def _validate_parents_plan(intent: Dict, steps: List[Dict]) -> bool:
    if not steps:
        return False
    for step in steps:
        text = poi_text(step.get("poi") or {})
        if any(token in text for token in _PARENTS_EXCLUDE_TOKENS):
            return False
    return True


def validate_plan_for_scene(intent: Dict, steps: List[Dict]) -> bool:
    scene = intent.get("scene", "unknown")
    if scene == "family":
        return validate_family_plan(intent, steps)
    if scene == "pet":
        return _validate_pet_plan(intent, steps)
    if scene == "study":
        return _validate_study_plan(intent, steps)
    if scene == "parents":
        return _validate_parents_plan(intent, steps)
    return bool(steps)
