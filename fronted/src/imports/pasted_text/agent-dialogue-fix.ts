# 任务：修复 Agent 对话流程状态逻辑，第二个气泡必须在用户发送后才出现

请基于当前移动端页面进行交互逻辑修改。  
不要重新设计 UI，不要改变颜色、背景、卡片样式、按钮样式、IP 头像和页面布局。  
这次重点是修复 Agent 对话状态逻辑，让它符合真实 Agent 交互流程。

---

## 一、当前问题

现在页面一打开就同时显示了两个 Agent 气泡：

1. 「副本启动！快速问你3个问题锁定方案」三问选择气泡
2. 「收到！正在生成专属副本路线...」loading 气泡和进度条

这是错误的。

第二个 loading 气泡不应该初始显示。

---

## 二、正确流程

页面进入时，只显示第一个 Agent 气泡：

```text
🎮 副本启动！
快问你3个问题锁定方案：
① 今天主要目的是什么？
② 几个人出发？
③ 想要什么氛围？

然后用户有两种触发方式：

方式 A：选择三个问题

用户依次选择：
	•	今天主要目的
	•	几个人出发
	•	想要什么氛围

选择完成后，点击底部右侧发送按钮。

方式 B：直接输入文字

用户在底部输入框输入自然语言，例如：

今天下午想带孩子出去玩，不想太累

然后点击右侧发送按钮。

只要满足 A 或 B 任意一种方式，就进入生成流程。

⸻

三、初始状态要求

页面初始状态：

应该显示：
	•	Header
	•	第一个 Agent 三问气泡
	•	底部输入框
	•	发送按钮

不应该显示：
	•	「收到！正在生成专属副本路线…」
	•	loading 卡片
	•	进度条
	•	80% / 100%
	•	任何结果页内容

请确保第二个气泡的初始状态是 hidden / not rendered。

不要用 opacity: 0 占位。
请直接不要渲染它。

⸻

四、发送按钮点击逻辑

点击底部右侧发送按钮时，执行以下逻辑：

if (userText.trim().length > 0) {
  startGeneration();
} else if (purpose && people && mood) {
  startGeneration();
} else {
  showToast("先选完3个问题，或者直接说出你的需求哦");
}

也就是说：
	•	如果用户输入了文字，可以直接生成
	•	如果用户没有输入文字，就必须选完 3 个问题
	•	如果既没输入文字，也没选完 3 个问题，就显示轻提示

轻提示不要用弹窗，可以是 toast，1.5 秒后消失。

⸻

五、选项交互

三组问题每组只能选一个。

状态字段建议：

const [purpose, setPurpose] = useState<string | null>(null);
const [people, setPeople] = useState<string | null>(null);
const [mood, setMood] = useState<string | null>(null);
const [userText, setUserText] = useState("");

选中状态：
	•	紫蓝渐变填充
	•	白色文字

未选中状态：
	•	白色背景
	•	紫色描边
	•	深藏青文字

不要改变现有视觉，只保持当前 selected / unselected 样式即可。

⸻

六、生成流程 startGeneration()

当用户点击发送并满足条件后，调用：

startGeneration()

这个函数要做这些事：
	1.	设置状态：

setIsGenerating(true);
setShowGeneratingBubble(true);
setStreamingText("");
setProgress(0);

	2.	清空输入框：

setUserText("");

	3.	开始模拟 Agent 流式输出。

⸻

七、第二个 Agent 气泡：流式打字机输出

第二个气泡内容不要一次性出现。

它应该像 Agent 正在流式回复一样，一个字一个字出现。

目标文案：

收到！正在生成专属副本路线...

请做一个模拟 streaming/typewriter 效果：

const fullText = "收到！正在生成专属副本路线...";

效果：

收
收到
收到！
收到！正
收到！正在
收到！正在生成
...
收到！正在生成专属副本路线...

建议速度：
	•	每 40ms - 70ms 出现一个字符
	•	中文也按字符追加即可
	•	打字完成后，再显示进度条

注意：
	•	第二个气泡一出现时，可以先显示空白或一个很短的 loading cursor
	•	文字逐字出现
	•	不要一开始就直接显示完整句子

⸻

八、进度条显示逻辑

进度条不要在第二个气泡刚出现时立刻完整显示。

推荐逻辑：
	1.	用户点击发送
	2.	第二个气泡出现
	3.	文案开始流式打字：
「收到！正在生成专属副本路线…」
	4.	打字完成后，显示进度条
	5.	进度条从 0% 增长到 100%
	6.	到 100% 后进入结果页

如果为了演示节奏，也可以在文字打字到一半时开始进度条，但不要一开始就是 80% 或 100%。

⸻

九、进度条动画

进度条必须从 0 到 100。

建议状态：

const [progress, setProgress] = useState(0);

mock 版本可以这样：

const timer = setInterval(() => {
  setProgress(prev => {
    if (prev >= 100) {
      clearInterval(timer);
      finishGeneration();
      return 100;
    }
    return prev + 5;
  });
}, 120);

要求：
	•	起始 0%
	•	逐步增长
	•	最终 100%
	•	右侧百分比同步更新
	•	分段式进度条同步填充
	•	不要初始就显示 80%
	•	不要一开始就显示 100%

⸻

十、生成完成后的跳转

当进度条到 100% 后，调用：

finishGeneration()

mock 版本可以跳转到结果页，或者显示结果卡片。

结果页可以先使用 mock data。

但是请把代码结构设计成以后可以接真实 Agent。

⸻

十一、非常重要：代码要方便以后接真实 Agent

现在可以用 mock progress 和 mock result。

但是不要把逻辑写死成只能 mock。

请把生成流程拆成清晰函数，方便以后替换成真实 API / Agent 调用。

建议结构：

async function startGeneration() {
  const payload = buildPayload();

  setIsGenerating(true);
  setShowGeneratingBubble(true);
  setStreamingText("");
  setProgress(0);

  await runTypewriter("收到！正在生成专属副本路线...");

  // 当前阶段先用 mock
  const result = await mockGeneratePlan(payload);

  // 以后这里替换成真实 Agent API
  // const result = await generatePlanFromAgent(payload, onProgress, onStream);

  setPlanResult(result);
  finishGeneration(result);
}

请保留一个清晰的接口函数：

async function generatePlan(payload) {
  // TODO: replace mock with real Agent API
}

不要把 mock 数据散落在 UI 组件各处。

⸻

十二、前端传给后端 / Agent 的 payload

请准备一个清晰的 payload：

const payload = {
  purpose,
  people,
  mood,
  userText,
  source: userText.trim() ? "text" : "chips"
};

如果用户输入文字，则：

{
  "purpose": null,
  "people": null,
  "mood": null,
  "userText": "今天下午想带孩子出去玩，不想太累",
  "source": "text"
}

如果用户选择按钮，则：

{
  "purpose": "带娃玩",
  "people": "2人",
  "mood": "慢慢逛逛",
  "userText": "",
  "source": "chips"
}

以后接后端时，我会把这个 payload 发给 Agent。

⸻

十三、未来真实 Agent 接入预留

请在代码里预留这样的接口逻辑：

async function generatePlanFromAgent(payload, callbacks) {
  // callbacks.onStream(textChunk)
  // callbacks.onProgress(progress)
  // return finalPlan
}

未来真实 Agent 的工作方式可能是：
	1.	前端发送 payload 给后端
	2.	后端开始 Agent graph
	3.	后端通过 stream 返回文本 chunk
	4.	前端逐步显示 Agent 回复
	5.	后端完成 planner 后返回 final plan
	6.	前端跳结果页

所以当前 mock 版本的 typewriter 和 progress 要和未来 streaming 接口兼容。

不要把 UI 写成只能显示固定字符串。

⸻

十四、状态命名建议

请使用清晰状态：

const [showGeneratingBubble, setShowGeneratingBubble] = useState(false);
const [isStreaming, setIsStreaming] = useState(false);
const [streamingText, setStreamingText] = useState("");
const [showProgress, setShowProgress] = useState(false);
const [progress, setProgress] = useState(0);
const [isGenerating, setIsGenerating] = useState(false);
const [planResult, setPlanResult] = useState(null);

初始值：

showGeneratingBubble = false
isStreaming = false
streamingText = ""
showProgress = false
progress = 0
isGenerating = false
planResult = null


⸻

十五、防止重复点击

在生成过程中，请禁用发送按钮和选项按钮，防止用户重复触发。

disabled={isGenerating}

视觉上可以轻微降低透明度，但不要大改 UI。

生成结束后，如果进入结果页，就不需要恢复。

⸻

十六、底部输入框逻辑

底部输入框需要可以输入文字。

要求：
	•	placeholder 保持：「或者直接说也行…」
	•	用户输入内容后点击发送，可以直接触发生成
	•	输入文字时不强制要求选择三个按钮
	•	点击发送后可以清空输入框
	•	生成过程中输入框 disabled

⸻

十七、不要改动的视觉内容

请不要修改：
	•	背景图
	•	header
	•	地球 icon
	•	标题「地球Online」
	•	副标题「周末副本 · 组队中…」
	•	顶部右上角小兔 IP
	•	第一张三问气泡的视觉样式
	•	卡片颜色
	•	按钮样式
	•	进度条样式
	•	底部输入栏样式
	•	发送按钮样式
	•	字体
	•	字号
	•	圆角
	•	阴影

这次只改交互状态和渲染时机。

⸻

十八、最终验收标准

完成后应该是：

初始进入页面

只显示：
	•	顶部 header
	•	「副本启动！」三问气泡
	•	底部输入框和发送按钮

不显示：
	•	「收到！正在生成专属副本路线…」
	•	进度条
	•	百分比

用户选择完三个选项后点击发送

页面新增第二个 Agent 气泡：
	•	文案以打字机/流式输出方式出现
	•	文案为：「收到！正在生成专属副本路线…」
	•	然后进度条从 0% 到 100%

用户直接输入文字后点击发送

也能触发同样流程。

生成过程中
	•	禁止重复点击发送
	•	进度条逐步增长
	•	百分比同步变化

生成结束
	•	进入结果页或显示 mock 结果卡片
	•	代码结构方便后续替换为真实 Agent API

一句话总结：

第二个 loading 气泡必须在用户点击发送后才出现，并且文字要模拟流式输出，进度条从 0 到 100。当前可以 mock，但代码必须为后续接真实 Agent 预留清晰接口。
