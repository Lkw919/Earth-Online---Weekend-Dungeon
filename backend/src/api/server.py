from __future__ import annotations

import copy
import json
import logging
import os
import queue
import uuid
from collections.abc import AsyncGenerator
from concurrent.futures import ThreadPoolExecutor
from typing import Any

try:
    from dotenv import load_dotenv

    load_dotenv()
except ImportError:
    pass

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from sse_starlette.sse import EventSourceResponse

logger = logging.getLogger(__name__)

from ..graph import build_graph, continue_executor_only, continue_from_location, continue_from_time
from ..state import PlanState, make_initial_state

app = FastAPI(title="Weekend Plan API", version="0.1.0")
graph = build_graph()
SESSIONS: dict[str, PlanState] = {}
_pool = ThreadPoolExecutor(max_workers=4)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Sentinel to signal end of stream
_STREAM_DONE = object()


def _with_emitter(state: PlanState, session_id: str, event_queue: queue.Queue) -> PlanState:
    wrapped = copy.deepcopy(state)
    debug = wrapped.setdefault("debug", {})

    def _emitter(event_type: str, payload: dict[str, Any]) -> None:
        event_queue.put({"event": event_type, "data": payload})

    debug["event_emitter"] = _emitter
    debug["session_id"] = session_id
    return wrapped


def _cleanup_state(state: PlanState) -> PlanState:
    clean = copy.deepcopy(state)
    debug = clean.get("debug")
    if isinstance(debug, dict):
        debug.pop("event_emitter", None)
    return clean


def _as_sse(event: str, data: dict[str, Any]) -> dict[str, str]:
    return {"event": event, "data": json.dumps(data, ensure_ascii=False)}


class StartPlanRequest(BaseModel):
    goal: str
    city: str | None = None
    district: str | None = None
    origin: str | None = None


class ClarifyRequest(BaseModel):
    session_id: str
    topic: str
    answer: str


class ExecuteRequest(BaseModel):
    session_id: str


class ResolveConflictRequest(BaseModel):
    session_id: str
    choice: int


def _emit_progress(q: queue.Queue, percent: int) -> None:
    q.put({"event": "progress", "data": {"percent": percent}})


def _run_start(req: StartPlanRequest, event_queue: queue.Queue) -> tuple[str, PlanState]:
    session_id = uuid.uuid4().hex
    print("=" * 60, flush=True)
    print(f"[START] 新规划请求 session_id={session_id}", flush=True)
    print(f"[START] goal={req.goal} city={req.city} district={req.district} origin={req.origin}", flush=True)
    print(f"[START] AMAP_API_KEY: {'已配置' if os.getenv('AMAP_API_KEY', '').strip() else '未配置'}", flush=True)
    print(f"[START] DASHSCOPE_API_KEY: {'已配置' if os.getenv('DASHSCOPE_API_KEY', '').strip() else '未配置'}", flush=True)
    state = make_initial_state(req.goal)
    if req.city:
        state.setdefault("location", {})["city"] = req.city
    if req.district:
        state.setdefault("location", {})["district"] = req.district
    if req.origin:
        loc = state.setdefault("location", {})
        loc["origin_label"] = req.origin

    state = _with_emitter(state, session_id, event_queue)
    from ..api.events import emit_event
    has_amap = bool(os.getenv("AMAP_API_KEY", "").strip())
    has_llm = bool(os.getenv("DASHSCOPE_API_KEY", "").strip())
    emit_event(state, "agent_step", {
        "stage": "start",
        "phase": "info",
        "message": f"新规划请求 session_id={session_id}",
        "logs": [
            f"[START] 新规划请求 session_id={session_id}",
            f"[START] goal={req.goal} city={req.city} district={req.district} origin={req.origin}",
            f"[START] AMAP_API_KEY: {'已配置' if has_amap else '未配置'}",
            f"[START] DASHSCOPE_API_KEY: {'已配置' if has_llm else '未配置'}",
        ],
        "summary": "已收到你的需求，正在为你规划行程...",
    })

    _emit_progress(event_queue, 15)

    final = graph.invoke(state)
    final = _cleanup_state(final)
    SESSIONS[session_id] = final

    _emit_progress(event_queue, 100)
    if final.get("needs_clarification"):
        event_queue.put(
            {
                "event": "needs_clarification",
                "data": {
                    "session_id": session_id,
                    "topic": final.get("clarification_topic") or "location",
                    "question": final.get("clarification_question") or "请补充信息",
                },
            }
        )
    else:
        event_queue.put({"event": "plan_ready", "data": {"session_id": session_id, "plan_state": final}})
        event_queue.put({"event": "suggested_actions", "data": {"actions": final.get("suggested_actions") or []}})
        event_queue.put({"event": "done", "data": {"final_message": final.get("final_message") or ""}})
    print(f"[START] 规划完成 session_id={session_id} needs_clarification={final.get('needs_clarification')} "
          f"plan_steps={len(final.get('plan_steps') or [])}", flush=True)
    print("=" * 60, flush=True)
    return session_id, final


def _run_clarify(req: ClarifyRequest, event_queue: queue.Queue) -> PlanState:
    current = SESSIONS.get(req.session_id)
    if not current:
        raise HTTPException(status_code=404, detail="session_id not found")

    current["user_followup"] = req.answer
    current["needs_clarification"] = False
    state = _with_emitter(current, req.session_id, event_queue)

    _emit_progress(event_queue, 15)

    if req.topic == "time":
        final = continue_from_time(state)
    else:
        final = continue_from_location(state)
    final = _cleanup_state(final)
    SESSIONS[req.session_id] = final

    _emit_progress(event_queue, 100)
    if final.get("needs_clarification"):
        event_queue.put(
            {
                "event": "needs_clarification",
                "data": {
                    "session_id": req.session_id,
                    "topic": final.get("clarification_topic") or "location",
                    "question": final.get("clarification_question") or "请补充信息",
                },
            }
        )
    else:
        event_queue.put({"event": "plan_ready", "data": {"session_id": req.session_id, "plan_state": final}})
        event_queue.put({"event": "suggested_actions", "data": {"actions": final.get("suggested_actions") or []}})
        event_queue.put({"event": "done", "data": {"final_message": final.get("final_message") or ""}})
    return final


def _build_conflict_options(step: dict[str, Any]) -> list[dict[str, Any]]:
    alt = step.get("alternative_name") or "附近轻食备选"
    title = step.get("title") or "该节点"
    return [
        {
            "title": "换一家排队更短的店",
            "desc": f"切换到 {alt}，保持后续时间节点不变。",
            "tags": ["推荐", "排队更短", "不影响后续行程"],
            "recommended": True,
        },
        {
            "title": "延后 30 分钟再尝试",
            "desc": f"保留原 {title}，稍后再重试排号。",
            "tags": ["保留原店", "稍后重试"],
            "recommended": False,
        },
        {
            "title": "跳过该节点",
            "desc": "直接前往下一站，执行链路继续推进。",
            "tags": ["节省时间", "重新规划"],
            "recommended": False,
        },
    ]


def _run_execute(req: ExecuteRequest, event_queue: queue.Queue) -> PlanState:
    current = SESSIONS.get(req.session_id)
    if not current:
        raise HTTPException(status_code=404, detail="session_id not found")

    current["confirm_actions"] = True
    current["wait_conflict_resolution"] = True
    current.setdefault("debug", {}).pop("conflict", None)
    state = _with_emitter(current, req.session_id, event_queue)
    final = continue_executor_only(state)
    final = _cleanup_state(final)
    SESSIONS[req.session_id] = final

    for idx, action in enumerate(final.get("execution_actions") or []):
        event_queue.put(
            {
                "event": "action_progress",
                "data": {
                    "index": idx,
                    "status": action.get("status"),
                    "detail": action.get("detail"),
                },
            }
        )

    conflict = final.get("debug", {}).get("conflict")
    if conflict:
        step = conflict.get("step") or {}
        event_queue.put(
            {
                "event": "conflict",
                "data": {
                    "session_id": req.session_id,
                    "reason": conflict.get("reason") or "排号冲突",
                    "step_index": int(conflict.get("step_index") or 0),
                    "options": _build_conflict_options(step),
                },
            }
        )
        return final

    event_queue.put({"event": "done", "data": {"final_message": final.get("final_message") or ""}})
    return final


def _run_resolve_conflict(req: ResolveConflictRequest, event_queue: queue.Queue) -> PlanState:
    current = SESSIONS.get(req.session_id)
    if not current:
        raise HTTPException(status_code=404, detail="session_id not found")

    debug = current.setdefault("debug", {})
    conflict = debug.get("conflict") or {}
    step_index = int(conflict.get("step_index") or 0)
    steps = current.get("plan_steps") or []
    if 0 <= step_index < len(steps):
        step = steps[step_index]
        if req.choice == 0 and (step.get("alternative_poi") or step.get("alternative_name")):
            alt_poi = step.get("alternative_poi")
            if alt_poi:
                # 整体替换为备选 POI(含名称/坐标/地址/距离),地图与列表才会真正切到新店
                step["poi"] = dict(alt_poi)
            else:
                poi = dict(step.get("poi") or {})
                poi["name"] = step["alternative_name"]
                step["poi"] = poi
            step["note"] = "已替换为排队更短的同类型店，后续行程不变。"
            step["alternative_poi"] = None
            step["alternative_name"] = None
        elif req.choice == 2:
            steps.pop(step_index)
            for idx, s in enumerate(steps):
                s["order"] = idx + 1
        current["plan_steps"] = steps

    current["confirm_actions"] = True
    current["wait_conflict_resolution"] = False
    debug.pop("conflict", None)
    state = _with_emitter(current, req.session_id, event_queue)
    final = continue_executor_only(state)
    final = _cleanup_state(final)
    SESSIONS[req.session_id] = final

    # 先把更新后的完整方案推给前端,让地图/地点/执行列表整体重建(换店后真正生效)
    event_queue.put(
        {"event": "plan_ready", "data": {"session_id": req.session_id, "plan_state": final}}
    )

    for idx, action in enumerate(final.get("execution_actions") or []):
        event_queue.put(
            {
                "event": "action_progress",
                "data": {
                    "index": idx,
                    "status": action.get("status"),
                    "detail": action.get("detail"),
                },
            }
        )
    event_queue.put({"event": "done", "data": {"final_message": final.get("final_message") or ""}})
    return final


async def _stream_from_queue(q: queue.Queue) -> AsyncGenerator[dict[str, str], None]:
    """Real-time SSE: yield events as they are produced by the worker thread."""
    import asyncio
    loop = asyncio.get_event_loop()
    while True:
        try:
            item = q.get_nowait()
        except queue.Empty:
            await asyncio.sleep(0.05)
            continue
        if item is _STREAM_DONE:
            break
        yield _as_sse(item["event"], item["data"])


def _run_in_thread(fn, *args):
    """Run sync fn in thread pool, push result/error into queue, then sentinel."""
    q: queue.Queue = queue.Queue()

    def _worker():
        try:
            fn(*args, q)
        except HTTPException as exc:
            q.put({"event": "error", "data": {"message": exc.detail}})
        except Exception as exc:
            q.put({"event": "error", "data": {"message": str(exc)}})
        finally:
            q.put(_STREAM_DONE)

    _pool.submit(_worker)
    return q


@app.get("/health")
def health() -> dict[str, bool]:
    return {"ok": True}


class LocateRequest(BaseModel):
    lng: float
    lat: float


@app.post("/api/locate")
def locate(req: LocateRequest) -> dict[str, Any]:
    """浏览器定位拿到经纬度后,逆地理编码成 city/district 供规划使用。"""
    from ..tools import amap

    coord = f"{req.lng},{req.lat}"
    result = amap.regeo(coord)
    print(f"[LOCATE] coord={coord} ok={result.ok} err={result.error} data={result.data}", flush=True)
    if result.ok and result.data:
        return {
            "ok": True,
            "city": result.data.get("city", ""),
            "district": result.data.get("district", ""),
            "formatted": result.data.get("formatted", ""),
            "coord": coord,
        }
    return {"ok": False, "error": result.error or "regeo_failed", "coord": coord}


@app.post("/api/plan/start")
async def start_plan(req: StartPlanRequest) -> EventSourceResponse:
    q = _run_in_thread(_run_start, req)
    return EventSourceResponse(_stream_from_queue(q))


@app.post("/api/plan/clarify")
async def clarify_plan(req: ClarifyRequest) -> EventSourceResponse:
    q = _run_in_thread(_run_clarify, req)
    return EventSourceResponse(_stream_from_queue(q))


@app.post("/api/plan/execute")
async def execute_plan(req: ExecuteRequest) -> EventSourceResponse:
    q = _run_in_thread(_run_execute, req)
    return EventSourceResponse(_stream_from_queue(q))


@app.post("/api/plan/resolve-conflict")
async def resolve_conflict(req: ResolveConflictRequest) -> EventSourceResponse:
    q = _run_in_thread(_run_resolve_conflict, req)
    return EventSourceResponse(_stream_from_queue(q))


@app.post("/api/plan/start-sync")
def start_plan_sync(req: StartPlanRequest) -> dict[str, Any]:
    import queue as _q
    q: _q.Queue = _q.Queue()
    session_id, final = _run_start(req, q)
    return {"session_id": session_id, "plan_state": final}
