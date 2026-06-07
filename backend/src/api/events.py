from __future__ import annotations

from collections.abc import Callable
from typing import Any

from ..state import PlanState

EventEmitter = Callable[[str, dict[str, Any]], None]


def emit_event(state: PlanState, event_type: str, payload: dict[str, Any]) -> None:
    emitter = state.get("debug", {}).get("event_emitter")
    if callable(emitter):
        emitter(event_type, payload)

