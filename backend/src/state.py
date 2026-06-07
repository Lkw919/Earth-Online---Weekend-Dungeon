"""LangGraph 全局状态定义。

PlanState 在节点之间流转：意图 → 位置澄清 → 活动/餐饮规划 → 执行下单。
所有字段都使用 Optional/默认值，便于增量填充。
"""

from __future__ import annotations

from typing import Any, Dict, List, Literal, Optional, TypedDict


class Member(TypedDict, total=False):
    role: str            # 例如 "大人", "孩子", "朋友"
    age: Optional[int]
    note: Optional[str]  # 例如 "减肥", "对花生过敏"


class Intent(TypedDict, total=False):
    scene: Literal[
        "family", "friends", "couple", "solo", "parents", "pet", "study", "unknown"
    ]
    duration_hours: float
    start_time: Optional[str]
    members: List[Member]
    constraints: List[str]
    raw_goal: str


class Location(TypedDict, total=False):
    city: Optional[str]
    district: Optional[str]
    origin: Optional[str]          # 出发点坐标 "lng,lat"
    origin_label: Optional[str]    # 用户描述，如「紫荆山附近」
    radius_km: float               # 出行半径
    adcode: Optional[str]


class Weather(TypedDict, total=False):
    condition: str            # 晴/雨/多云
    temperature: str
    winddirection: str
    windpower: str
    humidity: str
    reporttime: str
    city: str
    source: Literal["amap", "mock"]


class POI(TypedDict, total=False):
    name: str
    category: str             # 例如 "亲子乐园", "餐厅", "展览"
    address: str
    location: Optional[str]   # POI 坐标 "lng,lat"
    distance_meters: int
    duration_minutes: Optional[float]
    rating: float
    tags: List[str]
    suitable_for: List[str]
    queue_minutes: Optional[int]
    needs_reservation: bool
    price_per_person: Optional[float]
    source: Literal["amap", "mock", "meituan_mock"]
    meituan_simulated: bool
    plan_bucket: str          # 固定3步分类标签: "scenic" | "restaurant" | "cafe"


class PlanStep(TypedDict, total=False):
    order: int
    time_range: str
    title: str
    poi: POI
    note: str
    selected_reason: Optional[str]
    alternative_name: Optional[str]
    alternative_poi: Optional[POI]   # 冲突换店时使用的完整备选 POI(含坐标/地址)


class ExecutionAction(TypedDict, total=False):
    action: str               # reserve / order / queue / delivery / ride / visit
    target: str
    status: Literal["pending", "success", "fallback", "failed", "suggested", "arranged"]
    detail: str
    confirmed: bool


class PlanStrategy(TypedDict, total=False):
    route_summary: str
    budget_estimate: Optional[float]
    budget_detail: str
    transport_tip: str
    risk_tips: List[str]
    alternatives: List[str]


class PlanState(TypedDict, total=False):
    user_goal: str
    intent: Intent
    location: Location
    weather: Weather
    needs_clarification: bool
    clarification_topic: Optional[Literal["location", "time"]]
    clarification_question: Optional[str]
    user_followup: Optional[str]   # 用户对澄清问题的回答
    candidate_places: List[POI]
    plan_steps: List[PlanStep]
    plan_strategy: PlanStrategy
    suggested_actions: List[ExecutionAction]
    execution_actions: List[ExecutionAction]
    confirm_actions: bool
    final_message: Optional[str]
    errors: List[str]
    debug: Dict[str, Any]
    wait_conflict_resolution: bool


def make_initial_state(user_goal: str) -> PlanState:
    return {
        "user_goal": user_goal,
        "intent": {},
        "location": {"radius_km": 8.0},
        "weather": {},
        "needs_clarification": False,
        "clarification_topic": None,
        "clarification_question": None,
        "user_followup": None,
        "candidate_places": [],
        "plan_steps": [],
        "plan_strategy": {},
        "suggested_actions": [],
        "execution_actions": [],
        "confirm_actions": False,
        "final_message": None,
        "errors": [],
        "debug": {},
        "wait_conflict_resolution": False,
    }
