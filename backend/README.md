# 后端 README · 多 Agent 规划与执行

后端负责把用户的一句话周末需求转成可执行的本地生活方案，并为前端提供实时 Agent 进度、路线结果、执行动作和冲突处理能力。

## 后端亮点

- `LangGraph` 编排 4 个 Agent，状态通过 `PlanState` 增量流转。
- 支持位置澄清：城市/区缺失时先追问，不盲目生成路线。
- 高德真实数据优先；无 Key、超时或失败时自动 Mock 回退。
- Planning 主路径稳定快速：三桶并行搜索 `scenic / restaurant / cafe`，再用 `fixed_three` 生成「景点 -> 餐厅 -> 咖啡」。
- Mock 美团接口覆盖订座、排队、票务、配送和打车，能演示完整交易闭环。
- FastAPI + SSE 将 Agent 过程实时推给前端，避免用户只看到 loading。

## 性能约束

| 指标 | 目标 | 后端策略 |
|---|---:|---|
| 方案生成 | <= 30 秒 | POI 三桶并行搜索；主路径本地排序，不依赖 LLM 长链路。 |
| 工具响应 | <= 3 秒 | 高德工具 `DEFAULT_TIMEOUT=3`；异常立即 Mock 回退。 |
| 端到端流程 | <= 2 分钟 | 前端预设降低输入成本；后端执行用 Mock API；最后一站延迟取号。 |

## 架构

```
agent1_intent
  -> agent2_location
      -> needs_clarification ? END : agent3_planner
  -> agent4_executor
  -> END
```

### Agent 职责

| Agent | 输入 | 输出 | 说明 |
|---|---|---|---|
| `agent1_intent` | 用户自然语言 | `intent` | 解析场景、人群、时长、出发时间、约束。 |
| `agent2_location` | `intent` + 用户补充 | `location`、`weather`、`candidate_places` | LLM/规则抽位置，高德校验，三桶搜索 POI。 |
| `agent3_planner` | 候选 POI | `plan_steps`、`plan_strategy` | fixed_three 主路径；LLM / rules 兜底。 |
| `agent4_executor` | 路线方案 | `suggested_actions`、`execution_actions` | 确认前只建议；确认后调用 Mock API。 |

## 工具调用链路

```
agent2_location
  -> tools.amap.verify_district
  -> tools.amap.resolve_landmark / geocode_place
  -> tools.amap.get_weather
  -> tools.amap.search_pois / search_pois_around
  -> tools.meituan_enrich.enrich_poi
  -> tools.poi_theme.filter_pois_for_scene

agent3_planner
  -> fixed_three
  -> LLM JSON fallback
  -> rules fallback

agent4_executor
  -> mock_meituan.reserve_restaurant
  -> mock_meituan.queue_up_online
  -> mock_meituan.book_ticket
  -> mock_meituan.schedule_delivery
  -> mock_meituan.hail_ride
```

## 异常处理

| 异常 | 处理 |
|---|---|
| 城市/区缺失 | 设置 `needs_clarification=True`，前端继续追问。 |
| 高德 Key 缺失 | 自动返回 `source=mock` 的 POI / 天气 / 距离。 |
| 高德网络失败或超时 | 捕获异常并 Mock 回退，保证 Demo 不空白。 |
| POI 过少或偏题 | 关键词降级链 + 城市特色兜底 + 场景主题过滤。 |
| LLM 不可用或 JSON 异常 | 回退 fixed_three / rules；LLM 不是主路径依赖。 |
| 餐厅无位 | 根据状态暂停冲突处理，或自动线上取号。 |
| 最后一站排号风险 | 最后一站标记为待定，核销上一站后再触发取号。 |

## 快速开始

### 1. 创建环境

```bash
conda create -n AI_Hackathon python=3.12 -y
conda activate AI_Hackathon
pip install -r requirements.txt
```

### 2. 配置环境变量

在项目根目录：

```bash
cp .env.example .env
```

可选配置：

```env
AMAP_API_KEY=
DEFAULT_CITY=
DEFAULT_DISTRICT=
DASHSCOPE_API_KEY=
DASHSCOPE_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
DEMO_SEED=42
```

所有 Key 都可以不填，不填时走 Mock / 规则逻辑。

### 3. 启动 API

```bash
uvicorn src.api.server:app --host 0.0.0.0 --port 8000 --env-file ../.env --reload
```

健康检查：

```bash
curl http://localhost:8000/health
```

## CLI 调试

家庭场景：

```bash
python -m src.main --goal "今天下午想带老婆孩子玩 4 小时，别离家太远，老婆在减肥" --city 北京 --district 朝阳区
```

朋友场景：

```bash
python -m src.main --scene friends --city 上海 --district 徐汇区
```

约会 / 独处 / 陪父母 / 宠物 / 自习：

```bash
python -m src.main --scene couple --city 郑州 --district 金水区 --origin 紫荆山附近
python -m src.main --scene solo --city 杭州 --district 西湖区
python -m src.main --scene parents --city 北京 --district 海淀区
python -m src.main --scene pet --city 深圳 --district 南山区
python -m src.main --scene study --city 上海 --district 浦东新区
```

## API 入口

主要接口在 `src/api/server.py`：

- `GET /health`：健康检查。
- `POST /api/plan/start`：创建规划，SSE 返回 Agent 进度。
- `POST /api/plan/clarify`：补充澄清信息。
- `POST /api/plan/execute`：确认执行 Mock API。
- `POST /api/plan/resolve-conflict`：处理冲突方案。
- `POST /api/location/regeo`：坐标反查位置。

## 关键文件

```
backend/
├── requirements.txt
├── src/
│   ├── graph.py                    # LangGraph 状态机
│   ├── state.py                    # PlanState / Intent / POI / PlanStep
│   ├── scenes.py                   # 场景配置
│   ├── api/
│   │   ├── server.py               # FastAPI 接口
│   │   └── events.py               # SSE 事件
│   ├── agents/
│   │   ├── agent1_intent.py
│   │   ├── agent2_location.py
│   │   ├── agent3_planner.py
│   │   └── agent4_executor.py
│   └── tools/
│       ├── amap.py                 # 高德工具 + Mock 回退
│       ├── meituan_enrich.py       # 美团侧演示字段补全
│       ├── mock_meituan.py         # Mock 美团 API
│       ├── poi_theme.py            # 场景主题过滤
│       └── llm.py                  # DashScope 封装
```

项目级文档在仓库根目录 [`docs/`](../docs/)（设计文档、Tool 实现代码、Demo 交付说明见根 [`README.md`](../README.md)）。

## 示例输出

```text
【家庭方案 · 北京朝阳区 · 今日晴 26°C】
数据来源：地点信息来自高德地图；订座、排队、价格为演示模拟。

行程安排：
  1. 14:00-16:00 景点 -> 中国科技馆
  2. 16:30-17:30 餐厅 -> 亲子轻食餐厅
  3. 18:00-19:00 咖啡店 -> 商场咖啡

建议动作（待确认）：
  · 建议购票 14:00-16:00 中国科技馆
  · 建议预约 16:30-17:30 亲子轻食餐厅
  · 建议 13:30 从朝阳区附近打车至中国科技馆
```
