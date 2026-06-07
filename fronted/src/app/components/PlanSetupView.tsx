import { useState, useEffect, useRef } from "react";
import { ChevronLeft, Globe, Send } from "lucide-react";
import { toast } from "sonner";
import { startPlan, clarifyPlan, isSseEvent, type SseEnvelope } from "../lib/api";
import AGENT_AVATAR from "../../imports/agent-avatar.png";

type SetupMode = "chips" | "text";

interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
}

interface PlanSetupViewProps {
  onPlanReady: (planState: unknown, sessionId: string) => void;
  onBack: () => void;
}

// 只问两个关键问题（目的 + 城市），人数/氛围走智能默认，降低逐条输入的摩擦。
// 如需更精细的个性化，把 people / vibe 两题加回这里即可。
const QUESTIONS = [
  {
    id: "purpose",
    title: "① 今天主要想干嘛？",
    options: ["带娃玩", "朋友聚会", "约会", "独自放空", "陪父母", "带宠物", "自习办公"],
  },
  {
    id: "location",
    title: "② 你在哪个城市？",
    options: ["北京·朝阳", "上海·浦东", "深圳·南山", "广州·天河", "杭州·西湖", "其他城市"],
  },
];

// 不再逐条追问的字段，按目的给出合理默认（写进 goal，后端仍可识别）
const DEFAULT_PEOPLE = "2人";
const VIBE_BY_PURPOSE: Record<string, string> = {
  带娃玩: "活力闯关",
  朋友聚会: "吃好喝好",
  约会: "拍照打卡",
  独自放空: "慢慢逛逛",
  陪父母: "慢慢逛逛",
  带宠物: "慢慢逛逛",
  自习办公: "慢慢逛逛",
};

// 城市预设：一次点击同时给出 city + district，后端无需再追问位置
const LOCATION_PRESETS: Record<string, { city: string; district: string }> = {
  "北京·朝阳": { city: "北京", district: "朝阳区" },
  "上海·浦东": { city: "上海", district: "浦东新区" },
  "深圳·南山": { city: "深圳", district: "南山区" },
  "广州·天河": { city: "广州", district: "天河区" },
  "杭州·西湖": { city: "杭州", district: "西湖区" },
};

// 默认时间：写进 goal 让后端 agent1 不再触发时间澄清
const DEFAULT_TIME_HINT = "下午2点出发玩4小时";

// 生成过程的阶段文案与对应真实进度（跟随后端 agent_step.stage）
const STAGE_LABELS: Record<string, string> = {
  start: "正在连接规划引擎...",
  intent: "正在理解你的需求...",
  location: "正在搜索附近适合的场所...",
  planner: "正在规划最优路线...",
  executor: "正在生成可执行方案...",
};
const STAGE_PROGRESS: Record<string, number> = {
  start: 10,
  intent: 30,
  location: 55,
  planner: 80,
  executor: 92,
};
// 每个阶段内允许进度条“慢爬”到的上限（不超过下一阶段起点），避免等待时僵死不动
const STAGE_CEIL: Record<string, number> = {
  start: 28,
  intent: 53,
  location: 78,
  planner: 90,
  executor: 99,
};

function appendMessage(
  setMessages: React.Dispatch<React.SetStateAction<Message[]>>,
  idRef: React.MutableRefObject<number>,
  role: Message["role"],
  content: string,
) {
  const id = String(++idRef.current);
  setMessages((prev) => [...prev, { id, role, content }]);
}

export function PlanSetupView({ onPlanReady, onBack }: PlanSetupViewProps) {
  const [mode, setMode] = useState<SetupMode>("chips");
  const [messages, setMessages] = useState<Message[]>([]);
  const [chipStep, setChipStep] = useState(0);
  const [selections, setSelections] = useState<Record<string, string>>({});
  const [userInput, setUserInput] = useState("");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [clarifyTopic, setClarifyTopic] = useState<"location" | "time" | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [showProgress, setShowProgress] = useState(false);
  const [progress, setProgress] = useState(0);
  const [slowHint, setSlowHint] = useState(false);
  const [awaitingLocation, setAwaitingLocation] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const msgIdRef = useRef(0);
  // 生成过程只用一条“状态气泡”，原地更新文案+进度，避免刷屏
  const statusIdRef = useRef<string | null>(null);
  // 当前阶段进度条的慢爬上限，跟随后端阶段更新
  const creepCeilRef = useRef(0);

  // 创建或原地更新状态气泡
  const setStatus = (text: string) => {
    setMessages((prev) => {
      if (statusIdRef.current) {
        return prev.map((m) =>
          m.id === statusIdRef.current ? { ...m, content: text } : m,
        );
      }
      const id = String(++msgIdRef.current);
      statusIdRef.current = id;
      return [...prev, { id, role: "assistant", content: text }];
    });
  };

  // 移除状态气泡（澄清/出错时不再保留半截进度）
  const clearStatus = () => {
    const id = statusIdRef.current;
    statusIdRef.current = null;
    setShowProgress(false);
    setSlowHint(false);
    if (id) {
      setMessages((prev) => prev.filter((m) => m.id !== id));
    }
  };

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length]);

  // 进度条慢爬：阶段内若后端暂未推进，进度也缓慢逼近本阶段上限，避免“僵死/假”的观感。
  // 真实阶段事件用 Math.max 直接跳到对应刻度；爬到上限仍未推进则提示“正在兜底”。
  useEffect(() => {
    if (!showProgress || !isLoading) return;
    const timer = setInterval(() => {
      setProgress((p) => {
        const ceil = creepCeilRef.current || 95;
        if (p < ceil) {
          setSlowHint(false);
          return Math.min(ceil, p + 1);
        }
        setSlowHint(true); // 已爬到本阶段上限仍未收到后端推进
        return p;
      });
    }, 650);
    return () => clearInterval(timer);
  }, [showProgress, isLoading]);

  // Initial greeting
  useEffect(() => {
    if (messages.length === 0) {
      const init = () => {
        appendMessage(setMessages, msgIdRef, "assistant", "我是你的专属向导，小团。🎮 副本启动！");
        appendMessage(setMessages, msgIdRef, "assistant", QUESTIONS[0].title);
      };
      const t = setTimeout(init, 300);
      return () => clearTimeout(t);
    }
  }, []);

  const switchMode = (newMode: SetupMode) => {
    if (newMode === mode) return;
    setMode(newMode);
    setMessages([]);
    setChipStep(0);
    setSelections({});
    setUserInput("");
    setSessionId(null);
    setClarifyTopic(null);
    setIsLoading(false);
    setShowProgress(false);
    setProgress(0);
    setAwaitingLocation(false);
    statusIdRef.current = null;
    msgIdRef.current = 0;
    setTimeout(() => {
      appendMessage(setMessages, msgIdRef, "assistant", "我是你的专属向导，小团。🎮 副本启动！");
      if (newMode === "chips") {
        appendMessage(setMessages, msgIdRef, "assistant", QUESTIONS[0].title);
      }
    }, 200);
  };

  // SSE handler —— 生成过程合并为一条状态气泡，进度跟随后端真实阶段
  const handleSseEvent = (evt: SseEnvelope) => {
    if (isSseEvent(evt, "agent_step")) {
      const stage = String(evt.data.stage ?? "");
      const label = STAGE_LABELS[stage];
      if (label) {
        setStatus(label);
        setShowProgress(true);
        setSlowHint(false);
        creepCeilRef.current = STAGE_CEIL[stage] ?? creepCeilRef.current;
        const pct = STAGE_PROGRESS[stage];
        if (pct != null) setProgress((p) => Math.max(p, pct));
      }
    }
    if (isSseEvent(evt, "progress")) {
      const pct = Math.max(0, Math.min(100, Number(evt.data.percent || 0)));
      setProgress((p) => Math.max(p, pct));
      setShowProgress(true);
    }
    if (isSseEvent(evt, "needs_clarification")) {
      const { session_id, topic, question } = evt.data;
      // 还需要补充信息：移除状态气泡，把问题作为正常消息显示
      clearStatus();
      setSessionId(String(session_id || sessionId || ""));
      setClarifyTopic((topic as "location" | "time") || "location");
      appendMessage(setMessages, msgIdRef, "assistant", String(question || "请补充信息"));
      setIsLoading(false);
    }
    if (isSseEvent(evt, "plan_ready")) {
      const { session_id, plan_state } = evt.data;
      setProgress(100);
      setIsLoading(false);
      setShowProgress(false);
      statusIdRef.current = null;
      onPlanReady(plan_state, String(session_id || sessionId || ""));
    }
    if (isSseEvent(evt, "error")) {
      toast(String(evt.data.message || "请求失败"), { duration: 1800 });
      clearStatus();
      setIsLoading(false);
    }
    if (isSseEvent(evt, "done")) {
      setIsLoading(false);
      setShowProgress(false);
    }
  };

  const startGeneration = (
    goal: string,
    loc?: { city?: string; district?: string },
  ) => {
    setIsLoading(true);
    setShowProgress(true);
    setSlowHint(false);
    setProgress(STAGE_PROGRESS.start);
    creepCeilRef.current = STAGE_CEIL.start;
    statusIdRef.current = null;
    setStatus(STAGE_LABELS.start);
    startPlan({ goal, city: loc?.city, district: loc?.district }, handleSseEvent).catch(
      (err) => {
        toast(err.message || "生成失败", { duration: 1800 });
        clearStatus();
        setIsLoading(false);
      },
    );
  };

  // 组装发给后端的 goal：目的 + 智能默认(人数/氛围) + 默认时间（后端不再追问）
  const buildGoal = (sel: Record<string, string>) => {
    const people = sel.people || DEFAULT_PEOPLE;
    const vibe = sel.vibe || VIBE_BY_PURPOSE[sel.purpose] || "慢慢逛逛";
    const parts = [sel.purpose, people, vibe].filter(Boolean);
    const base = parts.join(" · ") || "今天帮我规划一个周末副本";
    return `${base}，${DEFAULT_TIME_HINT}`;
  };

  // Chip click
  const handleChip = (option: string) => {
    if (isLoading) return;
    const step = chipStep;
    const q = QUESTIONS[step];

    appendMessage(setMessages, msgIdRef, "user", option);
    const updated = { ...selections, [q.id]: option };
    setSelections(updated);

    // 前面几个问题：继续问下一个
    if (step < QUESTIONS.length - 1) {
      const next = step + 1;
      setTimeout(() => {
        appendMessage(setMessages, msgIdRef, "assistant", QUESTIONS[next].title);
        setChipStep(next);
      }, 150);
      return;
    }

    // 最后一个问题（城市）
    setChipStep(QUESTIONS.length);
    const preset = LOCATION_PRESETS[option];
    if (preset) {
      startGeneration(buildGoal(updated), preset);
    } else {
      // “其他城市”：让用户在输入框补一句具体城市/区
      setAwaitingLocation(true);
      setTimeout(() => {
        appendMessage(
          setMessages,
          msgIdRef,
          "assistant",
          "好的，告诉我你在哪个城市哪个区？比如「成都武侯区」",
        );
      }, 250);
    }
  };

  // Text submit
  const handleSubmit = () => {
    const text = userInput.trim();
    if (!text) {
      toast("请先输入你的需求", { duration: 1200 });
      return;
    }
    if (isLoading) return;

    appendMessage(setMessages, msgIdRef, "user", text);
    setUserInput("");

    // “其他城市”补充：拼进 goal 交给后端解析城市/区
    if (awaitingLocation) {
      setAwaitingLocation(false);
      startGeneration(`${buildGoal(selections)}，我在${text}`);
      return;
    }

    if (clarifyTopic && sessionId) {
      const topic = clarifyTopic;
      setIsLoading(true);
      setClarifyTopic(null);
      clarifyPlan({ session_id: sessionId, topic, answer: text }, handleSseEvent).catch(
        (err) => {
          toast(err.message || "请求失败", { duration: 1800 });
          setIsLoading(false);
        },
      );
    } else {
      startGeneration(text);
    }
  };

  const showInputBar =
    mode === "text" || chipStep >= QUESTIONS.length || awaitingLocation;

  return (
    <div className="flex flex-col h-full bg-[#F7F8FC]">
      {/* Header */}
      <header
        className="px-5 pb-2 flex items-center shrink-0 bg-[#F7F8FC] z-10"
        style={{ paddingTop: "max(44px, env(safe-area-inset-top))" }}
      >
        <button
          onClick={onBack}
          className="w-8 h-8 flex items-center justify-center text-[#1A1A2E] mr-2"
        >
          <ChevronLeft className="w-6 h-6 stroke-[2.5]" />
        </button>
        <Globe className="w-5 h-5 text-[#6B63F6] stroke-[2.5] shrink-0" />
        <h1
          className="ml-1.5 font-bold text-[18px] tracking-wide"
          style={{ color: "#6B63F6" }}
        >
          地球Online
        </h1>
      </header>

      {/* Mode Tabs */}
      <div className="px-6 pb-3 shrink-0">
        <div
          className="flex bg-white rounded-[14px] p-1 border border-[#E8E4FF]"
          style={{ width: "100%", maxWidth: "320px" }}
        >
          {(["chips", "text"] as const).map((m) => (
            <button
              key={m}
              onClick={() => switchMode(m)}
              className={`flex-1 py-2 rounded-[11px] text-sm font-bold transition-all ${
                mode === m
                  ? "bg-gradient-to-r from-[#7B6EF6] to-[#5B8AF0] text-white shadow-[0_2px_8px_rgba(107,99,246,0.25)]"
                  : "text-[#6B6F86] hover:text-[#5E5B8C]"
              }`}
            >
              {m === "chips" ? "快捷选择" : "自由输入"}
            </button>
          ))}
        </div>
      </div>

      {/* Message List */}
      <div
        className="flex-1 overflow-y-auto px-6"
        style={{ scrollbarWidth: "none", msOverflowStyle: "none" }}
      >
        <style>{`::-webkit-scrollbar { display: none; }`}</style>
        <div className="mt-2 space-y-4 pb-4">
          {messages.map((msg, idx) => {
            const isLast = idx === messages.length - 1;
            return (
              <div
                key={msg.id}
                className={`flex ${
                  msg.role === "user" ? "justify-end" : "items-start gap-3"
                }`}
              >
                {msg.role === "assistant" && (
                  <div className="shrink-0 mt-1">
                    <img
                      src={AGENT_AVATAR}
                      alt="小团"
                      className="w-[50px] h-[50px] object-contain"
                    />
                  </div>
                )}
                <div
                  className={`max-w-[72%] px-3 py-2.5 text-sm leading-relaxed break-words ${
                    msg.role === "user"
                      ? "bg-gradient-to-r from-[#E4DEFF] to-[#D6D0FF] text-[#1A1A2E] rounded-[18px] rounded-br-[6px] border border-[rgba(123,110,246,0.28)] shadow-[0_4px_14px_rgba(123,110,246,0.14)]"
                      : "bg-white rounded-[20px] rounded-tl-[6px] border border-[#E2E4FA] shadow-[0_4px_15px_rgba(0,0,0,0.03)]"
                  }`}
                >
                  {msg.content || <>&nbsp;</>}

                  {/* Chips after latest assistant question in chips mode */}
                  {msg.role === "assistant" && mode === "chips" && isLast && chipStep < QUESTIONS.length && !awaitingLocation && (
                    <div className="mt-3">
                      <div className="flex flex-wrap gap-1.5">
                        {QUESTIONS[chipStep].options.map((opt) => (
                          <button
                            key={opt}
                            onClick={() => handleChip(opt)}
                            disabled={isLoading}
                            className={`px-3 py-[7px] rounded-[10px] text-[11px] font-bold transition-all whitespace-nowrap ${
                              isLoading
                                ? "opacity-50 cursor-not-allowed bg-white border border-[#D8D3FF] text-[#1A1A2E]"
                                : "bg-white border border-[#D8D3FF] text-[#1A1A2E] hover:border-[#6B63F6] hover:bg-[#F8F8FF] active:scale-95"
                            }`}
                          >
                            {opt}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Progress bar on last assistant message */}
                  {msg.role === "assistant" && showProgress && isLast && (
                    <div className="mt-2 flex items-center gap-2">
                      <div className="flex gap-[3px]">
                        {[...Array(12)].map((_, pi) => (
                          <div
                            key={pi}
                            className={`w-[10px] h-[10px] rounded-[1px] transition-all duration-500 ${
                              pi < Math.floor((progress / 100) * 12)
                                ? "bg-[#6B63F6] shadow-[0_0_4px_rgba(107,99,246,0.4)]"
                                : "border-[1.5px] border-[#D8D3FF] bg-transparent"
                            }`}
                          />
                        ))}
                      </div>
                      <span className="text-[#6B63F6] text-[13px] font-black font-mono">
                        {progress}%
                      </span>
                      {slowHint && (
                        <span className="text-[#9FA3B8] text-[11px] font-medium">
                          · 响应较慢，正在为你兜底…
                        </span>
                      )}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
        <div ref={messagesEndRef} />
      </div>

      {/* Input Bar */}
      {showInputBar && (
        <div
          className="px-5 pt-3 bg-gradient-to-t from-[#F7F8FC] via-[#F7F8FC_80%] to-transparent shrink-0"
          style={{ paddingBottom: "max(34px, env(safe-area-inset-bottom))" }}
        >
          <div className="flex items-center gap-3">
            <div className="flex-1 bg-white rounded-[16px] h-[52px] flex items-center px-4 border border-[#D8D3FF] shadow-sm focus-within:border-[#6B63F6] transition-colors">
              <input
                type="text"
                placeholder={
                  isLoading
                    ? "处理中..."
                    : clarifyTopic
                      ? "请在此回答..."
                      : "自由描述你的周末计划..."
                }
                value={userInput}
                onChange={(e) => setUserInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !isLoading) handleSubmit();
                }}
                disabled={isLoading}
                className="w-full bg-transparent outline-none text-[14px] text-[#1A1A2E] placeholder-[#9FA3B8] font-medium disabled:opacity-50"
              />
            </div>
            <button
              onClick={handleSubmit}
              disabled={isLoading}
              className={`w-[52px] h-[52px] rounded-[16px] flex items-center justify-center transition-all duration-300 shrink-0 ${
                isLoading
                  ? "bg-[#E2E4FA] text-white cursor-not-allowed opacity-60"
                  : "bg-gradient-to-r from-[#7B6EF6] to-[#5B8AF0] text-white shadow-[0_4px_12px_rgba(107,99,246,0.4)] hover:scale-105 active:scale-95 cursor-pointer"
              }`}
            >
              {isLoading ? (
                <span className="inline-flex items-center gap-[3px]">
                  {[0, 0.15, 0.3].map((d, i) => (
                    <span
                      key={i}
                      className="w-[5px] h-[5px] rounded-full bg-white animate-bounce"
                      style={{ animationDelay: `${d}s` }}
                    />
                  ))}
                </span>
              ) : (
                <Send className="w-5 h-5 stroke-[2.5]" />
              )}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
