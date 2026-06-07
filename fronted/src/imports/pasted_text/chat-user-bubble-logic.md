# 任务：新增用户发送气泡逻辑：输入文字后先显示用户气泡，再触发 Agent 生成

请基于当前「地球Online · 周末副本」对话界面进行交互逻辑增强。  
不要重做 UI，不要改变整体视觉风格、背景、卡片、按钮、头像和布局。

这次只新增一个功能：

**当用户在底部文本框输入内容并点击右下角发送按钮后，页面要先显示一条用户自己的对话气泡，然后 Agent 再流式回复“收到！正在生成专属副本路线...”，再显示进度条。**

---

## 一、当前流程

目前页面已经有：

1. Agent 三问气泡：
   「副本启动！快问你3个问题锁定方案」
2. 用户可以选择三个选项
3. 用户也可以在底部输入框输入文字
4. 点击右下角发送按钮后，会出现：
   「收到！正在生成专属副本路线...」
5. 然后进度条从 0% 到 100%

现在需要在用户输入文字时，增加一条用户气泡。

---

## 二、新增用户气泡逻辑

当用户在输入框输入文字，例如：

```text
000

然后点击右下角发送按钮后，页面应该先显示用户气泡：

000

然后才显示 Agent 的生成气泡：

收到！正在生成专属副本路线...

正确顺序：

用户输入文字
↓
点击发送按钮
↓
右侧出现用户气泡，显示用户输入内容
↓
Agent 气泡出现
↓
Agent 文案流式打字输出
↓
进度条从 0% 到 100%
↓
进入结果页 / mock 结果


⸻

三、用户气泡显示位置

用户气泡应该像正常聊天界面一样，显示在右侧。

要求：
    1. 用户气泡靠右对齐。
    2. 位置在 Agent 三问气泡下方。
    3. 在 Agent 生成气泡上方。
    4. 不要挡住底部输入框。
    5. 不要破坏当前卡片布局。
    6. 不要影响背景。
    7. 气泡宽度根据文字自适应，但要有最大宽度。

建议样式：

.user-message-row {
  width: 100%;
  display: flex;
  justify-content: flex-end;
  margin: 14px 0;
}

.user-message-bubble {
  max-width: 72%;
  padding: 12px 14px;
  border-radius: 18px 18px 6px 18px;
  background: linear-gradient(135deg, #7B6EF6 0%, #5B8AF0 100%);
  color: #FFFFFF;
  font-size: 14px;
  line-height: 1.5;
  box-shadow: 0 4px 14px rgba(123, 110, 246, 0.18);
  word-break: break-word;
}

如果文字很短，例如 000，气泡不要拉满，保持小气泡即可。

⸻

四、用户气泡内容

用户气泡只显示用户在输入框中输入的文本。

例如：

输入：

今天下午想带孩子出去玩，不想太累

发送后显示：

今天下午想带孩子出去玩，不想太累

如果输入框为空，只选择了三个选项，则可以不显示用户文本气泡。

⸻

五、选择按钮触发时的处理

如果用户没有输入文字，只是选择了三个选项，然后点击发送：

可以选择以下两种方式之一：

方案 A：不显示用户气泡

直接进入 Agent 生成气泡：

收到！正在生成专属副本路线...

方案 B：显示一个自动总结的用户气泡

例如：

带娃玩 · 2人 · 慢慢逛逛

我更建议使用方案 B，因为这样聊天逻辑更完整。

如果选择方案 B，请在用户点击发送后显示右侧用户气泡：

带娃玩 · 2人 · 慢慢逛逛

然后再显示 Agent 生成气泡。

⸻

六、发送按钮逻辑调整

请把发送逻辑改成：

function handleSend() {
  const trimmedText = userText.trim();

  if (isGenerating) return;

  if (trimmedText.length > 0) {
    const userMessage = trimmedText;
    setUserBubbleText(userMessage);
    setUserText("");
    startGeneration({
      user_text: userMessage,
      purpose,
      people,
      mood,
      source: "text"
    });
    return;
  }

  if (purpose && people && mood) {
    const userMessage = `${purpose} · ${people} · ${mood}`;
    setUserBubbleText(userMessage);
    startGeneration({
      user_text: "",
      purpose,
      people,
      mood,
      source: "chips"
    });
    return;
  }

  showToast("先选完3个问题，或者直接说出你的需求哦");
}

如果当前代码状态名不同，请根据现有代码调整。

⸻

七、新增状态建议

请新增一个状态来保存用户气泡内容：

const [userBubbleText, setUserBubbleText] = useState("");

初始状态：

userBubbleText = ""

当 userBubbleText 有内容时，渲染用户气泡。

{userBubbleText && (
  <div className="user-message-row">
    <div className="user-message-bubble">
      {userBubbleText}
    </div>
  </div>
)}


⸻

八、Agent 生成气泡出现顺序

请确保顺序是：
    1. 用户气泡先出现
    2. 等待 200ms - 400ms
    3. Agent 生成气泡出现
    4. Agent 文案开始流式输出
    5. 进度条出现并加载

建议：

setUserBubbleText(userMessage);

setTimeout(() => {
  setShowGeneratingBubble(true);
  runTypewriter("收到！正在生成专属副本路线...");
}, 300);

不要让用户气泡和 Agent 气泡同时瞬间出现。
要有一点点聊天节奏。

⸻

九、Agent 气泡仍然需要流式输出

保留当前逻辑：

收到！正在生成专属副本路线...

需要以打字机 / streaming 方式逐字出现。

不要一次性显示完整文案。

⸻

十、进度条逻辑保持

保留当前进度条逻辑：
	•	Agent 文案流式输出完成后
	•	进度条从 0% 到 100%
	•	百分比同步变化
	•	生成完成后进入结果页 / mock 结果

不要一开始就显示 80% 或 100%。

⸻

十一、reset / 返回逻辑也要清空用户气泡

之前左上角返回按钮已经有 reset 功能。
现在请把用户气泡也加入 reset。

点击左上角返回按钮后，需要清空：

setUserBubbleText("");

也就是说 reset 后页面应该回到：
	•	三个选项都未选择
	•	输入框为空
	•	没有用户气泡
	•	没有 Agent 生成气泡
	•	没有进度条

⸻

十二、不要改动的内容

请不要修改：
	•	背景图
	•	header
	•	地球 icon
	•	标题「地球Online」
	•	副标题「周末副本 · 组队中…」
	•	右上角小团头像
	•	Agent 三问气泡样式
	•	三组问题选项样式
	•	底部输入框样式
	•	发送按钮样式
	•	loading 气泡样式
	•	进度条样式
	•	intro 启动页
	•	reset 返回 intro 的逻辑
	•	响应式布局

这次只新增用户气泡和发送顺序逻辑。

⸻

十三、验收标准

完成后：
    1. 初始进入 chat 页时，不显示用户气泡。
    2. 用户在输入框输入 000。
    3. 点击右下角发送按钮。
    4. 页面右侧出现用户气泡：000。
    5. 约 300ms 后，Agent 生成气泡出现。
    6. Agent 文案「收到！正在生成专属副本路线…」逐字流式输出。
    7. 文案完成后，进度条从 0% 到 100%。
    8. 如果用户不输入文字，只选择三个选项，也显示用户气泡：
带娃玩 · 2人 · 慢慢逛逛
    9. 点击左上角返回后，用户气泡也被清空。
    10. 其他 UI 完全不变。

一句话总结：

用户点击发送后，先显示右侧用户气泡，再显示 Agent 流式生成气泡和进度条。输入文本显示输入内容；只选按钮则显示“目的 · 人数 · 氛围”的总结气泡。

你可以再补一句口语版：

```text
重点：我输入什么，发送后就要先出现一条我自己的右侧聊天气泡。然后 Agent 才回复“收到！正在生成专属副本路线...”，再加载进度条。不要一点击发送就直接跳 Agent loading。对，可以加这一段到刚才那个 prompt 里，放在 “三、用户气泡显示位置” 后面最合适。

## 三补充：用户气泡颜色要求

用户自己的右侧气泡不要用特别深的紫色，也不要和背景融在一起。

我要的是：

**淡紫色用户气泡，但要明显区别于页面背景的淡紫色。**

页面背景本身已经有很浅的紫色像素底图，所以用户气泡需要比背景更清楚、更像一个可读的聊天气泡。

推荐样式：

```css
.user-message-bubble {
  max-width: 72%;
  padding: 12px 14px;
  border-radius: 18px 18px 6px 18px;

  background: linear-gradient(135deg, #E9E5FF 0%, #DCD8FF 100%);
  color: #1A1A2E;

  border: 1px solid rgba(123, 110, 246, 0.22);
  box-shadow: 0 4px 14px rgba(123, 110, 246, 0.14);

  font-size: 14px;
  line-height: 1.5;
  word-break: break-word;
}

颜色要求：
	•	用户气泡是淡紫色，不是深紫色。
	•	文字使用 #1A1A2E，不要用纯黑。
	•	气泡要比背景更明显，不能和背景混在一起。
	•	可以用轻微紫色描边和阴影增强层级。
	•	不要使用大面积高饱和紫色。
	•	不要使用橙色。
	•	不要使用和按钮一样的深紫蓝渐变，因为那会太像主按钮。

如果浅紫气泡和背景太接近，可以稍微加深一点：

background: linear-gradient(135deg, #E4DEFF 0%, #D6D0FF 100%);
border: 1px solid rgba(123, 110, 246, 0.28);

但整体仍然要保持柔和。

你也可以直接补一句口语版：

```text
用户右侧气泡要是淡紫色，但不能和背景糊在一起。它要比背景更清楚，有轻微紫色描边和阴影，文字用深藏青色，不要用深紫按钮色，也不要用橙色。