"""行程时间排程工具：根据 start_time 和 duration_hours 动态分配各步骤时段。"""

from __future__ import annotations

from datetime import datetime, timedelta
from typing import Dict, List, Optional, Tuple


def _parse_time(value: str) -> datetime:
    for fmt in ("%H:%M", "%H:%M:%S"):
        try:
            return datetime.strptime(value.strip(), fmt)
        except ValueError:
            continue
    return datetime.strptime("14:00", "%H:%M")


def _format_time(dt: datetime) -> str:
    return dt.strftime("%H:%M")


def _format_range(start: datetime, end: datetime) -> str:
    return f"{_format_time(start)}-{_format_time(end)}"


def resolve_start_time(intent: Dict) -> str:
    """从 intent 推断出发/开始时间。"""
    if intent.get("start_time"):
        return str(intent["start_time"])
    constraints = set(intent.get("constraints") or [])
    if "afternoon" in constraints or "下午" in (intent.get("raw_goal") or ""):
        return "14:00"
    if "evening" in constraints or "晚上" in (intent.get("raw_goal") or ""):
        return "18:00"
    return "14:00"


def compute_depart_time(start_time: str, buffer_minutes: int = 30) -> str:
    """计算打车出发时间（默认比首站提前 30 分钟）。"""
    start = _parse_time(start_time)
    depart = start - timedelta(minutes=buffer_minutes)
    return _format_time(depart)


def compute_delivery_time(dinner_end: str, offset_minutes: int = 30) -> str:
    """配送时间：晚餐结束后再偏移若干分钟。"""
    end = _parse_time(dinner_end)
    deliver = end + timedelta(minutes=offset_minutes)
    return _format_time(deliver)


def split_duration(
    duration_hours: float,
    num_steps: int,
    *,
    has_dinner: bool = True,
) -> List[int]:
    """将总时长（分钟）按步骤数量拆分。"""
    total = max(int(duration_hours * 60), 90)
    if num_steps <= 1:
        return [total]

    dinner_mins = 0
    if has_dinner and num_steps >= 2:
        dinner_mins = min(120, max(60, int(total * 0.35)))
    activity_total = total - dinner_mins

    if num_steps == 2:
        if has_dinner:
            return [activity_total, dinner_mins]
        return [activity_total // 2, activity_total - activity_total // 2]

    if num_steps == 3:
        # 3 步：主活动 / 过渡 / 晚餐
        primary = int(activity_total * 0.65)
        secondary = activity_total - primary
        if has_dinner:
            return [primary, secondary, dinner_mins]
        return [primary, secondary, 0]

    # 4-5 步全天行程：上午景点 → 午餐 → 下午(1~2 站) → 晚餐
    # 步骤顺序与 agent3._plan_fixed_itinerary 的产出顺序严格对应。
    dinner = min(120, max(80, int(total * 0.22))) if has_dinner else 0
    lunch = min(90, max(60, int(total * 0.14)))
    act_count = num_steps - 2  # 上午景点 + 下午各站(不含午餐、晚餐)
    act_total = max(total - dinner - lunch, act_count * 60)
    base = act_total // act_count
    segments = [base, lunch]
    for _ in range(act_count - 1):
        segments.append(base)
    segments.append(dinner if has_dinner else base)
    return segments


def _build_full_day_ranges(start: datetime, step_count: int) -> List[str]:
    """上午出发的全天行程：把午餐锚定到中午、晚餐锚定到 18:00，
    早上玩景点、下午 1~2 站、晚上吃饭，时段更贴近真实作息。

    步骤顺序：上午景点 → 午餐 → 下午(step_count-3 站) → 晚餐。
    """
    base_day = start.replace(hour=0, minute=0)

    def at(hour: int, minute: int = 0) -> datetime:
        return base_day + timedelta(hours=hour, minutes=minute)

    LUNCH_DUR = 75
    DINNER_DUR = 90
    # 午餐：出发后至少 90 分钟，且落在 11:30 左右
    lunch_start = max(start + timedelta(minutes=90), at(11, 30))
    if lunch_start > at(12, 30):
        lunch_start = at(12, 30)
    lunch_end = lunch_start + timedelta(minutes=LUNCH_DUR)

    dinner_start = at(18, 0)
    if dinner_start <= lunch_end:  # 极端情况下兜底，保证晚餐在午餐之后
        dinner_start = lunch_end + timedelta(minutes=120)
    dinner_end = dinner_start + timedelta(minutes=DINNER_DUR)

    afternoon_count = max(step_count - 3, 1)
    afternoon_total = (dinner_start - lunch_end).total_seconds() / 60
    each = max(int(afternoon_total / afternoon_count), 45)

    ranges: List[str] = [_format_range(start, lunch_start), _format_range(lunch_start, lunch_end)]
    cursor = lunch_end
    for i in range(afternoon_count):
        end = dinner_start if i == afternoon_count - 1 else cursor + timedelta(minutes=each)
        ranges.append(_format_range(cursor, end))
        cursor = end
    ranges.append(_format_range(dinner_start, dinner_end))
    return ranges


def build_time_ranges(
    intent: Dict,
    step_count: int,
    *,
    has_dinner: bool = True,
) -> List[str]:
    """根据 intent 生成每步 time_range 字符串列表。"""
    start_str = resolve_start_time(intent)
    duration = float(intent.get("duration_hours") or 4.0)
    start = _parse_time(start_str)

    # 上午出发的全天行程(>=4 步)：锚定真实饭点，避免午餐排在 9 点这种割裂感
    if step_count >= 4 and start.hour < 11:
        return _build_full_day_ranges(start, step_count)

    segments = split_duration(duration, step_count, has_dinner=has_dinner)

    ranges: List[str] = []
    cursor = start
    for mins in segments:
        if mins <= 0:
            continue
        end = cursor + timedelta(minutes=mins)
        ranges.append(_format_range(cursor, end))
        cursor = end
    return ranges


def dinner_start_time(steps: List[Dict]) -> Optional[str]:
    """从 plan_steps 中提取晚餐开始时间 HH:MM。"""
    for step in steps:
        time_range = step.get("time_range", "")
        if "晚餐" in step.get("title", "") or "餐厅" in (step.get("poi") or {}).get("category", ""):
            if "-" in time_range:
                return time_range.split("-", 1)[0].strip()
    return None


def dinner_end_time(steps: List[Dict]) -> Optional[str]:
    """从 plan_steps 中提取晚餐结束时间 HH:MM。"""
    for step in reversed(steps):
        title = step.get("title", "")
        time_range = step.get("time_range", "")
        if "晚餐" in title or "餐厅" in (step.get("poi") or {}).get("category", ""):
            if "-" in time_range:
                return time_range.split("-", 1)[1].strip()
    if steps:
        last_range = steps[-1].get("time_range", "")
        if "-" in last_range:
            return last_range.split("-", 1)[1].strip()
    return None


def first_start_time(steps: List[Dict], intent: Dict) -> str:
    if steps and steps[0].get("time_range") and "-" in steps[0]["time_range"]:
        return steps[0]["time_range"].split("-", 1)[0].strip()
    return resolve_start_time(intent)
