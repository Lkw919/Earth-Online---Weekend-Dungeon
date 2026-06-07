export type StartPlanPayload = {
  goal: string;
  city?: string;
  district?: string;
  origin?: string;
};

export type ClarifyPayload = {
  session_id: string;
  topic: "location" | "time";
  answer: string;
};

export type ExecutePayload = {
  session_id: string;
};

export type ResolveConflictPayload = {
  session_id: string;
  choice: 0 | 1 | 2;
};

export type ProgressPayload = { percent?: number };
export type AgentStepPayload = { stage?: string; phase?: string; message?: string; logs?: string[]; summary?: string };
export type NeedsClarificationPayload = {
  session_id: string;
  topic?: "location" | "time";
  question?: string;
};
export type PlanReadyPayload = { session_id: string; plan_state?: unknown };
export type SuggestedActionsPayload = { actions?: unknown[] };
export type ActionProgressPayload = { index?: number; status?: string; detail?: string };
export type ConflictPayload = {
  session_id?: string;
  reason?: string;
  step_index?: number;
  options?: unknown[];
};
export type DonePayload = { final_message?: string };
export type ErrorPayload = { message?: string };

export type KnownSseEventMap = {
  progress: ProgressPayload;
  agent_step: AgentStepPayload;
  needs_clarification: NeedsClarificationPayload;
  plan_ready: PlanReadyPayload;
  suggested_actions: SuggestedActionsPayload;
  action_progress: ActionProgressPayload;
  conflict: ConflictPayload;
  done: DonePayload;
  error: ErrorPayload;
};

export type KnownSseEventName = keyof KnownSseEventMap;
export type KnownSseEnvelope<E extends KnownSseEventName = KnownSseEventName> = {
  event: E;
  data: KnownSseEventMap[E];
};
export type SseEnvelope = KnownSseEnvelope | { event: string; data: unknown };

// Prefer relative API calls in dev so Vite proxy can route to backend.
const API_BASE = (import.meta.env.VITE_API_BASE as string | undefined)?.trim() || "";

export function isSseEvent<E extends KnownSseEventName>(
  evt: SseEnvelope,
  event: E,
): evt is KnownSseEnvelope<E> {
  return evt.event === event;
}

async function streamPost<T extends object>(
  path: string,
  payload: T,
  onEvent: (evt: SseEnvelope) => void,
): Promise<void> {
  const response = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!response.ok || !response.body) {
    throw new Error(`SSE request failed: ${response.status}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const chunks = buffer.split(/\r?\n\r?\n/);
    buffer = chunks.pop() ?? "";
    for (const chunk of chunks) {
      const lines = chunk.split(/\r?\n/);
      let event = "message";
      let dataRaw = "";
      for (const line of lines) {
        const cleanLine = line.replace(/\r$/, "");
        if (cleanLine.startsWith("event:")) event = cleanLine.slice(6).trim();
        if (cleanLine.startsWith("data:")) dataRaw += cleanLine.slice(5).trim();
      }
      if (!dataRaw) continue;
      try {
        onEvent({ event, data: JSON.parse(dataRaw) });
      } catch {
        onEvent({ event, data: dataRaw });
      }
    }
  }
}

export function startPlan(payload: StartPlanPayload, onEvent: (evt: SseEnvelope) => void): Promise<void> {
  return streamPost("/api/plan/start", payload, onEvent);
}

export type LocateResult = { ok: boolean; city?: string; district?: string; formatted?: string; coord?: string; error?: string };

// 把经纬度发给后端逆地理编码,得到 city/district
export async function locateByCoords(lng: number, lat: number): Promise<LocateResult> {
  const response = await fetch(`${API_BASE}/api/locate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ lng, lat }),
  });
  if (!response.ok) return { ok: false };
  return (await response.json()) as LocateResult;
}

export function clarifyPlan(payload: ClarifyPayload, onEvent: (evt: SseEnvelope) => void): Promise<void> {
  return streamPost("/api/plan/clarify", payload, onEvent);
}

export function executePlan(payload: ExecutePayload, onEvent: (evt: SseEnvelope) => void): Promise<void> {
  return streamPost("/api/plan/execute", payload, onEvent);
}

export function resolveConflict(payload: ResolveConflictPayload, onEvent: (evt: SseEnvelope) => void): Promise<void> {
  return streamPost("/api/plan/resolve-conflict", payload, onEvent);
}

