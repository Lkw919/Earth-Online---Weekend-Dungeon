"""使用 LangGraph 组合四个 Agent 的状态机。

流程：
    agent1_intent → agent2_location → (clarify? END : agent3_planner → agent4_executor → END)

澄清后应调用 ``continue_from_location``，避免重复解析 intent。
"""

from __future__ import annotations

import logging
import os
from typing import Literal

from langgraph.graph import END, StateGraph

from .agents import agent1_intent, agent2_location, agent3_planner, agent4_executor
from .agents.time_parser import parse_time_followup
from .api.events import emit_event
from .state import PlanState

logger = logging.getLogger(__name__)


def _route_after_intent(state: PlanState) -> Literal["clarify", "next"]:
    return "clarify" if state.get("needs_clarification") else "next"


def _route_after_location(state: PlanState) -> Literal["clarify", "plan"]:
    return "clarify" if state.get("needs_clarification") else "plan"


def _run_intent(state: PlanState) -> PlanState:
    print("=" * 60, flush=True)
    print("[Agent1 Intent] 开始解析用户意图", flush=True)
    print(f"[Agent1 Intent] 用户输入: {state.get('user_goal', '')}", flush=True)
    emit_event(state, "agent_step", {"stage": "intent", "phase": "start", "message": "正在解析意图"})
    logs_start = [
        "[Agent1 Intent] 开始解析用户意图",
        f"[Agent1 Intent] 用户输入: {state.get('user_goal', '')}",
    ]
    emit_event(state, "agent_step", {"stage": "intent", "phase": "detail", "message": "开始解析用户意图", "logs": logs_start})
    state = agent1_intent.run(state)
    intent = state.get("intent") or {}
    d1 = (state.get("debug") or {}).get("agent1") or {}
    print(f"[Agent1 Intent] 解析结果: scene={intent.get('scene')}, start_time={intent.get('start_time')}, "
          f"duration={intent.get('duration_hours')}h, members={len(intent.get('members') or [])}", flush=True)
    print(f"[Agent1 Intent] LLM 来源: {d1.get('source', 'unknown')}, 模型: {d1.get('model', 'N/A')}", flush=True)
    print(f"[Agent1 Intent] 是否需要澄清: {state.get('needs_clarification')}", flush=True)
    if state.get("needs_clarification"):
        print(f"[Agent1 Intent] 澄清问题: {state.get('clarification_question')}", flush=True)
    logs_done = [
        f"[Agent1 Intent] 解析结果: scene={intent.get('scene')}, start_time={intent.get('start_time')}, "
        f"duration={intent.get('duration_hours')}h, members={len(intent.get('members') or [])}",
        f"[Agent1 Intent] LLM 来源: {d1.get('source', 'unknown')}, 模型: {d1.get('model', 'N/A')}",
        f"[Agent1 Intent] 是否需要澄清: {state.get('needs_clarification')}",
    ]
    if state.get("needs_clarification"):
        logs_done.append(f"[Agent1 Intent] 澄清问题: {state.get('clarification_question')}")
    scene_names = {"parents": "陪父母", "friends": "朋友聚会", "date": "约会", "solo": "独自放空", "pets": "带宠物", "study": "自习办公"}
    scene_label = scene_names.get(intent.get("scene", ""), intent.get("scene", ""))
    start_t = intent.get("start_time") or "待定"
    dur = intent.get("duration_hours") or "?"
    member_count = len(intent.get("members") or [])
    summary = f"已了解你的需求：{scene_label}，{member_count}人出行" + (f"，{start_t}出发，约{dur}小时" if start_t != "待定" else "")
    emit_event(state, "agent_step", {
        "stage": "intent", "phase": "done", "message": "意图解析完成", "logs": logs_done,
        "summary": summary,
    })
    print("=" * 60, flush=True)
    return state


def _run_location(state: PlanState) -> PlanState:
    has_amap_key = bool(os.getenv("AMAP_API_KEY", "").strip())
    has_llm_key = bool(os.getenv("DASHSCOPE_API_KEY", "").strip())
    print("=" * 60, flush=True)
    print("[Agent2 Location] 开始位置解析与 POI 搜索", flush=True)
    print(f"[Agent2 Location] 环境检查: AMAP_API_KEY={'已配置' if has_amap_key else '未配置(将用mock)'}, "
          f"DASHSCOPE_API_KEY={'已配置' if has_llm_key else '未配置(将用规则)'}", flush=True)
    emit_event(state, "agent_step", {"stage": "location", "phase": "start", "message": "正在确认城市与区域"})
    logs_start = [
        "[Agent2 Location] 开始位置解析与 POI 搜索",
        f"[Agent2 Location] 环境检查: AMAP_API_KEY={'已配置' if has_amap_key else '未配置(将用mock)'}, "
        f"DASHSCOPE_API_KEY={'已配置' if has_llm_key else '未配置(将用规则)'}",
    ]
    emit_event(state, "agent_step", {
        "stage": "location", "phase": "detail", "message": "搜索位置与 POI", "logs": logs_start,
    })
    state = agent2_location.run(state)
    loc = state.get("location") or {}
    d2 = (state.get("debug") or {}).get("agent2") or {}
    print(f"[Agent2 Location] 城市: {loc.get('city')}, 区: {loc.get('district')}", flush=True)
    print(f"[Agent2 Location] 位置解析来源: {d2.get('parse_source')} (模型: {d2.get('parse_model')})", flush=True)
    print(f"[Agent2 Location] 出发点: {d2.get('origin_label')} (来源: {d2.get('origin_source')})", flush=True)
    print(f"[Agent2 Location] 天气: {d2.get('weather')} {d2.get('temperature')}°C", flush=True)
    print(f"[Agent2 Location] POI 数据来源: {d2.get('poi_source')}, "
          f"候选 POI 数量: {d2.get('poi_count', 0)} (原始: {d2.get('poi_raw_count', 0)})", flush=True)
    print(f"[Agent2 Location] 搜索关键词: {d2.get('keywords')}", flush=True)
    print(f"[Agent2 Location] allow_mock: {d2.get('allow_mock')}", flush=True)
    print(f"[Agent2 Location] 是否需要澄清: {state.get('needs_clarification')}", flush=True)
    if state.get("candidate_places"):
        for i, poi in enumerate(state["candidate_places"][:5]):
            print(f"[Agent2 Location]   POI[{i}]: {poi.get('name')} ({poi.get('category')}) "
                  f"src={poi.get('source')} dist={poi.get('distance_meters')} rating={poi.get('rating')}", flush=True)
    logs_done = [
        f"[Agent2 Location] 城市: {loc.get('city')}, 区: {loc.get('district')}",
        f"[Agent2 Location] 位置解析来源: {d2.get('parse_source')} (模型: {d2.get('parse_model')})",
        f"[Agent2 Location] 出发点: {d2.get('origin_label')} (来源: {d2.get('origin_source')})",
        f"[Agent2 Location] 天气: {d2.get('weather')} {d2.get('temperature')}°C",
        f"[Agent2 Location] POI 数据来源: {d2.get('poi_source')}, "
        f"候选 POI 数量: {d2.get('poi_count', 0)} (原始: {d2.get('poi_raw_count', 0)})",
        f"[Agent2 Location] 搜索关键词: {d2.get('keywords')}",
        f"[Agent2 Location] allow_mock: {d2.get('allow_mock')}",
        f"[Agent2 Location] 是否需要澄清: {state.get('needs_clarification')}",
    ]
    if state.get("candidate_places"):
        for i, poi in enumerate(state["candidate_places"][:5]):
            logs_done.append(
                f"[Agent2 Location]   POI[{i}]: {poi.get('name')} ({poi.get('category')}) "
                f"src={poi.get('source')} dist={poi.get('distance_meters')} rating={poi.get('rating')}"
            )
    city = loc.get("city") or ""
    district = loc.get("district") or ""
    poi_count = d2.get("poi_count", 0)
    origin = d2.get("origin_label") or ""
    weather = d2.get("weather") or ""
    temp = d2.get("temperature") or ""
    parts = [f"已确认你在{city}{district}"]
    if origin:
        parts.append(f"出发点：{origin}")
    if weather:
        parts.append(f"天气：{weather} {temp}°C")
    parts.append(f"找到{poi_count}个适合的场所")
    summary = "，".join(parts)
    emit_event(state, "agent_step", {
        "stage": "location", "phase": "done", "message": "位置处理完成", "logs": logs_done,
        "summary": summary,
    })
    print("=" * 60, flush=True)
    return state


def _run_planner(state: PlanState) -> PlanState:
    print("=" * 60, flush=True)
    print("[Agent3 Planner] 开始行程规划", flush=True)
    print(f"[Agent3 Planner] 候选 POI 数量: {len(state.get('candidate_places') or [])}", flush=True)
    emit_event(state, "agent_step", {"stage": "planner", "phase": "start", "message": "正在生成路线"})
    logs_start = [
        "[Agent3 Planner] 开始行程规划",
        f"[Agent3 Planner] 候选 POI 数量: {len(state.get('candidate_places') or [])}",
    ]
    emit_event(state, "agent_step", {
        "stage": "planner", "phase": "detail", "message": "开始行程规划", "logs": logs_start,
    })
    state = agent3_planner.run(state)
    d3 = (state.get("debug") or {}).get("agent3") or {}
    print(f"[Agent3 Planner] 规划来源: {d3.get('source')} (模型: {d3.get('model')})", flush=True)
    print(f"[Agent3 Planner] 步骤数: {d3.get('steps', 0)}, 出发时间: {d3.get('start_time')}, "
          f"人数: {d3.get('party_size', 1)}", flush=True)
    print(f"[Agent3 Planner] 天气: {d3.get('weather')}", flush=True)
    for i, step in enumerate(state.get("plan_steps") or []):
        poi = step.get("poi") or {}
        print(f"[Agent3 Planner]   步骤{i+1}: {step.get('time_range')} {step.get('title')} "
              f"→ {poi.get('name')} (src={poi.get('source', '?')})", flush=True)
    logs_done = [
        f"[Agent3 Planner] 规划来源: {d3.get('source')} (模型: {d3.get('model')})",
        f"[Agent3 Planner] 步骤数: {d3.get('steps', 0)}, 出发时间: {d3.get('start_time')}, "
        f"人数: {d3.get('party_size', 1)}",
        f"[Agent3 Planner] 天气: {d3.get('weather')}",
    ]
    for i, step in enumerate(state.get("plan_steps") or []):
        poi = step.get("poi") or {}
        logs_done.append(
            f"[Agent3 Planner]   步骤{i+1}: {step.get('time_range')} {step.get('title')} "
            f"→ {poi.get('name')} (src={poi.get('source', '?')})"
        )
    steps = state.get("plan_steps") or []
    step_names = " → ".join([f"{s.get('title','?')}" for s in steps[:5]])
    step_summary = f"路线规划完成！共{len(steps)}站" + (f"：{step_names}" if step_names else "")
    emit_event(state, "agent_step", {
        "stage": "planner", "phase": "done", "message": "路线生成完成", "logs": logs_done,
        "summary": step_summary,
    })
    print("=" * 60, flush=True)
    return state


def _run_executor(state: PlanState) -> PlanState:
    print("=" * 60, flush=True)
    print("[Agent4 Executor] 开始生成执行动作", flush=True)
    print(f"[Agent4 Executor] 是否确认执行: {state.get('confirm_actions')}", flush=True)
    emit_event(state, "agent_step", {"stage": "executor", "phase": "start", "message": "正在生成执行动作"})
    logs_start = [
        "[Agent4 Executor] 开始生成执行动作",
        f"[Agent4 Executor] 是否确认执行: {state.get('confirm_actions')}",
    ]
    emit_event(state, "agent_step", {
        "stage": "executor", "phase": "detail", "message": "开始生成执行动作", "logs": logs_start,
    })
    state = agent4_executor.run(state)
    d4 = (state.get("debug") or {}).get("agent4") or {}
    print(f"[Agent4 Executor] 建议动作: {d4.get('suggested', 0)} 项, 已执行: {d4.get('executed', 0)} 项, "
          f"已确认: {d4.get('confirmed')}", flush=True)
    for act in state.get("suggested_actions") or []:
        print(f"[Agent4 Executor]   [建议] {act.get('action')} → {act.get('target')} ({act.get('detail')})", flush=True)
    for act in state.get("execution_actions") or []:
        print(f"[Agent4 Executor]   [执行] {act.get('action')} → {act.get('target')} status={act.get('status')}", flush=True)
    logs_done = [
        f"[Agent4 Executor] 建议动作: {d4.get('suggested', 0)} 项, 已执行: {d4.get('executed', 0)} 项, "
        f"已确认: {d4.get('confirmed')}",
    ]
    for act in state.get("suggested_actions") or []:
        logs_done.append(f"[Agent4 Executor]   [建议] {act.get('action')} → {act.get('target')} ({act.get('detail')})")
    for act in state.get("execution_actions") or []:
        logs_done.append(f"[Agent4 Executor]   [执行] {act.get('action')} → {act.get('target')} status={act.get('status')}")
    exec_actions = state.get("execution_actions") or []
    exec_summary = f"已生成{len(exec_actions)}个执行动作"
    emit_event(state, "agent_step", {
        "stage": "executor", "phase": "done", "message": "执行动作完成", "logs": logs_done,
        "summary": exec_summary,
    })
    print("=" * 60, flush=True)
    return state


def build_graph():
    graph = StateGraph(PlanState)
    graph.add_node("agent1_intent", _run_intent)
    graph.add_node("agent2_location", _run_location)
    graph.add_node("agent3_planner", _run_planner)
    graph.add_node("agent4_executor", _run_executor)

    graph.set_entry_point("agent1_intent")
    graph.add_conditional_edges(
        "agent1_intent",
        _route_after_intent,
        {
            "clarify": END,
            "next": "agent2_location",
        },
    )
    graph.add_conditional_edges(
        "agent2_location",
        _route_after_location,
        {
            "clarify": END,
            "plan": "agent3_planner",
        },
    )
    graph.add_edge("agent3_planner", "agent4_executor")
    graph.add_edge("agent4_executor", END)
    return graph.compile()


def _apply_time_followup(state: PlanState) -> PlanState:
    """根据用户对时间澄清的回答更新 intent.start_time / duration_hours。"""
    parsed = parse_time_followup(state.get("user_followup") or "")
    intent = dict(state.get("intent") or {})
    if parsed.get("start_time"):
        intent["start_time"] = parsed["start_time"]
    if parsed.get("duration_hours"):
        intent["duration_hours"] = float(parsed["duration_hours"])
    state["intent"] = intent
    state["needs_clarification"] = False
    state["clarification_topic"] = None
    state["clarification_question"] = None
    state["user_followup"] = None
    state.setdefault("debug", {})["time_followup"] = parsed
    return state


def continue_from_time(state: PlanState) -> PlanState:
    """时间澄清后继续：先检查位置信息，缺失则追问，不跑 agent2。"""
    state = _apply_time_followup(state)

    # 位置信息缺失时不进入 agent2，直接触发位置澄清
    location = state.get("location") or {}
    city = location.get("city") or ""
    district = location.get("district") or ""
    if not city and not district:
        state["needs_clarification"] = True
        state["clarification_topic"] = "location"
        state["clarification_question"] = (
            "为了帮你规划行程，请告诉我你大概在哪个城市哪个区/县/县级市？"
            "（可选：补充在哪个商圈/地标附近）"
        )
        return state
    if city and not district:
        state["needs_clarification"] = True
        state["clarification_topic"] = "location"
        state["clarification_question"] = (
            f"已知你在{city}，请再告诉我具体在哪个区/县/县级市？"
            "（可选：补充在哪个商圈/地标附近）"
        )
        return state

    state = _run_location(state)
    if state.get("needs_clarification"):
        return state
    state = _run_planner(state)
    state = _run_executor(state)
    return state


def continue_from_location(state: PlanState) -> PlanState:
    """位置澄清后继续：只跑 agent2 → agent3 → agent4，保留已有 intent。"""
    state = _run_location(state)
    if state.get("needs_clarification"):
        return state
    state = _run_planner(state)
    state = _run_executor(state)
    return state


def continue_executor_only(state: PlanState) -> PlanState:
    """用户确认后仅重跑 agent4 执行动作。"""
    return _run_executor(state)
