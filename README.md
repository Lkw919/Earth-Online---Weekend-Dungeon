# 地球 Online · 周末副本

## English summary

A Meituan AI hackathon project that turns "where should I go this weekend?" into an executable city quest. The user teams up with an in-app guide, gives one sentence or taps a few chips, and gets back an explainable itinerary plus a one-click execution path — queue numbers, ticket bookings, taxi pickups, each behind a real tool interface with a mock implementation — ending in a redeemable voucher. The same run is wrapped as a game: team building, a main quest, agent-managed errands, and a ticket you can hand in at the end.

- **Stack:** LangGraph (four agents) · FastAPI · React mobile client · SSE progress stream
- **Budgets:** plan generated in ≤ 30 s (POI search in three parallel buckets, ranked locally), tool call ≤ 3 s (AMap with a 3 s timeout and a mock fallback), end to end ≤ 2 min
- **Start here:** [design](docs/design.md) · [tool catalogue](docs/tools.md)

美团 AI 黑客松项目：把「周末去哪玩」从普通路线推荐升级为一场可执行的城市副本。用户和专属向导「小团」组队，只需要一句自然语言或几次点击，就能得到可解释的路线、一键托管的执行动作、排号/票务/打车等 Mock API 闭环，以及最终的核销通关票据。

## 文档入口（打开项目先看这里）

| 文档 | 路径 |
|---|---|
| **设计文档**（≤2 页，交比赛用） | [`docs/design.md`](docs/design.md) |
| **Tool 完整实现代码**（含 Mock API） | [`docs/tools.md`](docs/tools.md) |
| **文档索引** | [`docs/README.md`](docs/README.md) |
| 后端说明 | [`backend/README.md`](backend/README.md) |
| 前端说明 | [`fronted/README.md`](fronted/README.md) |

## 创意从哪来

我们发现一个真实现象：**Z 世代不是不想出门，而是「启动成本」太高**——排队、做攻略、订座、规划路线这些琐事，把「想出去玩」的冲动在「要不要查攻略」这一步就磨没了，出门意愿太低。

所以我们没有再做一个路线推荐工具，而是换了一个思路：

> **从一句话开始，用游戏的方式，让本地生活轻量地走进用户的周末。**

- **一句话入口**：说一句「今天下午想带老婆孩子出去玩 4 小时」，剩下交给小团。
- **游戏化包装**：组队建档 → 今日主线任务 → Agent 托管执行 → 核销码 → 副本通关票据 + 分享海报。
- **降低启动力门槛**：把做攻略、排队、订座这些繁琐事项交给 Agent 一键托管，用户只负责出门通关。

这套「一句话 + 游戏化」就是我们的核心亮点，也是对四个评审维度的统一回答。

## 项目亮点

| 评审维度 | 我们的亮点 | 对应实现 |
|---|---|---|
| 创新性 | 用「地球 Online · 周末副本」包装本地生活行程：组队、主线任务、Agent 托管、核销码、副本通关。 | 手机端游戏化 UI、小团 IP、任务卡、通关票据、分享海报。 |
| 完整性 | 覆盖从需求输入到执行前闭环：意图识别、位置澄清、POI 搜索、路线规划、一键下单、冲突处理、实时任务。 | LangGraph 4 Agent + FastAPI + React 移动端。 |
| 应用效果 | 用户能看懂「为什么选这里、几点去、怎么转场、失败后怎么办」。 | 路线卡、距离/时长、备选点、预算、风险提示、SSE 进度。 |
| 商业价值 | 将推荐自然转化为美团可承接的交易链路。 | 餐厅订座/排队、景点票务、鲜花蛋糕配送、打车接驳 Mock API。 |

## 速度约束

| 约束 | 目标 | 实现方式 |
|---|---:|---|
| 方案生成 | <= 30 秒 | 主路径使用三桶并行 POI 搜索 + `fixed_three` 本地排序，LLM 仅作兜底。 |
| 工具响应 | <= 3 秒 | 高德工具 `DEFAULT_TIMEOUT=3`；无 Key 或失败时立即回退 Mock。 |
| 端到端流程 | <= 2 分钟 | Chips 降低输入成本；一键下单使用 Mock API；最后一站延迟取号避免过号。 |

## 体验流程

```
副本启动
  -> 选择目的/城市或输入自然语言
  -> 小团实时展示 Agent 进度
  -> 生成今日主线任务：景点 -> 餐厅 -> 咖啡
  -> 一键下单：订座 / 排队 / 票务 / 配送 / 打车
  -> 发现冲突：换店 / 删点 / 重排
  -> 副本进行中：地图 + 实时任务 + 核销码
  -> 核销最后一站：生成副本通关票据
```

## 技术架构

```
用户输入（一句话 / Chips）
  -> agent1_intent      解析 7 场景、人群、时间、硬约束（缺信息则前端追问）
  -> agent2_location    城市/区澄清 + 浏览器定位反查，高德行政区/天气/三桶并行 POI 搜索
  -> agent3_planner     fixed_three 本地排序生成 3~5 站路线（站数随时长自适应，LLM 仅兜底）
  -> agent4_executor    先出建议动作，用户「一键下单」后调用 Mock 美团接口
  -> 前端展示           SSE 进度、路线卡、托管执行、冲突处理、核销通关
```

支持的 7 个场景：家庭 / 朋友 / 约会 / 独自放空 / 陪父母 / 带宠物 / 自习办公。
站数策略：上午出发默认 4 站、≥8h 全天 5 站，下午/半天 3 站（景点→餐厅→咖啡）。

核心目录：

```
.
├── README.md          ← 你正在看的：项目总览 + Demo 交付说明
├── docs/
│   ├── design.md      ← 设计文档（交比赛）
│   └── tools.md       ← Tool 完整实现代码
├── backend/           Python 后端：LangGraph 多 Agent + FastAPI
├── fronted/           React 前端：手机端游戏化 Web UI（主 Demo）
├── restart-backend.sh / restart-frontend.sh   一键重启脚本
└── .env.example       环境变量模板；不填 Key 也能 Mock 演示
```

## 快速启动

### 1. 配置环境变量

```bash
cp .env.example .env
```

API Key 均可选；未填写时自动走 Mock / 规则逻辑：

- `AMAP_API_KEY`：高德 Web 服务，后端 POI / 天气 / 地标解析。
- `VITE_AMAP_JS_KEY` / `VITE_AMAP_SECURITY_CODE`：前端高德地图。
- `DASHSCOPE_API_KEY`：百炼大模型，未配置时走规则兜底。

### 2. 启动后端

```bash
conda activate AI_Hackathon
cd backend
pip install -r requirements.txt
uvicorn src.api.server:app --host 0.0.0.0 --port 8000 --env-file ../.env --reload
```

健康检查：

```bash
curl http://localhost:8000/health
```

### 3. 启动前端

```bash
cd fronted
npm install --legacy-peer-deps
npm run dev -- --host
```

浏览器打开：

```text
http://localhost:5173
```

建议用手机端视口查看，例如 iPhone 14 Pro。前端通过 Vite 代理把 `/api` 和 `/health` 转发到 `localhost:8000`。

也可使用项目根目录的一键脚本：

```bash
./restart-backend.sh    # 终端 1：启动后端
./restart-frontend.sh   # 终端 2：启动前端
```

### 备选：命令行 Demo（无需前端）

```bash
conda activate AI_Hackathon
cd backend
PYTHONPATH=. python -m src.main --goal "今天下午想带老婆孩子出去玩 4 小时"
```

## Demo 怎么交（交付目标）

比赛要求「Demo（命令行 / Web UI 均可）」——**你们的主交付是 Web UI**，命令行是备选。

### 需要提交什么

通常交 **完整源码 + 可运行说明**（具体以组委会表单为准）：

1. **源码包**：Git 仓库链接，或打包整个项目文件夹为 `.zip`（**不要包含** `node_modules/`、`__pycache__/`、`.env` 真实密钥）。
2. **README**：就是本文件 + [`docs/design.md`](docs/design.md) + [`docs/tools.md`](docs/tools.md)，评委按「快速启动」能跑起来即可。
3. **（可选但推荐）演示视频**：1~3 分钟录屏，走一遍「开始副本 → 生成路线 → 一键下单 → 核销通关」。

### 评委/组委会怎么跑你们的 Demo

**方式 A：Web UI（推荐，现场展示用这个）**

1. `cp .env.example .env`（Key 可不填，走 Mock）
2. 启动后端 `8000` + 前端 `5173`
3. 浏览器打开 `http://localhost:5173`，手机视口或真机访问
4. 演示路径：开始副本 → 选目的/城市 → 看 Agent 进度 → 今日主线任务 → 一键下单 → 副本进行中 → 核销通关

**方式 B：命令行（网络/UI 出问题时备用）**

```bash
cd backend && PYTHONPATH=. python -m src.main
```

### 现场答辩一句话

> 我们交付的是 **Web 端游戏化 Demo**（地球 Online 周末副本），后端 LangGraph 四 Agent + Mock 美团交易闭环；源码和文档在仓库根目录 `docs/` 下，不填 API Key 也能完整演示。

## Demo 建议话术

可以直接输入：

```text
今天下午想带老婆孩子出去玩 4 小时，别离家太远，老婆在减肥
```

也可以用前端 Chips 快速选择：

```text
带娃玩 -> 北京·朝阳 -> 生成路线 -> 一键下单 -> 开始副本 -> 核销通关
```

## Mock API 覆盖

`backend/src/tools/mock_meituan.py` 已模拟：

- `reserve_restaurant`：餐厅订座。
- `queue_up_online`：线上取号排队。
- `book_ticket`：景点/展览票务。
- `schedule_delivery`：鲜花蛋糕配送。
- `hail_ride`：打车接驳。

这些接口当前用于比赛 Demo，后续可替换为真实美团到店、到家、票务和出行 API。

## 更多文档

见顶部 [文档入口](#文档入口打开项目先看这里)，或 [`docs/README.md`](docs/README.md)。
