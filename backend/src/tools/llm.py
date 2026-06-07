"""DashScope（百炼）LLM 封装，使用 OpenAI 兼容接口。

环境变量（写在项目根目录 ``.env``）：
- ``DASHSCOPE_API_KEY``：百炼 API Key（必填）
- ``DASHSCOPE_BASE_URL``：默认 ``https://dashscope.aliyuncs.com/compatible-mode/v1``

模型名在各 Agent 代码文件中单独配置，便于按场景手动切换。
"""

from __future__ import annotations

import json
import logging
import os
import re
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)

DEFAULT_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1"
PING_MODEL = "qwen3.6-flash"  # CLI 连通性测试用模型，可在此手动更换

# 单次 LLM 调用的超时（秒）。百炼连不上时，我们希望尽快失败回退到规则，
# 而不是默认 8s × 重试，导致单阶段卡 ~26s、整体爆掉「方案生成≤30s」约束。
LLM_TIMEOUT = float(os.getenv("LLM_TIMEOUT", "8"))


def is_llm_configured() -> bool:
    key = os.getenv("DASHSCOPE_API_KEY", "").strip()
    return bool(key)


def get_client():
    """返回 OpenAI 兼容客户端；未配置 Key 时返回 None。

    关键：``max_retries=0`` 禁用 SDK 默认的 2 次重试。一旦百炼不可达，
    单次 ``LLM_TIMEOUT`` 秒内失败并交给上层回退规则，避免 8s×3≈26s 的卡顿。
    """
    api_key = os.getenv("DASHSCOPE_API_KEY", "").strip()
    if not api_key:
        return None

    from openai import OpenAI

    return OpenAI(
        api_key=api_key,
        base_url=os.getenv("DASHSCOPE_BASE_URL", DEFAULT_BASE_URL),
        timeout=LLM_TIMEOUT,
        max_retries=0,
    )


def chat(
    messages: List[Dict[str, str]],
    *,
    model: str,
    **kwargs: Any,
) -> str:
    """调用 DashScope 对话接口，返回 assistant 文本。``model`` 由调用方传入。"""
    client = get_client()
    if client is None:
        raise RuntimeError(
            "未配置 DASHSCOPE_API_KEY，请在 .env 中填写百炼 API Key"
        )

    completion = client.chat.completions.create(
        model=model,
        messages=messages,
        timeout=kwargs.pop("timeout", LLM_TIMEOUT),
        **kwargs,
    )
    content = completion.choices[0].message.content
    return content or ""


def extract_json(text: str) -> Dict[str, Any]:
    """从 LLM 回复中解析 JSON（兼容 ```json 代码块）。"""
    cleaned = text.strip()
    fence = re.search(r"```(?:json)?\s*([\s\S]*?)\s*```", cleaned)
    if fence:
        cleaned = fence.group(1).strip()
    return json.loads(cleaned)


def ping(model: str = PING_MODEL) -> str:
    """连通性测试，供 CLI 或调试使用。"""
    return chat(
        [
            {"role": "system", "content": "You are a helpful assistant."},
            {"role": "user", "content": "你是谁？用一句话回答。"},
        ],
        model=model,
    )
