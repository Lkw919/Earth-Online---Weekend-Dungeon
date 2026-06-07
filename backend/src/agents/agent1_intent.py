"""Agent 1：意图解析。

优先使用 DashScope LLM 从自然语言中提取结构化 Intent；
未配置 Key 或 LLM 失败时，自动退回规则解析。
"""

from __future__ import annotations

import logging
import re
from typing import List, Optional

from ..scenes import ALL_SCENE_IDS, detect_scene_from_text, get_scene_profile
from ..state import Intent, Member, PlanState
from ..tools import llm

logger = logging.getLogger(__name__)

MODEL = "qwen3.6-flash"

_DURATION_RE = re.compile(r"(\d+(?:\.\d+)?)\s*(?:个)?\s*小时")
_KID_AGE_RE = re.compile(r"孩子\s*(\d+)\s*岁")
_PEOPLE_RE = re.compile(r"(\d+)\s*个?\s*人")

_EXPLICIT_TIME_RE = re.compile(
    r"(?:\d{1,2}\s*[:：]\s*\d{1,2}"
    r"|\d{1,2}\s*(?:点|时)(?:半|\s*\d{1,2}\s*分?)?"
    r"|[零〇一二两三四五六七八九十]{1,3}\s*(?:点|时))"
)
_FUZZY_DURATION = ("半天", "一下午", "一上午", "一晚上", "一整天", "一天")
_CN_DURATION_RE = re.compile(
    r"[零〇一二两三四五六七八九十]{1,3}\s*(?:个)?\s*(?:小时|钟头)"
)

_VALID_SCENES = set(ALL_SCENE_IDS) | {"unknown"}
_VALID_CONSTRAINTS = {
    "near_home", "afternoon", "evening", "low_calorie", "kid_friendly",
    "pet_friendly", "quiet", "slow_pace",
}


def _detect_scene(goal: str) -> str:
    return detect_scene_from_text(goal)


def _parse_people_count(goal: str) -> Optional[int]:
    """解析前端 chip 或自然语言里的人数（含本人）。"""
    if "5人+" in goal or "5人＋" in goal:
        return 5
    if "3-4人" in goal:
        return 4
    match = _PEOPLE_RE.search(goal)
    if match:
        return int(match.group(1))
    return None


def _friends_members_from_count(total: int) -> List[Member]:
    """总人数含本人，其余记为同行朋友。"""
    companions = max(0, total - 1)
    if companions <= 0:
        return []
    if companions == 1:
        return [{"role": "朋友"}]
    return [{"role": f"朋友{i + 1}"} for i in range(companions)]


def _extract_members(goal: str, scene: str) -> List[Member]:
    members: List[Member] = []

    if scene in ("solo", "study"):
        return members

    kid_age = _KID_AGE_RE.search(goal)
    if kid_age:
        members.append({"role": "孩子", "age": int(kid_age.group(1))})
    elif ("孩子" in goal or "娃" in goal) and scene == "family":
        members.append({"role": "孩子", "age": 5})

    if "老婆" in goal or "妻子" in goal:
        note = "减肥" if "减肥" in goal else None
        members.append({"role": "配偶", "note": note})

    if scene == "parents" or any(token in goal for token in ("爸妈", "父母", "老人", "长辈")):
        members.extend([{"role": "父亲"}, {"role": "母亲"}])
        return members

    if scene == "pet" or any(token in goal for token in ("狗", "猫", "宠物", "毛孩子")):
        members.append({"role": "宠物"})

    if scene == "friends":
        if "2个男生2个女生" in goal or "两男两女" in goal:
            for _ in range(2):
                members.append({"role": "男生朋友"})
            for _ in range(2):
                members.append({"role": "女生朋友"})
        else:
            count = _parse_people_count(goal) or 4
            members.extend(_friends_members_from_count(count))

    if scene == "couple" and not members:
        members.append({"role": "对象"})

    if not members and scene == "family":
        members.extend(
            [
                {"role": "配偶", "note": "减肥" if "减肥" in goal else None},
                {"role": "孩子", "age": 5},
            ]
        )
    return members


def _extract_constraints(goal: str, scene: str) -> List[str]:
    constraints: List[str] = []
    profile = get_scene_profile(scene)

    if "别离家太远" in goal or "不要太远" in goal or "近点" in goal or "别太远" in goal:
        constraints.append("near_home")
    if "下午" in goal:
        constraints.append("afternoon")
    if "晚上" in goal:
        constraints.append("evening")
    if "减肥" in goal:
        constraints.append("low_calorie")
    if "孩子" in goal or "亲子" in goal or scene == "family":
        constraints.append("kid_friendly")
    if any(token in goal for token in ("安静", "氛围", "别吵")):
        constraints.append("quiet")
    if any(token in goal for token in ("慢一点", "节奏慢", "慢慢")):
        constraints.append("slow_pace")
    if scene == "pet" or any(token in goal for token in ("宠物", "狗狗", "遛狗", "毛孩子")):
        constraints.append("pet_friendly")

    for extra in profile.extra_constraints:
        if extra not in constraints:
            constraints.append(extra)
    return constraints


def _extract_duration(goal: str) -> float:
    m = _DURATION_RE.search(goal)
    if m:
        return float(m.group(1))
    if "下午" in goal:
        return 5.0
    return 4.0


def _has_explicit_time(goal: str) -> bool:
    return bool(_EXPLICIT_TIME_RE.search(goal))


def _has_explicit_duration(goal: str) -> bool:
    if _DURATION_RE.search(goal):
        return True
    if _CN_DURATION_RE.search(goal):
        return True
    return any(token in goal for token in _FUZZY_DURATION)


def _build_time_question(intent: dict) -> str:
    duration_default = "4 小时"
    raw = intent.get("raw_goal") or ""
    if "晚上" in raw:
        start_default = "晚上 18:00"
    else:
        start_default = "下午 14:00"
    return (
        "为了排得更准，告诉我你打算几点出发？大概玩多久？\n"
        f"（直接回车则默认{start_default}出发、玩 {duration_default}；"
        "也可只回答其中一个，比如「14:30」或「玩 3 小时」）"
    )


def _parse_intent_rules(goal: str) -> Intent:
    scene = _detect_scene(goal)
    return {
        "raw_goal": goal,
        "scene": scene,  # type: ignore[typeddict-item]
        "duration_hours": _extract_duration(goal),
        "members": _extract_members(goal, scene),
        "constraints": _extract_constraints(goal, scene),
        "start_time": "14:00" if "下午" in goal else ("19:00" if "晚上" in goal else None),
    }


def _normalize_members(raw: object) -> List[Member]:
    if not isinstance(raw, list):
        return []
    members: List[Member] = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        member: Member = {"role": str(item.get("role", "同行"))}
        if item.get("age") is not None:
            try:
                member["age"] = int(item["age"])
            except (TypeError, ValueError):
                pass
        if item.get("note"):
            member["note"] = str(item["note"])
        members.append(member)
    return members


def _parse_intent_llm(goal: str) -> Optional[Intent]:
    if not llm.is_llm_configured():
        return None

    scene_options = "|".join(sorted(_VALID_SCENES - {"unknown"})) + "|unknown"
    constraint_options = ", ".join(sorted(_VALID_CONSTRAINTS))

    prompt = f"""用户目标：{goal}

请提取结构化意图，只输出 JSON，不要 markdown，不要额外说明：
{{
  "scene": "{scene_options}",
  "duration_hours": 数字,
  "start_time": "HH:MM 或 null",
  "members": [{{"role": "角色", "age": 数字或省略, "note": "备注或省略"}}],
  "constraints": ["{constraint_options.replace(', ', '", "')}"]
}}

场景说明：
- family: 带老婆孩子/家人亲子
- friends: 朋友聚会
- couple: 情侣/对象约会
- solo: 一个人/独自
- parents: 带爸妈/父母/老人
- pet: 带宠物/遛狗
- study: 自习/学习/办公

约束说明：
- near_home: 不要离家太远
- low_calorie: 有人减肥/低卡需求
- kid_friendly: 带孩子/亲子友好
- pet_friendly: 宠物友好
- quiet: 安静/有氛围
- slow_pace: 节奏慢/陪老人
"""

    try:
        text = llm.chat(
            [
                {
                    "role": "system",
                    "content": "你是本地生活意图解析助手，只输出合法 JSON。",
                },
                {"role": "user", "content": prompt},
            ],
            model=MODEL,
            temperature=0.2,
        )
        data = llm.extract_json(text)
        scene = data.get("scene", "unknown")
        if scene not in _VALID_SCENES:
            scene = detect_scene_from_text(goal)
        constraints = [
            c for c in (data.get("constraints") or [])
            if isinstance(c, str) and c in _VALID_CONSTRAINTS
        ]
        duration = data.get("duration_hours", 4.0)
        try:
            duration = float(duration)
        except (TypeError, ValueError):
            duration = 4.0

        members = _normalize_members(data.get("members"))
        if not members:
            members = _extract_members(goal, scene)

        intent: Intent = {
            "raw_goal": goal,
            "scene": scene,  # type: ignore[typeddict-item]
            "duration_hours": duration,
            "members": members,
            "constraints": constraints or _extract_constraints(goal, scene),
            "start_time": data.get("start_time") if data.get("start_time") else None,
        }
        logger.info("agent1 LLM 解析成功：%s", intent)
        return intent
    except Exception as exc:
        logger.warning("agent1 LLM 解析失败，退回规则：%s", exc)
        return None


def run(state: PlanState) -> PlanState:
    goal = state.get("user_goal", "")
    existing = state.get("intent") or {}

    if existing.get("raw_goal") == goal and existing.get("scene"):
        logger.info("agent1 复用已有 intent，跳过重新解析")
        state.setdefault("debug", {})["agent1"] = {
            "source": "cached",
            "model": None,
        }
        return state

    intent: Optional[Intent] = None
    source = "rules"

    if llm.is_llm_configured():
        intent = _parse_intent_llm(goal)
        if intent:
            source = "llm"

    if intent is None:
        intent = _parse_intent_rules(goal)
        source = "rules"

    logger.info("agent1 解析意图 (%s)：%s", source, intent)
    state["intent"] = intent
    state.setdefault("debug", {})["agent1"] = {
        "source": source,
        "model": MODEL if source == "llm" else None,
    }

    has_time = _has_explicit_time(goal)
    has_duration = _has_explicit_duration(goal)
    if not (has_time and has_duration):
        state["needs_clarification"] = True
        state["clarification_topic"] = "time"
        state["clarification_question"] = _build_time_question(intent)
        state["debug"]["agent1"]["needs_time_clarification"] = True
        logger.info(
            "agent1 触发时间澄清：has_time=%s has_duration=%s",
            has_time, has_duration,
        )
    return state
