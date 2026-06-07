"""CLI 入口：地球 Online 周末副本 Demo。

运行方式：
    python -m src.main                          # 交互式
    python -m src.main --goal "下午带老婆孩子玩 4 小时"  # 直接传入

若 agent2 触发位置澄清，命令行会主动追问用户城市/区，再继续完成方案。
"""

from __future__ import annotations

import argparse
import logging
import os
import sys
from typing import Optional

try:
    from dotenv import load_dotenv

    load_dotenv()
except ImportError:  # pragma: no cover
    pass

from .agents.agent1_intent import _parse_intent_rules
from .graph import (
    build_graph,
    continue_executor_only,
    continue_from_location,
    continue_from_time,
)
from .scenes import default_goals
from .state import make_initial_state
from .tools.llm import is_llm_configured, ping


DEFAULT_GOALS = default_goals()


def _setup_logging(verbose: bool) -> None:
    level = logging.INFO if verbose else logging.WARNING
    logging.basicConfig(level=level, format="%(levelname)s %(name)s: %(message)s")


def run_demo(
    goal: str,
    *,
    city: Optional[str] = None,
    district: Optional[str] = None,
    origin: Optional[str] = None,
    start_time: Optional[str] = None,
    duration: Optional[float] = None,
    confirm: bool = False,
) -> None:
    graph = build_graph()
    state = make_initial_state(goal)
    state["confirm_actions"] = confirm
    if city:
        state.setdefault("location", {})["city"] = city
    if district:
        state.setdefault("location", {})["district"] = district
    if origin:
        loc = state.setdefault("location", {})
        loc["origin_label"] = origin

    if start_time or duration:
        intent = _parse_intent_rules(goal)
        if start_time:
            intent["start_time"] = start_time
        if duration:
            intent["duration_hours"] = float(duration)
        state["intent"] = intent

    final = graph.invoke(state)

    while final.get("needs_clarification"):
        topic = final.get("clarification_topic") or "location"
        default_question = (
            "请告诉我你打算几点出发、玩多久？"
            if topic == "time"
            else "请补充一下你的城市/区。"
        )
        question = final.get("clarification_question") or default_question
        print("\n" + question)
        try:
            user_input = input("你的回答 > ").strip()
        except EOFError:
            user_input = ""
        if topic == "location" and not user_input:
            print("未收到输入，使用默认城市 北京朝阳区。")
            user_input = "北京朝阳区"
        final["user_followup"] = user_input
        final["needs_clarification"] = False
        if topic == "time":
            final = continue_from_time(final)
        else:
            final = continue_from_location(final)

    if not final.get("confirm_actions") and final.get("suggested_actions"):
        print()
        print("【建议动作预览】")
        for act in final["suggested_actions"]:
            print(f"  · {act.get('detail')}")
        try:
            answer = input("\n是否模拟执行一键安排？(y/N) > ").strip().lower()
        except EOFError:
            answer = "n"
        if answer in ("y", "yes", "是"):
            final["confirm_actions"] = True
            final = continue_executor_only(final)

    print()
    print(final.get("final_message") or "未生成方案")

    if final.get("errors"):
        print("\n[warnings]")
        for err in final["errors"]:
            print(" - " + err)


def main(argv: Optional[list] = None) -> int:
    parser = argparse.ArgumentParser(description="地球 Online 周末副本 Demo")
    parser.add_argument("--goal", help="用户的一句自然语言目标")
    parser.add_argument(
        "--scene",
        choices=sorted(DEFAULT_GOALS.keys()),
        help="使用内置示例：family / friends / couple / solo / parents / pet / study",
    )
    parser.add_argument("--city", help="预设城市，跳过澄清")
    parser.add_argument("--district", help="预设区，跳过澄清")
    parser.add_argument("--origin", help="出发点描述，如「紫荆山附近」")
    parser.add_argument(
        "--start-time",
        dest="start_time",
        help="预设出发时间 HH:MM，跳过时间澄清",
    )
    parser.add_argument(
        "--duration",
        type=float,
        help="预设玩多久（小时），跳过时间澄清",
    )
    parser.add_argument(
        "--confirm",
        action="store_true",
        help="跳过确认，直接模拟执行一键安排",
    )
    parser.add_argument("-v", "--verbose", action="store_true", help="打印调试日志")
    parser.add_argument(
        "--test-llm",
        action="store_true",
        help="测试 DashScope 模型 API 是否配置正确",
    )
    args = parser.parse_args(argv)

    _setup_logging(args.verbose)

    if args.test_llm:
        if not is_llm_configured():
            print("未配置 DASHSCOPE_API_KEY，请在 .env 中填写。")
            return 1
        try:
            print(ping())
        except Exception as exc:
            print(f"调用失败: {exc}")
            return 1
        return 0

    if args.goal:
        goal = args.goal
    elif args.scene:
        goal = DEFAULT_GOALS[args.scene]
    else:
        print("请输入你的一句自然语言目标，回车确认（直接回车将使用家庭场景示例）：")
        try:
            goal = input("> ").strip()
        except EOFError:
            goal = ""
        if not goal:
            goal = DEFAULT_GOALS["family"]
            print(f"使用示例：{goal}")

    run_demo(
        goal,
        city=args.city,
        district=args.district,
        origin=args.origin,
        start_time=args.start_time,
        duration=args.duration,
        confirm=args.confirm,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
