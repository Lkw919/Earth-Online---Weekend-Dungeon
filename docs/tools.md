# 完整 Tool 实现代码（含 Mock API 调用）

> 本文档汇总「地球 Online · 周末副本」后端工具层的全部实现，供评审核对工具调用链路与 Mock API 设计。
> 三个工具模块：
> - `backend/src/tools/amap.py`：高德地图封装（**真实接口优先，失败/无 Key 自动回退 Mock**）。
> - `backend/src/tools/mock_meituan.py`：美团本地生活下单/预约 **Mock API**。
> - `backend/src/tools/llm.py`：百炼（DashScope）LLM 封装（**仅作兜底/增强，主路径不依赖**）。

## 设计原则

1. **统一返回结构**：高德工具统一返回 `AmapResult(ok, source, data, error)`，`source ∈ {"amap","mock"}`，演示时可一眼区分真实数据与模拟数据。
2. **零 Key 可跑**：任何外部依赖（高德 / 百炼）失败、超时或缺 Key，都立即回退到内置 Mock / 规则，保证 Demo 全程不崩。
3. **快速失败**：高德 `DEFAULT_TIMEOUT=3s`；LLM `max_retries=0` + 短超时，避免「重试雪崩」拖垮「方案生成 ≤30s」约束。
4. **确定性可复现**：Mock 美团接口用 `sha256` 种子生成稳定 ID；唯独「是否有座」掺入高精度时间戳，让冲突偶发而非每次必现，便于自然演示冲突处理。

---

## 一、高德地图工具 `amap.py`

### 1.1 函数清单

| 函数 | 签名 | 用途 | 返回 `data` 关键字段 |
|---|---|---|---|
| `verify_district` | `(city, district=None)` | 校验行政区并取中心点 | `name / adcode / center / level` |
| `regeo` | `(location)` | 逆地理编码：`"lng,lat"` → 城市/区 | `city / district / formatted / location` |
| `geocode_place` | `(name, city)` | 地标/商圈名 → 坐标 | `location / formatted` |
| `resolve_landmark` | `(name, city, district=None)` | 地标 POI 解析（比 geocode 更准） | `location / name / formatted / query` |
| `search_pois` | `(city, keywords, district=None, radius_km=8.0, limit=6, origin=None, allow_mock=True)` | 关键字 POI 检索 | `List[POI]` |
| `search_pois_around` | `(origin, keywords, radius_km=3.0, ...)` | 按出发点半径检索 | `List[POI]` |
| `get_weather` | `(city, adcode=None)` | 实时天气 | `condition / temperature / humidity ...` |
| `format_distance` | `(meters)` | 距离展示格式化 | `str`（如 `1.2km` / `区内`） |

所有函数遵循同一套「真实优先 → 异常捕获 → 回退 Mock」的骨架。

### 1.2 统一返回结构与 Key 检测

```python
AMAP_BASE = "https://restapi.amap.com/v3"
DEFAULT_TIMEOUT = 3

@dataclass
class AmapResult:
    ok: bool
    source: str               # "amap" | "mock"
    data: Any
    error: Optional[str] = None

def _get_key() -> Optional[str]:
    key = os.getenv("AMAP_API_KEY")
    return key.strip() if key else None

def has_api_key() -> bool:
    return bool(_get_key())
```

### 1.3 行政区校验（真实优先 + Mock 回退，典型骨架）

```python
def verify_district(city: str, district: Optional[str] = None) -> AmapResult:
    """通过高德 /config/district 校验城市/区是否存在，并返回行政中心点。"""
    key = _get_key()
    keywords = district or city
    if key and keywords:
        try:
            resp = requests.get(
                f"{AMAP_BASE}/config/district",
                params={"key": key, "keywords": keywords, "subdistrict": 1, "extensions": "base"},
                timeout=DEFAULT_TIMEOUT,
            )
            payload = resp.json()
            if payload.get("status") == "1" and payload.get("districts"):
                d = payload["districts"][0]
                return AmapResult(ok=True, source="amap", data={
                    "name": d.get("name"), "adcode": d.get("adcode"),
                    "center": d.get("center"), "level": d.get("level"),
                })
            return AmapResult(ok=False, source="amap", data=None, error=payload.get("info", "amap_no_result"))
        except Exception as exc:                      # 网络异常 → 回退 Mock
            logger.warning("高德行政区接口失败，退回 Mock：%s", exc)
    return _mock_verify_district(city, district)       # 无 Key / 失败时的兜底


def _mock_verify_district(city, district) -> AmapResult:
    fake_center = {
        ("北京", "朝阳区"): "116.486409,39.921489",
        ("上海", "浦东新区"): "121.544379,31.221517",
        ("深圳", "南山区"): "113.930413,22.533155",
        ("广州", "天河区"): "113.361200,23.124700",
        ("杭州", "西湖区"): "120.130303,30.259244",
        # ...
    }
    center = fake_center.get((city or "", district or ""), "116.397428,39.90923")
    return AmapResult(ok=True, source="mock", data={
        "name": district or city or "默认城市", "adcode": "000000",
        "center": center, "level": "district" if district else "city",
    })
```

### 1.4 逆地理编码 `regeo`（浏览器定位入口，错误码透出）

```python
def regeo(location: str) -> AmapResult:
    """把「经度,纬度」坐标解析为城市/区。浏览器定位拿到坐标后反查 city/district。"""
    key = _get_key()
    if not (key and location and "," in location):
        return AmapResult(ok=False, source="mock", data=None, error="regeo_bad_input")
    try:
        resp = requests.get(
            f"{AMAP_BASE}/geocode/regeo",
            params={"key": key, "location": location, "extensions": "base"},
            timeout=max(DEFAULT_TIMEOUT, 6),
        )
        payload = resp.json()
        if payload.get("status") != "1":
            # 透出真实错误码（INVALID_USER_KEY / DAILY_QUERY_OVER_LIMIT / 未开通逆地理...）
            info, infocode = payload.get("info") or "unknown", payload.get("infocode") or ""
            return AmapResult(ok=False, source="mock", data=None, error=f"regeo_api_error:{info}({infocode})")
        if payload.get("regeocode"):
            comp = payload["regeocode"].get("addressComponent") or {}
            city = comp.get("city") or comp.get("province") or ""   # 直辖市 city 可能为空 → 回退 province
            if isinstance(city, list):
                city = comp.get("province") or ""
            district = comp.get("district") or ""
            return AmapResult(ok=True, source="amap", data={
                "city": str(city).replace("市", ""), "district": str(district),
                "formatted": payload["regeocode"].get("formatted_address", ""), "location": location,
            })
    except Exception as exc:
        logger.warning("高德逆地理编码失败：%s", exc)
    return AmapResult(ok=False, source="mock", data=None, error="regeo_failed")
```

### 1.5 POI 检索 `search_pois`（有出发点时按半径检索，否则按区域）

```python
def search_pois(city, keywords, district=None, radius_km=8.0, limit=6,
                origin=None, allow_mock=True) -> AmapResult:
    # 1) 有出发点：优先按半径检索（更贴近用户位置）
    if origin:
        around = search_pois_around(origin=origin, keywords=keywords, radius_km=radius_km,
                                    limit=limit, allow_mock=False, city=city, district=district)
        if around.ok and around.data:
            return around
    # 2) 区域文本检索
    key = _get_key()
    if key:
        try:
            resp = requests.get(f"{AMAP_BASE}/place/text", params={
                "key": key, "keywords": keywords, "city": district or city,
                "citylimit": "true", "offset": limit, "page": 1, "extensions": "all",
            }, timeout=DEFAULT_TIMEOUT)
            payload = resp.json()
            if payload.get("status") == "1":
                pois = [_parse_poi_item(it, keywords, origin) for it in (payload.get("pois") or [])[:limit]]
                if pois:
                    return AmapResult(ok=True, source="amap", data=pois)
        except Exception as exc:
            logger.warning("高德 POI 接口失败：%s", exc)
    # 3) allow_mock=False（如三桶并行内部）→ 返回空，让上层做关键词降级
    if not allow_mock:
        return AmapResult(ok=False, source="amap", data=[], error="no_result")
    # 4) 兜底：按关键词生成可演示 Mock POI（亲子/展览/小吃街/公园/餐厅/咖啡...）
    return _mock_search_pois(city, keywords, district, radius_km, limit, origin=origin)
```

> `_parse_poi_item` 会从高德 `biz_ext` 提取评分/人均、`photos` 提取首图，并补全到出发点的距离（`distance_meters`）。
> `_mock_search_pois` 内置一套按关键词分类的 POI 目录（亲子乐园、艺术展、小吃街、城市公园、餐厅、咖啡等），保证无 Key 时也有真实感的候选。

### 1.6 天气 `get_weather`

```python
def get_weather(city, adcode=None) -> AmapResult:
    key, query = _get_key(), (adcode or city)
    if key and query:
        try:
            resp = requests.get(f"{AMAP_BASE}/weather/weatherInfo",
                                params={"key": key, "city": query, "extensions": "base"},
                                timeout=DEFAULT_TIMEOUT)
            payload = resp.json()
            if payload.get("status") == "1" and payload.get("lives"):
                live = payload["lives"][0]
                return AmapResult(ok=True, source="amap", data={
                    "condition": live.get("weather", ""), "temperature": live.get("temperature", ""),
                    "humidity": live.get("humidity", ""), "city": live.get("city", city), # ...
                })
        except Exception as exc:
            logger.warning("高德天气接口失败，退回 Mock：%s", exc)
    return _mock_weather(city)   # 北京晴/上海多云/深圳阵雨... 影响 agent3 选室内/室外
```

---

## 二、美团本地生活 Mock API `mock_meituan.py`（完整源码）

> 这是工具层中**全部为模拟**的部分：比赛 Demo 不接真实下单，统一返回成功/失败结构，
> 让 `agent4_executor` 能演示完整闭环（含失败回退路径）。后续可整段替换为美团到店/到家/票务/出行真实接口。

```python
"""Mock 美团本地生活下单/预约接口。"""
from __future__ import annotations
import hashlib, os, random, time, uuid
from typing import Any, Dict, List, Optional


def _seed_key(*parts: Any) -> int:
    raw = "|".join(str(part or "") for part in (*parts, os.getenv("DEMO_SEED", "")))
    return int(hashlib.sha256(raw.encode("utf-8")).hexdigest()[:12], 16)


def _rng(*parts: Any) -> random.Random:
    return random.Random(_seed_key(*parts))


def _gen_id(prefix: str, *parts: Any) -> str:
    if parts:
        token = hashlib.sha256("|".join(str(p) for p in parts).encode("utf-8")).hexdigest()[:8]
        return f"{prefix}_{token}"
    return f"{prefix}_{uuid.uuid4().hex[:8]}"


def _safe_int(value: Any, default: int = 0) -> int:
    try:
        if value in (None, ""):
            return default
        return int(float(value))
    except (TypeError, ValueError):
        return default


def _has_seat_probability(poi_meta: Optional[Dict[str, Any]]) -> float:
    """有座概率：排队越久概率越低；不需预约的店概率也偏低（更可能满座）。"""
    if not poi_meta:
        return 0.75
    queue = _safe_int(poi_meta.get("queue_minutes"))
    if not poi_meta.get("needs_reservation", True):
        return 0.4
    if queue >= 35:
        return 0.35
    if queue >= 20:
        return 0.55
    return 0.82


def check_restaurant_availability(restaurant: str, party_size: int, time_slot: str,
                                  poi_meta: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """检查餐厅是否有位置/需要排队。

    「有没有座位」掺入高精度时间戳 time.time_ns() 作为随机种子，
    因此每次结果都不固定——大概率有座、偶尔无座触发冲突，
    用于自然演示冲突处理流程，而不是同一家店永远失败。
    """
    rng = _rng("restaurant", restaurant, time_slot, party_size, time.time_ns())
    has_seat = rng.random() < _has_seat_probability(poi_meta)
    base_queue = _safe_int((poi_meta or {}).get("queue_minutes"), rng.randint(15, 45))
    queue = 0 if has_seat else max(5, base_queue + rng.randint(-5, 8))
    return {
        "restaurant": restaurant, "party_size": party_size, "time_slot": time_slot,
        "has_seat": has_seat, "queue_minutes": queue,
        "checked_at": time.strftime("%Y-%m-%d %H:%M:%S"),
    }


def reserve_restaurant(restaurant: str, party_size: int, time_slot: str,
                       contact_phone: str = "13800000000", notes: Optional[str] = None,
                       poi_meta: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """模拟餐厅预订：有座 → success（含预约号）；无座 → fallback（建议线上排队/换备选）。"""
    avail = check_restaurant_availability(restaurant, party_size, time_slot, poi_meta)
    if avail["has_seat"]:
        return {
            "status": "success",
            "reservation_id": _gen_id("R", restaurant, party_size, time_slot),
            "restaurant": restaurant, "party_size": party_size, "time_slot": time_slot,
            "contact_phone": contact_phone, "notes": notes,
            "queue_minutes": _safe_int((poi_meta or {}).get("queue_minutes")),
            "price_per_person": (poi_meta or {}).get("price_per_person"),
        }
    return {
        "status": "fallback", "restaurant": restaurant,
        "queue_minutes": avail["queue_minutes"],
        "suggestion": "建议提前线上排队或改为附近备选餐厅",
    }


def queue_up_online(restaurant: str, party_size: int,
                    poi_meta: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """美团排队取号（无座兜底 / 最后一站自动取号）。"""
    rng = _rng("queue", restaurant, party_size)
    base_waiting = _safe_int((poi_meta or {}).get("queue_minutes"), rng.randint(8, 25))
    waiting = max(3, base_waiting + rng.randint(-4, 6))
    return {
        "status": "success", "queue_id": _gen_id("Q", restaurant, party_size),
        "restaurant": restaurant, "party_size": party_size,
        "estimated_wait_minutes": waiting,
        "tip": f"前面还有 {waiting} 桌，临近时会推送提醒",
    }


def book_ticket(activity: str, party_size: int, time_slot: str,
                poi_meta: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """活动票务预约，例如亲子乐园、展览。"""
    unit_price = _safe_int((poi_meta or {}).get("price_per_person"))
    return {
        "status": "success", "ticket_id": _gen_id("T", activity, party_size, time_slot),
        "activity": activity, "party_size": party_size, "time_slot": time_slot,
        "check_in": "凭短信二维码入场",
        "unit_price_yuan": unit_price, "total_yuan": unit_price * party_size,
    }


def schedule_delivery(item: str, address: str, deliver_at: str,
                      note: Optional[str] = None) -> Dict[str, Any]:
    """配送服务：例如把蛋糕/鲜花在某时间点送到餐厅（家庭场景惊喜）。"""
    return {
        "status": "success", "delivery_id": _gen_id("D", item, address, deliver_at),
        "item": item, "address": address, "deliver_at": deliver_at, "note": note,
        "courier_distance_meters": 1800, "on_time_probability": "预计准时率 95%",
    }


def hail_ride(origin: str, destination: str, depart_at: str,
              poi_meta: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """打车/接驳（前端「一键打车」入口对应）。"""
    distance = _safe_int((poi_meta or {}).get("distance_meters"), 3500)
    duration = (poi_meta or {}).get("duration_minutes")
    price = max(18, round(13 + distance / 1000 * 2.8))
    return {
        "status": "success", "ride_id": _gen_id("CAR", origin, destination, depart_at),
        "origin": origin, "destination": destination, "depart_at": depart_at,
        "distance_meters": distance, "duration_minutes": duration,
        "expected_price_yuan": price,
    }


def summarize_actions(actions: List[Dict[str, Any]]) -> str:
    """把执行结果整理成一句话总结，方便发给朋友/家人。"""
    parts = []
    for act in actions:
        if act.get("status") == "success":
            parts.append(f"✅ {act.get('summary', '完成')}")
        elif act.get("status") == "fallback":
            parts.append(f"⚠️ {act.get('summary', '已备选')}")
        else:
            parts.append(f"❌ {act.get('summary', '失败')}")
    return "；".join(parts)
```

### Mock API 返回状态约定

| `status` | 含义 | 触发场景 |
|---|---|---|
| `success` | 下单/预约成功 | 有座订座、购票、配送、打车 |
| `fallback` | 主方案失败，已走备选 | 餐厅无座 → 自动线上取号 |
| `failed` | 彻底失败（预留） | 真实接入后用 |

`agent4_executor` 据此把动作映射为前端图标：`✅ success / ⚠️ fallback / 📍 arranged(待定) / ⏳ pending / ❌ failed`。

---

## 三、LLM 封装 `llm.py`（完整源码）

> 主规划路径 `fixed_three` **不依赖 LLM**；LLM 仅用于意图增强与规划兜底。
> 关键设计：`max_retries=0` + 短超时，连不上百炼时**单次快速失败**回退规则，避免拖垮 30s 约束。

```python
"""DashScope（百炼）LLM 封装，使用 OpenAI 兼容接口。"""
from __future__ import annotations
import json, logging, os, re
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)
DEFAULT_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1"
PING_MODEL = "qwen3.6-flash"
# 单次 LLM 超时（秒）。连不上时尽快失败回退规则，而非默认 8s×重试导致单阶段卡 ~26s。
LLM_TIMEOUT = float(os.getenv("LLM_TIMEOUT", "8"))


def is_llm_configured() -> bool:
    return bool(os.getenv("DASHSCOPE_API_KEY", "").strip())


def get_client():
    """返回 OpenAI 兼容客户端；未配置 Key 时返回 None。max_retries=0 禁用重试。"""
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


def chat(messages: List[Dict[str, str]], *, model: str, **kwargs: Any) -> str:
    """调用 DashScope 对话接口，返回 assistant 文本。"""
    client = get_client()
    if client is None:
        raise RuntimeError("未配置 DASHSCOPE_API_KEY，请在 .env 中填写百炼 API Key")
    completion = client.chat.completions.create(
        model=model, messages=messages,
        timeout=kwargs.pop("timeout", LLM_TIMEOUT), **kwargs,
    )
    return completion.choices[0].message.content or ""


def extract_json(text: str) -> Dict[str, Any]:
    """从 LLM 回复中解析 JSON（兼容 ```json 代码块）。"""
    cleaned = text.strip()
    fence = re.search(r"```(?:json)?\s*([\s\S]*?)\s*```", cleaned)
    if fence:
        cleaned = fence.group(1).strip()
    return json.loads(cleaned)


def ping(model: str = PING_MODEL) -> str:
    """连通性测试，供 CLI 或调试使用。"""
    return chat([
        {"role": "system", "content": "You are a helpful assistant."},
        {"role": "user", "content": "你是谁？用一句话回答。"},
    ], model=model)
```

---

## 四、工具在调用链中的位置

```
agent2_location ── _collect_bucketed_pois (ThreadPoolExecutor max_workers=3)
   ├─ amap.regeo / verify_district / get_weather
   └─ amap.search_pois × {scenic, restaurant, cafe} 三桶并行，桶内关键词降级链

agent4_executor ── _execute_confirmed（用户「一键下单」确认后）
   ├─ mock_meituan.reserve_restaurant ──无座──► mock_meituan.queue_up_online
   ├─ mock_meituan.book_ticket          # 亲子/展览
   ├─ mock_meituan.schedule_delivery    # 家庭场景蛋糕鲜花
   └─ mock_meituan.hail_ride            # 打车接驳
```

更完整的 Planning 策略、工具链与异常处理见 [`design.md`](./design.md)。
