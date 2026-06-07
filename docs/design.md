# 设计文档 · 地球 Online 周末副本

> 一句话产品：把「周末去哪玩」这件麻烦事，变成一句话就能开启、像玩游戏一样完成的城市副本。

---

## 0. 创意从哪来（为什么做这个）

我们观察到一个真实痛点：**Z 世代不是不想出门，而是「启动成本」太高**。
排队、做攻略、订座、规划路线、算时间这些琐事，把「想出去玩」的冲动一点点磨没了——
意愿在「要不要查攻略」这一步就被劝退。

所以我们换了一个思路：**不做又一个路线推荐工具，而是做一个把出门「游戏化」的轻量入口。**

- **从一句话开始**：用户只需要说「今天下午想带老婆孩子出去玩 4 小时」，或点几个 Chips，剩下交给「小团」向导。
- **用游戏的语言重新包装本地生活**：组队建档 → 今日主线任务 → Agent 托管执行 → 核销码 → 副本通关票据。
- **降低启动力门槛**：把「做攻略、排队、订座」这些繁琐事项交给 Agent 一键托管，用户只负责「出门通关」。

这套「一句话 + 游戏化」的组合，就是我们对四个评审维度的核心回答。

| 评审维度 | 我们的设计回应 |
|---|---|
| **创新性** | 不是推荐列表，而是「副本」体验：主线任务 / Agent 托管 / 核销通关 / 分享海报，把本地生活做成可完成的关卡。 |
| **完整性** | 覆盖从「一句话」到「执行前闭环」全链路：意图识别 → 位置澄清 → POI 搜索 → 路线规划 → 一键下单 → 冲突处理 → 实时核销。 |
| **应用效果** | 用户能看懂「为什么选这里、几点去、怎么转场、失败怎么办」；全程 SSE 可视化 Agent 思考过程，黑盒变白盒。 |
| **商业价值** | 推荐天然收口到美团可承接的交易：订座 / 排队取号 / 票务 / 配送 / 打车，路线即订单入口。 |

---

## 1. 总体架构

后端用 `LangGraph` 编排 4 个 Agent，全程共享一个 `PlanState`（`backend/src/state.py`，TypedDict，每个 Agent 只增量写入）；
前端用 React + SSE 实时把每个 Agent 的「思考过程」渲染成小团的对话气泡。

```
用户一句话 / Chips
   │  (FastAPI + SSE)
   ▼
agent1_intent     解析场景 / 人群 / 时间 / 硬约束
   │  needs_clarification? ──► END（前端追问时间/位置）
   ▼
agent2_location   位置澄清 + 高德行政区/天气/POI 三桶并行搜索
   │  needs_clarification? ──► END（前端追问城市/区）
   ▼
agent3_planner    fixed_three 本地排序生成 3~5 站路线（LLM 仅兜底）
   ▼
agent4_executor   先出「建议动作」，用户确认后调 Mock 美团接口
   ▼
前端              路线卡 / Agent 托管 / 冲突处理 / 核销通关
```

条件边由 `_route_after_intent` / `_route_after_location` 控制：缺信息就走 `END` 并带上人类可读的追问问题，
前端补充后通过 `continue_from_time` / `continue_from_location` 从断点续跑，**不重复解析意图**，省时间。

---

## 2. Planning 策略

### 2.1 意图层（agent1_intent）
- 关键词 + LLM 双通道识别 7 个场景：`family / friends / couple / solo / parents / pet / study`。
- 抽取时长、出发时间、人群结构（如 4 人 2 男 2 女、孩子 5 岁、老婆减肥）与硬约束（`near_home / afternoon / low_calorie / kid_friendly`）。
- 信息不足时不硬猜，置 `needs_clarification` 让前端追问，避免规划跑偏。

### 2.2 位置层（agent2_location）
- 位置来源优先级：用户原句 → 追问回答 → 浏览器定位 `regeo` 反查 → `.env` 默认值。
- 拿到城市/区后调 `amap.verify_district` 校验并取行政中心点（用于估距）。
- **三桶并行 POI 搜索**（`_collect_bucketed_pois`）：按场景定制「景点 / 餐厅 / 咖啡」三类专属关键词链，
  用 `ThreadPoolExecutor(max_workers=3)` 并行；桶内是降级链（命中即停），墙钟时间≈最慢的那个桶，**不随关键词增多线性增长**。
- 每个 POI 打上 `plan_bucket` 标签，供规划层直接分桶取用。候选过少时回退通用搜索 `_collect_pois`。

### 2.3 规划层（agent3_planner）—— 主路径 `fixed_three`
- **站数随时间自适应**（`_plan_step_count`）：
  - 上午出发（5–12 点）：默认 4 站，时长 ≥8h 给 5 站（全天）；
  - 时长 ≥8h（即便没明确上午）：≥4 站；
  - 其余（下午/晚上、半天）：3 站（景点→餐厅→咖啡）。
- **下午活动按场景定制**（`_afternoon_kind`）：约会/陪父母偏下午茶（cafe），其余偏再玩一个景点（scenic）。
- 每桶按 `(评分高, 距离近)` 排序挑选，下一站按「与上一站距离近」优先，避免跨城横跳；并记录 `alternative_poi` 备选点。
- **关键取舍**：主路径**不调 LLM**，耗时只取决于本地排序，扩展到 4–5 站也不新增高德请求 → 守住「方案生成 ≤30s」。LLM（`_plan_with_llm`）仅作兜底/增强。

### 2.4 执行层（agent4_executor）
- **建议与执行分离**：默认只产出 `suggested_actions`（待确认），用户「一键下单」后才 `_execute_confirmed` 调 Mock 接口。
- 按 POI 类别派发动作：餐厅→`reserve_restaurant`（无位自动 `queue_up_online` 兜底）、亲子/展览→`book_ticket`、咖啡/景点→`visit`（到店即可）。
- 场景增益：家庭场景追加 `schedule_delivery`（减糖鲜花蛋糕送达餐厅）；有出发点则追加 `hail_ride` 打车接驳。
- **最后一站永远「待定（arranged）」**：不提前预约/购票/检测冲突，待用户核销上一站后再自动取号，避免「过号」这一真实痛点。

---

## 3. 工具调用链路

```
agent2_location
  ├─ amap.regeo(location)                      # 浏览器坐标 → 城市/区（定位入口）
  ├─ amap.verify_district(city, district)      # 行政区校验 + 中心点
  ├─ amap.get_weather(city, adcode)            # 天气，影响室内/室外选点
  └─ amap.search_pois / search_pois_around     # 三桶并行 POI 检索

agent4_executor（用户确认后）
  ├─ mock_meituan.reserve_restaurant           # 订座
  ├─ mock_meituan.queue_up_online              # 无位兜底取号
  ├─ mock_meituan.book_ticket                  # 景点/展览票务
  ├─ mock_meituan.schedule_delivery            # 鲜花蛋糕配送
  └─ mock_meituan.hail_ride                    # 打车接驳
```

- 工具层统一返回结构里带 `source` 字段（`"amap"` / `"mock"`），演示时可清楚区分真实接口与模拟数据。
- 完整工具签名、参数与返回结构见同目录 [`tools.md`](./tools.md)。

---

## 4. 异常处理机制

| 情况 | 处理方式 | 守住的约束 |
|---|---|---|
| 用户没给城市/区/时间 | Agent 置 `needs_clarification`，前端追问，断点续跑不重解析 | 不跑偏 |
| 高德无 Key / 网络失败 / 超时 | 工具层 `try/except` 捕获 → 立即回退内置 Mock 数据并 log warning（`DEFAULT_TIMEOUT=3s`） | 工具响应 ≤3s |
| `regeo` 接口级错误 | 透出高德错误码（如 `INVALID_USER_KEY`），前端给可读提示并降级到手动输入定位 | 定位不至于静默失败 |
| POI 检索为空 | 桶内关键词降级链 → 仍空则回退通用搜索 → 再不足则放宽关键词 | 一定有候选 |
| 餐厅无空位 | 非最后一站：自动 `queue_up_online`，状态标 `fallback`；触发冲突时挂起等用户选择换店/删点/重排 | 展示失败回退路径 |
| LLM 超时/无 Key | `max_retries=0` + 短超时（默认 6s），主路径本就不依赖 LLM，直接走规则 | 方案生成 ≤30s |
| 任一 Agent 抛错 | 记入 `state.errors`，不影响其它已完成动作的展示 | 部分可用优于整体崩溃 |

设计原则：**任何外部依赖都有 Mock/规则兜底，不填任何 API Key 也能完整跑通 Demo。**

---

## 5. 可扩展点

- **真实交易闭环**：把 `tools/mock_meituan.py` 各函数替换为美团到店/到家/票务/出行真实 API（接口形态已对齐）。
- **多轮记忆**：给 `PlanState` 接 LangGraph `checkpointer`（Sqlite/Memory）做跨会话续聊。
- **个性化推荐**：在三桶排序里引入用户历史偏好/实时热度加权。
- **更强 LLM 增强**：把 `agent1` / `agent3` 升级为 `bind_tools` 的 Agent，让模型直接调工具做更灵活的编排。

## 6. 文件清单

| 文件 | 职责 |
|---|---|
| `backend/src/state.py` | 全局状态 `PlanState` 定义 |
| `backend/src/graph.py` | LangGraph 编排 + 断点续跑 |
| `backend/src/scenes.py` | 7 场景配置（关键词链 / 文案 / 规划提示） |
| `backend/src/agents/agent1_intent.py` | 意图识别 |
| `backend/src/agents/agent2_location.py` | 位置澄清 + 三桶并行 POI 搜索 |
| `backend/src/agents/agent3_planner.py` | `fixed_three` 路线规划（站数自适应） |
| `backend/src/agents/agent4_executor.py` | 建议动作 + Mock 执行 + 冲突挂起 |
| `backend/src/tools/amap.py` | 高德封装（真实优先，失败回退 Mock） |
| `backend/src/tools/mock_meituan.py` | 美团下单/预约 Mock API |
| `backend/src/api/server.py` | FastAPI + SSE 接口 |
