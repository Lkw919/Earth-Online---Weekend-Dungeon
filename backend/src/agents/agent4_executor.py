"""Agent 4：把规划方案翻译成可落地的执行动作。

建议动作与确认执行分离：默认只生成建议，用户确认后才模拟下单。
"""

from __future__ import annotations

import copy
import logging
from typing import Dict, List, Optional

from ..scenes import get_scene_profile
from ..state import ExecutionAction, PlanState
from ..tools import amap, mock_meituan
from .schedule_utils import (
    compute_delivery_time,
    compute_depart_time,
    dinner_start_time,
    first_start_time,
    resolve_start_time,
)

logger = logging.getLogger(__name__)


def _party_size(state: PlanState) -> int:
    intent = state.get("intent") or {}
    members = intent.get("members") or []
    if members:
        return len(members) + 1
    return get_scene_profile(intent.get("scene")).default_party_size


def _build_action(
    action: str,
    target: str,
    status: str,
    detail: str,
    *,
    confirmed: bool = False,
) -> ExecutionAction:
    return {
        "action": action,
        "target": target,
        "status": status,  # type: ignore[typeddict-item]
        "detail": detail,
        "confirmed": confirmed,
    }


def _format_poi_distance(poi: Dict) -> str:
    return amap.format_distance(poi.get("distance_meters"))


def _format_price(poi: Dict, party: int) -> str:
    price = poi.get("price_per_person")
    if not price:
        return ""
    return f"，人均约 {int(float(price))} 元，合计约 {int(float(price) * party)} 元"


def _format_queue(poi: Dict) -> str:
    queue = poi.get("queue_minutes")
    if queue is None:
        return ""
    queue_int = int(queue)
    if queue_int <= 0:
        return "，当前基本无需排队"
    return f"，当前预估排队 {queue_int} 分钟"


def _build_suggested_actions(state: PlanState) -> List[ExecutionAction]:
    plan_steps = state.get("plan_steps") or []
    intent = state.get("intent") or {}
    location = state.get("location") or {}
    party = _party_size(state)
    actions: List[ExecutionAction] = []
    last_index = len(plan_steps) - 1

    for idx, step in enumerate(plan_steps):
        poi = step.get("poi") or {}
        category = poi.get("category", "")
        time_range = step.get("time_range", "")

        if idx == last_index:
            # 行程最后一站统一「待定」:不提前预约/购票,核销上一站后再触发。
            name = poi.get("name", "")
            if "餐厅" in category:
                note = "到点前自动为你取号排队，避免过号"
                act = "reserve"
            elif any(token in category for token in ("亲子", "展览")):
                note = "核销上一站后再购票"
                act = "book_ticket"
            else:
                note = "无需预约，到店即可消费"
                act = "visit"
            actions.append(
                _build_action(
                    act,
                    name,
                    "suggested",
                    f"{time_range} {name}（行程最后一站·待定）：{note}",
                )
            )
            continue

        if "餐厅" in category:
            actions.append(
                _build_action(
                    "reserve",
                    poi.get("name", ""),
                    "suggested",
                    f"建议预约 {time_range} {poi.get('name')}，{party} 人桌"
                    f"{_format_queue(poi)}{_format_price(poi, party)}",
                )
            )
        elif any(token in category for token in ("亲子", "展览")):
            price = _format_price(poi, party)
            actions.append(
                _build_action(
                    "book_ticket",
                    poi.get("name", ""),
                    "suggested",
                    f"建议购票 {time_range} {poi.get('name')}，{party} 人{price}",
                )
            )
        else:
            # 咖啡/景点/公园等无需预约的节点：依然加入行程,以「待定」呈现,
            # 保证副本进行中能完整看到每一站,而不是凭空消失。
            actions.append(
                _build_action(
                    "visit",
                    poi.get("name", ""),
                    "suggested",
                    f"{time_range} 到 {poi.get('name')} 打卡/小坐，无需预约，到店即可消费",
                )
            )

    profile = get_scene_profile(intent.get("scene"))
    if profile.enable_cake_delivery:
        cake_target = next(
            (
                s["poi"]["name"]
                for s in plan_steps
                if "餐厅" in s.get("poi", {}).get("category", "")
            ),
            None,
        )
        if cake_target:
            start = dinner_start_time(plan_steps) or "18:00"
            deliver_at = compute_delivery_time(start, offset_minutes=0)
            actions.append(
                _build_action(
                    "delivery",
                    cake_target,
                    "suggested",
                    f"可选：减糖鲜花蛋糕 {deliver_at} 送至 {cake_target}（给老婆惊喜）",
                )
            )

    if plan_steps and location.get("origin"):
        first_poi = plan_steps[0].get("poi", {})
        start = first_start_time(plan_steps, intent)
        depart_at = compute_depart_time(start, buffer_minutes=30)
        origin_label = location.get("origin_label") or f"{location.get('district', '')}附近"
        actions.append(
            _build_action(
                "ride",
                first_poi.get("name", ""),
                "suggested",
                f"建议 {depart_at} 从{origin_label}打车至 {first_poi.get('name', '')}",
            )
        )

    return actions


def _execute_confirmed(state: PlanState, suggested: List[ExecutionAction]) -> List[ExecutionAction]:
    plan_steps = state.get("plan_steps") or []
    intent = state.get("intent") or {}
    location = state.get("location") or {}
    party = _party_size(state)
    executed: List[ExecutionAction] = []
    last_index = len(plan_steps) - 1

    for idx, step in enumerate(plan_steps):
        poi = step.get("poi") or {}
        category = poi.get("category", "")
        time_range = step.get("time_range", "")
        is_last = idx == last_index

        if is_last:
            # 行程最后一站始终「待定」：不提前预约/下单/检测冲突,以免过号。
            # 餐厅类待定后,由系统在核销倒数第二个节点后自动为其取号排队。
            name = poi.get("name", "")
            if "餐厅" in category:
                action_type = "reserve"
                detail = (
                    f"{time_range} {name}（行程最后一站）：到店时间视前面节奏而定，"
                    f"暂不提前预约，待你核销上一站后自动为你取号排队，避免过号"
                )
            elif any(token in category for token in ("亲子", "展览")):
                action_type = "book_ticket"
                detail = (
                    f"{time_range} {name}（行程最后一站）：暂不提前购票，"
                    f"待你核销上一站后再触发，避免错峰"
                )
            else:
                action_type = "visit"
                detail = (
                    f"{time_range} 前往 {name}（行程最后一站）：到店时间视前面节奏而定，"
                    f"暂不提前下单，避免过号，到店直接消费即可"
                )
            executed.append(
                _build_action(action_type, name, "arranged", detail, confirmed=True)
            )
            continue

        if "餐厅" in category:
            res = mock_meituan.reserve_restaurant(
                restaurant=poi.get("name", ""),
                party_size=party,
                time_slot=time_range,
                poi_meta=poi,
            )
            if res["status"] == "success":
                queue_text = (
                    f"，系统预估排队 {res['queue_minutes']} 分钟，已提前锁位"
                    if res.get("queue_minutes")
                    else "，已锁定到店就餐位"
                )
                executed.append(
                    _build_action(
                        "reserve",
                        poi.get("name", ""),
                        "success",
                        f"已预约 {time_range}，{party} 人桌{queue_text}，预约号 {res['reservation_id']}",
                        confirmed=True,
                    )
                )
            else:
                if state.get("wait_conflict_resolution"):
                    state.setdefault("debug", {})["conflict"] = {
                        "reason": f"{poi.get('name', '')} 当前无空位",
                        "step_index": int(step.get("order", 1)) - 1,
                        "step": copy.deepcopy(step),
                    }
                    break
                queue = mock_meituan.queue_up_online(poi.get("name", ""), party, poi_meta=poi)
                executed.append(
                    _build_action(
                        "queue",
                        poi.get("name", ""),
                        "fallback",
                        f"无空位，已自动取号 {queue['queue_id']}，"
                        f"预计等位 {queue['estimated_wait_minutes']} 分钟",
                        confirmed=True,
                    )
                )
        elif any(token in category for token in ("亲子", "展览")):
            ticket = mock_meituan.book_ticket(
                activity=poi.get("name", ""),
                party_size=party,
                time_slot=time_range,
                poi_meta=poi,
            )
            price_text = (
                f"，合计约 {ticket['total_yuan']} 元" if ticket.get("total_yuan") else ""
            )
            executed.append(
                _build_action(
                    "book_ticket",
                    poi.get("name", ""),
                    "success",
                    f"已购票 {ticket['ticket_id']}{price_text}，{ticket['check_in']}",
                    confirmed=True,
                )
            )
        else:
            # 中间的景点/公园等无需下单的节点：直接确认加入行程。
            executed.append(
                _build_action(
                    "visit",
                    poi.get("name", ""),
                    "success",
                    f"已加入行程：{time_range} 前往 {poi.get('name')}，准时出发即可到达，无需预约",
                    confirmed=True,
                )
            )

    profile = get_scene_profile(intent.get("scene"))
    if profile.enable_cake_delivery:
        cake_target = next(
            (
                s["poi"]["name"]
                for s in plan_steps
                if "餐厅" in s.get("poi", {}).get("category", "")
            ),
            None,
        )
        if cake_target:
            start = dinner_start_time(plan_steps) or "18:00"
            deliver_at = compute_delivery_time(start, offset_minutes=0)
            delivery = mock_meituan.schedule_delivery(
                item="减糖鲜花蛋糕",
                address=cake_target,
                deliver_at=deliver_at,
                note="给老婆惊喜",
            )
            executed.append(
                _build_action(
                    "delivery",
                    cake_target,
                    "success",
                    f"鲜花蛋糕将于 {deliver_at} 送达，订单号 {delivery['delivery_id']}，"
                    f"{delivery['on_time_probability']}",
                    confirmed=True,
                )
            )

    if plan_steps and location.get("origin"):
        first_poi = plan_steps[0].get("poi", {})
        start = first_start_time(plan_steps, intent)
        depart_at = compute_depart_time(start, buffer_minutes=30)
        ride = mock_meituan.hail_ride(
            origin=location.get("origin_label")
            or f"{location.get('city')}{location.get('district') or ''}附近",
            destination=first_poi.get("name", ""),
            depart_at=depart_at,
            poi_meta=first_poi,
        )
        executed.append(
            _build_action(
                "ride",
                first_poi.get("name", ""),
                "success",
                f"{depart_at} 出发的打车已预约（订单 {ride['ride_id']}，"
                f"{amap.format_distance(ride.get('distance_meters'))}，预计 {ride['expected_price_yuan']} 元）",
                confirmed=True,
            )
        )

    return executed


def run(state: PlanState) -> PlanState:
    if not state.get("wait_conflict_resolution"):
        state.setdefault("debug", {}).pop("conflict", None)
    suggested = _build_suggested_actions(state)
    state["suggested_actions"] = suggested

    if state.get("confirm_actions"):
        state["execution_actions"] = _execute_confirmed(state, suggested)
    else:
        state["execution_actions"] = []

    state["final_message"] = build_final_message(state)
    state.setdefault("debug", {})["agent4"] = {
        "suggested": len(suggested),
        "executed": len(state.get("execution_actions") or []),
        "confirmed": bool(state.get("confirm_actions")),
    }
    if state.get("debug", {}).get("conflict"):
        logger.info("agent4 检测到冲突，等待用户确认处理方案")
    logger.info(
        "agent4 完成：建议 %d 项，已执行 %d 项",
        len(suggested),
        len(state.get("execution_actions") or []),
    )
    return state


def _weather_summary(state: PlanState) -> str:
    weather = state.get("weather") or {}
    condition = weather.get("condition")
    temperature = weather.get("temperature")
    if not condition:
        return ""
    if temperature:
        return f" · 今日{condition} {temperature}°C"
    return f" · 今日{condition}"


def _share_message(state: PlanState) -> str:
    intent = state.get("intent") or {}
    steps = state.get("plan_steps") or []
    weather = state.get("weather") or {}
    scene = intent.get("scene", "unknown")
    profile = get_scene_profile(scene)

    if not steps:
        return "方案已生成，请查看详情。"

    first = steps[0]
    first_title = first.get("title", "主活动")
    has_citywalk = any(
        "citywalk" in (s.get("title", "") + s.get("poi", {}).get("category", ""))
        for s in steps
    )
    has_dinner = any(
        token in s.get("title", "") for s in steps for token in ("晚餐", "轻食", "简餐")
    )
    start = first_start_time(steps, intent)
    depart = compute_depart_time(start, buffer_minutes=30)
    rainy = any(token in weather.get("condition", "") for token in ("雨", "雪"))

    if scene == "family":
        if rainy and not has_citywalk:
            tail = "晚饭已订好，全程室内避雨。" if has_dinner else "按室内路线安排好了。"
        elif has_citywalk and has_dinner:
            tail = "结束去 citywalk，晚饭已订好。"
        elif has_dinner:
            tail = "晚饭已订好。"
        else:
            tail = "按路线安排好了。"
        return f"『搞定了，{depart} 出发，先去{first_title}，{tail}』"

    if scene == "solo":
        return f"『{depart} 出发，一个人去{first_title}，{profile.share_tail}』"

    if scene == "pet":
        return f"『{depart} 带毛孩子出发，先去{first_title}，{profile.share_tail}』"

    if scene == "study":
        return f"『{depart} 去自习，{profile.share_tail}』"

    if scene == "parents":
        return f"『{depart} 陪爸妈出发，先去{first_title}，{profile.share_tail}』"

    if scene == "couple":
        tail = profile.share_tail if has_dinner else "按路线安排好了。"
        return f"『{depart} 约会出发，先去{first_title}，{tail}』"

    if has_citywalk and has_dinner:
        return f"『{depart} 集合，先看展+citywalk，晚饭已订好包厢，到时见！』"
    if has_dinner:
        return f"『{depart} 集合，活动已安排好，晚饭已订好包厢，到时见！』"
    return f"『{depart} 集合，活动已安排好，到时见！』"


def build_final_message(state: PlanState) -> str:
    intent = state.get("intent") or {}
    loc = state.get("location") or {}
    steps = state.get("plan_steps") or []
    strategy = state.get("plan_strategy") or {}
    suggested = state.get("suggested_actions") or []
    actions = state.get("execution_actions") or []
    confirmed = bool(state.get("confirm_actions"))

    profile = get_scene_profile(intent.get("scene"))
    scene_label = profile.label

    origin_suffix = ""
    if loc.get("origin_label"):
        origin_suffix = f" · 从{loc['origin_label']}出发"

    lines: List[str] = []
    lines.append(
        f"【{scene_label}方案 · {loc.get('city')}{loc.get('district') or ''}"
        f"{_weather_summary(state)}{origin_suffix}】"
    )
    lines.append("数据来源：地点信息来自高德地图；订座、排队、价格为演示模拟。")
    lines.append("")
    lines.append("行程安排：")
    for step in steps:
        poi = step.get("poi") or {}
        dist = _format_poi_distance(poi)
        lines.append(
            f"  {step['order']}. {step['time_range']} {step['title']} → {poi.get('name')}"
            f" ({poi.get('address')}，距出发点 {dist})"
        )
        if step.get("note"):
            lines.append(f"     · {step['note']}")
        if step.get("selected_reason"):
            lines.append(f"     · 选中理由：{step['selected_reason']}")
        if step.get("alternative_name"):
            lines.append(f"     · 备选：{step['alternative_name']}")

    if strategy:
        lines.append("")
        lines.append("攻略要点：")
        if strategy.get("route_summary"):
            lines.append(f"  · 路线逻辑：{strategy['route_summary']}")
        if strategy.get("budget_detail"):
            lines.append(f"  · 预算参考：{strategy['budget_detail']}")
        if strategy.get("transport_tip"):
            lines.append(f"  · 交通建议：{strategy['transport_tip']}")
        for tip in strategy.get("risk_tips") or []:
            lines.append(f"  · 避坑：{tip}")
        for alt in strategy.get("alternatives") or []:
            lines.append(f"  · {alt}")

    lines.append("")
    lines.append("建议动作（待确认）：")
    for act in suggested:
        lines.append(f"  · {act.get('detail')}")

    if confirmed and actions:
        lines.append("")
        lines.append("模拟执行结果（演示）：")
        for act in actions:
            status_icon = {
                "success": "✅",
                "fallback": "⚠️",
                "failed": "❌",
                "pending": "⏳",
                "arranged": "📍",
                "suggested": "·",
            }.get(act.get("status", "pending"), "•")
            lines.append(f"  {status_icon} {act.get('detail')}")
    elif not confirmed:
        lines.append("")
        lines.append("（以上为建议，输入 y 确认后将模拟执行一键安排）")

    lines.append("")
    lines.append(
        f"可发给{profile.share_audience}：{_share_message(state)}"
    )

    return "\n".join(lines)
