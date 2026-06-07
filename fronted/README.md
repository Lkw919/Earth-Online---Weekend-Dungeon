# 前端 README · 地球 Online 周末副本

这是「地球 Online · 周末副本」的移动端前端。它不是普通表单页面，而是把多 Agent 规划过程包装成可感知的游戏化体验：小团向导、组队建档、今日主线任务、Agent 托管执行、冲突处理、核销码和副本通关票据。

## 前端亮点

| 模块 | 用户看到什么 | 背后的价值 |
|---|---|---|
| 副本启动 | 「地球 Online」「周末副本·组队中」开屏，小团 IP 出场。 | 快速建立创意记忆点，区别于普通路线推荐。 |
| 组队建档 | Chips 选择目的和城市，也支持自然语言输入。 | 降低输入门槛，适合现场快速 Demo。 |
| Agent 进度 | SSE 气泡显示理解需求、搜索场所、规划路线、生成执行动作。 | 让工具链从黑盒变成可见过程。 |
| 今日主线任务 | 地点卡、时间段、距离/时长、标签、备选点和一键下单。 | 让用户理解路线原因和转场逻辑。 |
| Agent 托管 | 检查营业、排号、门票、提醒；冲突时进入解决方案页。 | 展示异常处理，而不是只展示成功路径。 |
| 副本进行中 | 高德地图路线、实时任务卡、核销码、一键打车入口。 | 从规划延伸到真实执行。 |
| 副本通关 | 最后一站核销后生成虚拟打卡票据和分享海报。 | 增加留存和社交传播点。 |

## 运行方式

先确保后端运行在 `http://localhost:8000`，再启动前端：

```bash
cd fronted
npm install --legacy-peer-deps
npm run dev -- --host
```

打开：

```text
http://localhost:5173
```

建议使用手机端视口查看，例如 iPhone 14 Pro。Vite 已配置代理：

- `/api` -> `http://localhost:8000`
- `/health` -> `http://localhost:8000`

## 环境变量

前端地图能力依赖项目根目录 `.env`：

```env
VITE_AMAP_JS_KEY=
VITE_AMAP_SECURITY_CODE=
```

未配置时，路线仍可展示为任务卡；地图组件会显示加载失败或数据不可用状态，不影响主流程 Demo。

## 页面流程

```
intro
  -> setup / chat
  -> result
  -> detail
  -> agent-processing
  -> conflict-detected / conflict-resolve
  -> agent-execution
  -> voucher
  -> mission-complete / success-completion
```

关键视图说明：

- `intro`：品牌开屏和副本启动。
- `setup` / `chat`：收集目的、城市或自然语言需求。
- `result`：展示专属路线和今日主线任务。
- `agent-processing`：小团接管执行，展示工具调用进度。
- `conflict-resolve`：展示排号或订座冲突的替代方案。
- `agent-execution`：副本进行中，包含地图、任务卡和核销入口。
- `voucher`：核销码/排号凭证。
- `mission-complete`：副本通关结果页和虚拟票据。

## API 对接

主要 API 封装在 `src/app/lib/api.ts`：

- `startPlan`：创建规划会话，接收 SSE 事件。
- `clarifyPlan`：补充位置或时间澄清。
- `executePlan`：确认执行，一键下单 Mock API。
- `resolveConflict`：处理冲突方案。
- `locateByCoords`：坐标反查城市/区。

后端返回的 `PlanState` 会在 `src/app/lib/adapter.ts` 中适配为 UI 数据：

- `UiPlace`：路线地点卡。
- `UiSegment`：转场距离/时间。
- `UiExecutionTask`：执行任务和核销状态。
- `buildConflictSolutions`：冲突解决方案。

## 目录结构

```
fronted/
├── index.html
├── package.json
├── vite.config.ts              # Vite + API 代理 + 高德安全密钥注入
├── src/
│   ├── main.tsx
│   ├── app/
│   │   ├── App.tsx             # 主应用视图与状态机
│   │   ├── components/
│   │   │   ├── PlanSetupView.tsx
│   │   │   ├── ClarifyView.tsx
│   │   │   ├── RouteMap.tsx
│   │   │   └── ui/             # shadcn/radix 基础组件
│   │   └── lib/
│   │       ├── api.ts          # 后端 API / SSE
│   │       └── adapter.ts      # PlanState -> UI 数据
│   ├── imports/                # 小团、背景、地点、通关页图片资源
│   └── styles/                 # Tailwind、主题变量、字体
```

## 现场 Demo 建议

1. 切到手机端视口。
2. 点击「开始副本」。
3. 选择「带娃玩」和「北京·朝阳」。
4. 等待小团显示 Agent 进度。
5. 查看「今日主线任务」和地点卡。
6. 点击「一键下单」，进入 Agent 托管。
7. 进入副本进行中，打开核销码。
8. 核销最后一站，展示副本通关票据。

## 技术栈

- React 18 + TypeScript
- Vite 6
- Tailwind CSS 4
- motion
- lucide-react
- sonner
- @amap/amap-jsapi-loader
