type AnyObj = Record<string, any>;

export type UiPlace = {
  place_id: string;
  time_slot: string;
  place_title: string;
  place_description: string;
  place_tags: string[];
  icon: "MapPin" | "Flag" | "Sparkles" | "IceCreamCone";
  placeImg?: string;
  location?: string;
  image_url?: string;
};

export type UiPlaceDetail = {
  detail_title: string;
  detail_place_name: string;
  detail_place_type: string;
  detail_recommend_reason: string;
  detail_distance: string;
  detail_duration: string;
  detail_queue_status: string;
  detail_open_status: string;
  detail_tags: string[];
  detail_address: string;
};

export type UiSegment = { distance: string; duration: string };

export type UiExecutionTask = {
  place: string;
  status: string;
  actionType: string;
  statusLabel: string;
  description: string;
  voucherLabel: string;
  voucherDim: boolean;
  location?: string;
  image_url?: string;
};

// 状态文案：结合动作类型 + 状态，给出更贴切的中文标签
export function taskStatusLabel(actionType: string, status: string): string {
  if (status === "failed") return "未完成";
  if (status === "fallback" || actionType === "queue") return "已排号";
  if (status === "success") {
    if (actionType === "reserve") return "已预约";
    if (actionType === "book_ticket") return "已购票";
    return "已安排";
  }
  // suggested / arranged / pending —— 尚未/无需提前下单
  return "待定";
}

// 兼容旧调用：仅按 status 给标签
export function statusLabel(status: string): string {
  return taskStatusLabel("", status);
}


function formatDistanceMeters(meters: number): string {
  if (!Number.isFinite(meters) || meters <= 0) return "—";
  if (meters >= 1000) return `${Math.round(meters / 100) / 10}km`;
  return `${Math.round(meters)}米`;
}

function formatDurationMinutes(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes <= 0) return "—";
  return `${Math.round(minutes)}分钟`;
}

function buildSegmentsFromSteps(steps: AnyObj[]): UiSegment[] {
  if (steps.length <= 1) return [];
  return steps.slice(0, -1).map((step, idx) => {
    const fromPoi = step?.poi || {};
    const toPoi = steps[idx + 1]?.poi || {};
    const fromLoc = String(fromPoi.location || "");
    const toLoc = String(toPoi.location || "");
    let distanceM = Number(toPoi.distance_meters || 0);
    if (fromLoc && toLoc && fromLoc.includes(",") && toLoc.includes(",")) {
      try {
        const [flng, flat] = fromLoc.split(",").map(Number);
        const [tlng, tlat] = toLoc.split(",").map(Number);
        const r = 6371000;
        const dlat = ((tlat - flat) * Math.PI) / 180;
        const dlng = ((tlng - flng) * Math.PI) / 180;
        const a =
          Math.sin(dlat / 2) ** 2 +
          Math.cos((flat * Math.PI) / 180) *
            Math.cos((tlat * Math.PI) / 180) *
            Math.sin(dlng / 2) ** 2;
        distanceM = Math.round(2 * r * Math.asin(Math.sqrt(a)));
      } catch {
        // keep poi distance fallback
      }
    }
    const durationMin = Number(toPoi.duration_minutes || 0);
    return {
      distance: formatDistanceMeters(distanceM),
      duration: formatDurationMinutes(durationMin),
    };
  });
}

function iconByCategory(category: string): UiPlace["icon"] {
  if (category.includes("餐") || category.includes("轻食")) return "Flag";
  if (category.includes("展览") || category.includes("博物馆") || category.includes("互动")) return "Sparkles";
  if (category.includes("咖啡") || category.includes("甜品")) return "IceCreamCone";
  return "MapPin";
}

function voucherLabelByAction(action: string): string {
  if (action === "book_ticket") return "电子票";
  if (action === "ride") return "打车凭证";
  if (action === "delivery") return "配送凭证";
  if (action === "visit") return "到店消费券";
  return "排号凭证";
}

function extractDistance(detail: string): string {
  const m = detail.match(/(\d+(?:\.\d+)?\s*(?:km|公里|米))/i);
  return m?.[1] || "未知";
}

export function adaptPlanState(planState: AnyObj) {
  const steps: AnyObj[] = planState?.plan_steps || [];
  const strategy = planState?.plan_strategy || {};
  const places: UiPlace[] = steps.map((step, idx) => {
    const poi = step?.poi || {};
    const category = String(poi.category || "");
    const address = String(poi.address || "");
    const baseDesc = String(step.note || step.selected_reason || "暂无描述");
    return {
      place_id: `p${idx + 1}`,
      time_slot: String(step.time_range || "待定"),
      place_title: String(poi.name || step.title || "未命名地点"),
      place_description: address ? `${baseDesc} · ${address}` : baseDesc,
      place_tags: (poi.tags || []).slice(0, 3),
      icon: iconByCategory(category),
      location: String(poi.location || ""),
      image_url: String(poi.image_url || ""),
    };
  });

  const details: UiPlaceDetail[] = steps.map((step) => {
    const poi = step?.poi || {};
    const queue = poi.queue_minutes;
    return {
      detail_title: `${poi.name || step.title || "地点"}详情`,
      detail_place_name: String(poi.name || step.title || "地点"),
      detail_place_type: String(poi.category || "地点"),
      detail_recommend_reason: String(step.selected_reason || step.note || "暂无推荐理由"),
      detail_distance: poi.distance_meters ? `${Math.round(Number(poi.distance_meters) / 100) / 10}km` : "未知",
      detail_duration: poi.duration_minutes ? `${Math.round(Number(poi.duration_minutes))}分钟` : "待定",
      detail_queue_status: queue == null ? "未知" : Number(queue) <= 0 ? "无需排队" : `预计排队 ${queue} 分钟`,
      detail_open_status: "营业中",
      detail_tags: (poi.tags || []).slice(0, 4),
      detail_address: String(poi.address || ""),
    };
  });

  const segments: UiSegment[] = buildSegmentsFromSteps(steps);

  const executionActions = (planState?.execution_actions || []) as AnyObj[];
  const suggested = (planState?.suggested_actions || []) as AnyObj[];
  const confirmed = executionActions.length > 0;
  const actionSource = confirmed ? executionActions : suggested;
  // 只保留「地点类」动作(预约/购票/排号/到店),过滤掉打车、配送等附属动作——
  // 它们的目标名常与景点重名,若混进卡片列表会出现重复任务。
  const PLACE_ACTIONS = ["reserve", "book_ticket", "queue", "visit"];
  const placeActions = actionSource.filter((a) => PLACE_ACTIONS.includes(String(a.action || "")));
  // 执行列表严格对应规划的每一个地点(steps),保证就是那几站、不重复、图片坐标对齐。
  const executionTasks: UiExecutionTask[] = steps.map((step, idx) => {
    const poi = step?.poi || {};
    const action = placeActions[idx] || null;
    const actionType = String(action?.action || "visit");
    const status = action ? String(action.status || "pending") : confirmed ? "pending" : "suggested";
    return {
      place: String(poi.name || action?.target || step.title || "地点"),
      status,
      actionType,
      statusLabel: taskStatusLabel(actionType, status),
      description: String(action?.detail || step.note || step.selected_reason || ""),
      voucherLabel: voucherLabelByAction(actionType),
      voucherDim: status === "suggested" || status === "arranged",
      location: String(poi.location || ""),
      image_url: String(poi.image_url || ""),
    };
  });

  const location = planState?.location || {};
  const debug = planState?.debug || {};
  const agent2 = debug?.agent2 || {};

  return {
    places,
    details,
    segments,
    executionTasks,
    routeSummary: String(strategy?.route_summary || ""),
    hasSteps: steps.length > 0,
    finalMessage: String(planState?.final_message || ""),
    errors: planState?.errors || [],
    locationLabel: [location.city, location.district].filter(Boolean).join("·"),
    dataSource: String(agent2.poi_source || "unknown"),
    origin: String(location.origin || ""),
  };
}

export function adaptExecutionActions(actions: AnyObj[]): UiExecutionTask[] {
  return (actions || []).map((action) => {
    const status = String(action.status || "pending");
    const actionType = String(action.action || "visit");
    return {
      place: String(action.target || "执行任务"),
      status,
      actionType,
      statusLabel: taskStatusLabel(actionType, status),
      description: String(action.detail || ""),
      voucherLabel: voucherLabelByAction(actionType),
      voucherDim: status === "suggested" || status === "arranged",
    };
  });
}

export function buildConflictSolutions(payload: AnyObj) {
  const options = payload?.options || [];
  return options.map((opt: AnyObj) => ({
    title: String(opt.title || "方案"),
    desc: String(opt.desc || ""),
    tags: Array.isArray(opt.tags) ? opt.tags.map(String) : [],
    button: opt.recommended ? "采用这个方案" : "选择这个方案",
    recommended: Boolean(opt.recommended),
  }));
}

export function inferVoucherCode(task: UiExecutionTask): string {
  return extractDistance(task.description) || task.place;
}

