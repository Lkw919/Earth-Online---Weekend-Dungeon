"""解析用户对「几点出发 + 玩多久」的自然语言回答。

规则优先（覆盖常见表达，避免无 LLM 也能用）；规则失败再走 LLM 兜底。
返回字典：``{"start_time": "HH:MM" | None, "duration_hours": float | None, "skipped": bool}``。
``start_time`` / ``duration_hours`` 为 None 表示用户没说，调用方应保留默认值。
"""

from __future__ import annotations

import logging
import re
from typing import Any, Dict, Optional

from ..tools import llm

logger = logging.getLogger(__name__)

MODEL = "qwen3.6-flash"

_SKIP_TOKENS = (
    "随便", "都行", "都可以", "随意", "无所谓",
    "跳过", "默认", "你定", "看你", "听你的",
)

_CN_NUM = {
    "零": 0, "〇": 0,
    "一": 1, "二": 2, "两": 2, "三": 3, "四": 4, "五": 5,
    "六": 6, "七": 7, "八": 8, "九": 9, "十": 10,
    "十一": 11, "十二": 12,
}

_FUZZY_DURATION = {
    "半天": 4.0,
    "一下午": 5.0,
    "一上午": 4.0,
    "一晚上": 4.0,
    "一整天": 8.0,
    "一天": 8.0,
}

_HHMM_RE = re.compile(r"(\d{1,2})\s*[:：]\s*(\d{1,2})")
_DIGIT_HOUR_RE = re.compile(
    r"(\d{1,2})\s*(?:点|时)(?:\s*(半|\d{1,2})\s*分?)?"
)
_CN_HOUR_RE = re.compile(
    r"([零〇一二两三四五六七八九十]{1,3})\s*(?:点|时)(?:\s*(半|[零〇一二三四五六七八九十]{1,3})\s*分?)?"
)
_DURATION_NUMERIC_RE = re.compile(
    r"(\d+(?:\.\d+)?)\s*(?:个)?\s*(?:小时|h|hr|hour|hours)",
    re.IGNORECASE,
)
_DURATION_CN_RE = re.compile(
    r"([零〇一二两三四五六七八九十]{1,3})\s*(?:个)?\s*(?:小时|个钟头|钟头)"
)
_HALF_HOUR_HINT = re.compile(r"(\d+(?:\.\d+)?)\s*(?:个)?\s*半\s*(?:小时|钟头)")


def _cn_to_int(text: str) -> Optional[int]:
    if text in _CN_NUM:
        return _CN_NUM[text]
    if text.startswith("十") and len(text) == 2:
        tail = _CN_NUM.get(text[1])
        if tail is not None:
            return 10 + tail
    if text.endswith("十") and len(text) == 2:
        head = _CN_NUM.get(text[0])
        if head is not None:
            return head * 10
    if len(text) == 3 and text[1] == "十":
        head = _CN_NUM.get(text[0])
        tail = _CN_NUM.get(text[2])
        if head is not None and tail is not None:
            return head * 10 + tail
    return None


def _to_24h(hour: int, text: str) -> int:
    """根据上下文「下午/晚上/早上」把 12 小时制转 24 小时制。"""
    if hour >= 24:
        return hour % 24
    is_pm = any(token in text for token in ("下午", "傍晚", "晚上", "晚", "夜里", "夜晚", "pm", "PM"))
    is_am = any(token in text for token in ("早上", "上午", "清晨", "早晨", "am", "AM"))
    if hour >= 13:
        return hour
    if is_pm and hour < 12:
        return hour + 12
    if is_am:
        return hour if hour < 12 else 0
    # 没指明：1-6 默认下午，7-11 默认上午，12 视为中午
    if 1 <= hour <= 6:
        return hour + 12
    return hour


def _parse_minutes_text(value: Optional[str]) -> int:
    if not value:
        return 0
    if value == "半":
        return 30
    if value.isdigit():
        return int(value) % 60
    cn = _cn_to_int(value)
    if cn is not None:
        return cn % 60
    return 0


def _parse_start_time(text: str) -> Optional[str]:
    m = _HHMM_RE.search(text)
    if m:
        hour = int(m.group(1))
        minute = int(m.group(2))
        if 0 <= hour < 24 and 0 <= minute < 60:
            return f"{hour:02d}:{minute:02d}"

    m = _DIGIT_HOUR_RE.search(text)
    if m:
        hour = int(m.group(1))
        minute = _parse_minutes_text(m.group(2))
        if 0 <= hour <= 24:
            hour = _to_24h(hour, text)
            return f"{hour:02d}:{minute:02d}"

    m = _CN_HOUR_RE.search(text)
    if m:
        hour_cn = _cn_to_int(m.group(1))
        if hour_cn is not None:
            minute = _parse_minutes_text(m.group(2))
            hour = _to_24h(hour_cn, text)
            return f"{hour:02d}:{minute:02d}"

    return None


def _parse_duration(text: str) -> Optional[float]:
    for keyword, hours in _FUZZY_DURATION.items():
        if keyword in text:
            return hours

    m = _HALF_HOUR_HINT.search(text)
    if m:
        return float(m.group(1)) + 0.5

    m = _DURATION_NUMERIC_RE.search(text)
    if m:
        return float(m.group(1))

    m = _DURATION_CN_RE.search(text)
    if m:
        hours = _cn_to_int(m.group(1))
        if hours is not None:
            base = float(hours)
            if "半" in text[m.end() : m.end() + 4]:
                base += 0.5
            return base

    half = re.search(r"半\s*(?:个)?\s*(?:小时|钟头)", text)
    if half:
        return 0.5

    return None


def _is_skip(text: str) -> bool:
    if not text:
        return True
    return any(token in text for token in _SKIP_TOKENS)


def _parse_with_llm(text: str) -> Dict[str, Any]:
    if not llm.is_llm_configured():
        return {}
    prompt = f"""用户回答：{text}

请从中提取出发时间和游玩时长，只输出 JSON，不要 markdown：
{{
  "start_time": "HH:MM 或 null",
  "duration_hours": 数字或 null,
  "skipped": true/false
}}

规则：
- 「下午两点」→ start_time=14:00
- 「14:00」→ start_time=14:00
- 「玩三小时」→ duration_hours=3
- 「半天」→ duration_hours=4
- 「随便/默认/跳过/都行」→ skipped=true 且字段保持 null
- 不能从文本中明确提取时就输出 null
"""
    try:
        raw = llm.chat(
            [
                {"role": "system", "content": "你只输出合法 JSON。"},
                {"role": "user", "content": prompt},
            ],
            model=MODEL,
            temperature=0.1,
        )
        data = llm.extract_json(raw)
        result: Dict[str, Any] = {}
        st = data.get("start_time")
        if isinstance(st, str) and re.fullmatch(r"\d{1,2}:\d{2}", st.strip()):
            hour, minute = st.strip().split(":")
            result["start_time"] = f"{int(hour):02d}:{int(minute):02d}"
        dur = data.get("duration_hours")
        if isinstance(dur, (int, float)) and dur > 0:
            result["duration_hours"] = float(dur)
        if data.get("skipped"):
            result["skipped"] = True
        return result
    except Exception as exc:
        logger.warning("time_parser LLM 解析失败：%s", exc)
        return {}


def parse_time_followup(text: str) -> Dict[str, Any]:
    """解析用户回答，规则优先 + LLM 兜底。"""
    clean = (text or "").strip()
    if not clean:
        return {"start_time": None, "duration_hours": None, "skipped": True}

    if _is_skip(clean):
        return {"start_time": None, "duration_hours": None, "skipped": True}

    start = _parse_start_time(clean)
    duration = _parse_duration(clean)
    if start or duration:
        return {"start_time": start, "duration_hours": duration, "skipped": False}

    llm_data = _parse_with_llm(clean)
    if llm_data:
        llm_data.setdefault("start_time", None)
        llm_data.setdefault("duration_hours", None)
        llm_data.setdefault("skipped", False)
        return llm_data

    logger.info("time_parser 未识别用户回答，按默认处理：%s", clean)
    return {"start_time": None, "duration_hours": None, "skipped": True}
