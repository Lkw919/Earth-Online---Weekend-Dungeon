"""场景配置中心：统一管理各场景的识别、POI 搜索、规划与文案。"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, List, Literal, Optional, Tuple

SceneId = Literal[
    "family", "friends", "couple", "solo", "parents", "pet", "study", "unknown"
]

ALL_SCENE_IDS: Tuple[str, ...] = (
    "family", "friends", "couple", "solo", "parents", "pet", "study",
)


@dataclass(frozen=True)
class SceneProfile:
    id: str
    label: str
    detect_hints: Tuple[str, ...]
    default_goal: str
    poi_keywords: Tuple[str, ...]
    poi_keywords_rainy: Tuple[str, ...]
    default_party_size: int
    share_audience: str
    share_tail: str
    planner_hint: str
    activity_tag_filters: Tuple[str, ...] = ()
    restaurant_tag_filters: Tuple[str, ...] = ()
    extra_constraints: Tuple[str, ...] = ()
    enable_cake_delivery: bool = False
    detect_priority: int = 0
    # 固定3步推荐(景点→餐厅→咖啡)的三类专属搜索关键词链。
    # 每条链按优先级排列: 先搜第一个,搜不到再依次降级,保证该类一定有候选。
    scenic_keywords: Tuple[str, ...] = ()
    restaurant_keywords: Tuple[str, ...] = ()
    cafe_keywords: Tuple[str, ...] = ()


SCENES: Dict[str, SceneProfile] = {
    "family": SceneProfile(
        id="family",
        label="家庭周末",
        detect_hints=("老婆", "孩子", "家人", "妻子", "宝宝", "娃", "亲子"),
        default_goal=(
            "今天下午是空的，想和老婆孩子出去玩几个小时，别离家太远，帮我安排一下。"
            "孩子5岁，老婆最近在减肥。"
        ),
        poi_keywords=("亲子乐园", "儿童乐园", "公园", "科技馆", "亲子餐厅"),
        poi_keywords_rainy=("亲子乐园", "儿童乐园", "科技馆", "亲子餐厅", "轻食"),
        default_party_size=3,
        share_audience="家人",
        share_tail="晚饭已订好。",
        planner_hint=(
            "家庭场景必须：主活动选亲子乐园/科技馆/博物馆/公园；"
            "晚餐选亲子餐厅/轻食/健康餐；禁止普通中餐馆、机关餐厅。"
        ),
        activity_tag_filters=("亲子", "孩子", "家庭"),
        restaurant_tag_filters=("家庭", "亲子", "孩子", "低卡", "轻食", "沙拉"),
        extra_constraints=("kid_friendly",),
        enable_cake_delivery=True,
        detect_priority=50,
        scenic_keywords=("亲子乐园", "儿童乐园", "科技馆", "公园"),
        restaurant_keywords=("亲子餐厅", "家庭餐厅", "餐厅"),
        cafe_keywords=("亲子咖啡", "甜品店", "咖啡"),
    ),
    "friends": SceneProfile(
        id="friends",
        label="朋友局",
        detect_hints=("朋友", "哥们", "闺蜜", "同学", "同事", "兄弟"),
        default_goal=(
            "今天下午想和朋友出去玩 5 个小时，4 个人 2 男 2 女，"
            "别离家太远，帮我安排一下。"
        ),
        poi_keywords=("展览", "citywalk", "小吃街", "餐厅", "咖啡"),
        poi_keywords_rainy=("展览", "餐厅", "小吃街", "咖啡"),
        default_party_size=4,
        share_audience="朋友",
        share_tail="晚饭已订好包厢，到时见！",
        planner_hint="朋友场景考虑 4 人聚餐、互动性强、可拍照打卡，优先包厢/卡座餐厅。",
        activity_tag_filters=("朋友", "展览", "citywalk"),
        restaurant_tag_filters=("朋友", "聚餐", "包厢"),
        detect_priority=40,
        scenic_keywords=("展览", "美术馆", "小吃街", "citywalk"),
        restaurant_keywords=("火锅", "聚餐餐厅", "餐厅"),
        cafe_keywords=("咖啡", "小酒馆", "甜品店"),
    ),
    "couple": SceneProfile(
        id="couple",
        label="情侣约会",
        detect_hints=("男朋友", "女朋友", "对象", "情侣", "约会"),
        default_goal="晚上想和对象约会 3 小时，别太远，安静一点有氛围。",
        poi_keywords=("电影院", "西餐", "夜景", "甜品", "浪漫"),
        poi_keywords_rainy=("展览", "咖啡", "西餐", "甜品", "电影"),
        default_party_size=2,
        share_audience="对象",
        share_tail="晚饭已订好，到时见。",
        planner_hint="情侣场景优先安静、有氛围的展览/咖啡/西餐，避免过于喧闹的场所。",
        activity_tag_filters=("情侣", "浪漫", "咖啡", "展览"),
        restaurant_tag_filters=("西餐", "情侣", "氛围", "安静"),
        extra_constraints=("quiet",),
        detect_priority=45,
        scenic_keywords=("美术馆", "展览", "电影院", "夜景"),
        restaurant_keywords=("西餐厅", "氛围餐厅", "餐厅"),
        cafe_keywords=("甜品店", "咖啡", "茶饮"),
    ),
    "solo": SceneProfile(
        id="solo",
        label="独处充电",
        detect_hints=("一个人", "独自", "自己", "独处", "单人行"),
        default_goal="今天下午一个人有空，想找个安静地方待 3 小时，看看书或者逛逛。",
        poi_keywords=("咖啡", "书店", "公园", "轻食", "展览"),
        poi_keywords_rainy=("咖啡", "书店", "展览", "图书馆", "轻食"),
        default_party_size=1,
        share_audience="自己",
        share_tail="按路线安排好了，一个人放松一下。",
        planner_hint="独处场景优先安静、可停留的咖啡/书店/展览，节奏自由，避免需要多人互动的项目。",
        activity_tag_filters=("咖啡", "书店", "展览", "安静"),
        restaurant_tag_filters=("轻食", "咖啡", "简餐"),
        extra_constraints=("quiet",),
        detect_priority=30,
        scenic_keywords=("书店", "美术馆", "展览", "公园"),
        restaurant_keywords=("轻食", "简餐", "餐厅"),
        cafe_keywords=("咖啡", "茶馆", "甜品店"),
    ),
    "parents": SceneProfile(
        id="parents",
        label="陪父母",
        detect_hints=("爸妈", "父母", "带老人", "老人", "长辈", "爷爷", "奶奶"),
        default_goal="周末想带爸妈出去转转 4 小时，节奏慢一点，别走太远。",
        poi_keywords=("公园", "博物馆", "茶馆", "粤菜", "园林"),
        poi_keywords_rainy=("博物馆", "茶馆", "展览", "餐厅"),
        default_party_size=3,
        share_audience="家人",
        share_tail="慢慢逛，晚饭也安排好了。",
        planner_hint=(
            "陪父母场景节奏要慢，优先公园/博物馆/茶馆/清淡餐厅，"
            "避免高强度亲子乐园和长时间暴晒。"
        ),
        activity_tag_filters=("公园", "博物馆", "茶馆", "园林"),
        restaurant_tag_filters=("粤菜", "淮扬", "清淡", "家庭"),
        extra_constraints=("slow_pace", "near_home"),
        detect_priority=55,
        scenic_keywords=("博物馆", "园林", "公园", "茶馆"),
        restaurant_keywords=("本帮菜", "家常菜", "粤菜", "餐厅"),
        cafe_keywords=("茶馆", "茶楼", "咖啡"),
    ),
    "pet": SceneProfile(
        id="pet",
        label="宠物出行",
        detect_hints=("狗", "狗狗", "猫", "宠物", "毛孩子", "遛狗"),
        default_goal="下午想带狗狗出去放风 2 小时，找个宠物友好的地方。",
        poi_keywords=("宠物公园", "宠物咖啡", "公园", "户外", "宠物友好"),
        poi_keywords_rainy=("宠物咖啡", "宠物店", "室内", "咖啡"),
        default_party_size=2,
        share_audience="朋友",
        share_tail="带毛孩子出门，路线安排好了。",
        planner_hint="宠物场景所有 POI 必须宠物友好，优先宠物公园/宠物咖啡/户外空间。",
        activity_tag_filters=("宠物", "户外", "公园"),
        restaurant_tag_filters=("宠物", "咖啡", "户外"),
        extra_constraints=("pet_friendly", "near_home"),
        detect_priority=35,
        scenic_keywords=("宠物公园", "公园", "绿地"),
        restaurant_keywords=("宠物友好餐厅", "露天餐厅", "餐厅"),
        cafe_keywords=("宠物咖啡", "猫咖", "咖啡"),
    ),
    "study": SceneProfile(
        id="study",
        label="自习办公",
        detect_hints=("学习", "自习", "办公", "看书", "备考", "写论文", "图书馆"),
        default_goal="下午要在附近找个安静地方自习 4 小时，顺便吃点轻食。",
        poi_keywords=("图书馆", "自习室", "咖啡", "轻食", "书店"),
        poi_keywords_rainy=("图书馆", "自习室", "咖啡", "轻食"),
        default_party_size=1,
        share_audience="自己",
        share_tail="自习地点找好了，轻食也安排了。",
        planner_hint=(
            "自习场景优先图书馆/自习室/安静咖啡，避免酒吧、夜店、纯娱乐 POI；"
            "可安排一顿轻食。"
        ),
        activity_tag_filters=("图书馆", "自习", "咖啡", "书店", "安静"),
        restaurant_tag_filters=("轻食", "咖啡", "简餐", "沙拉"),
        extra_constraints=("quiet", "near_home"),
        detect_priority=30,
        scenic_keywords=("图书馆", "自习室", "书店"),
        restaurant_keywords=("轻食", "简餐", "餐厅"),
        cafe_keywords=("咖啡", "书吧", "茶馆"),
    ),
}


def get_scene_profile(scene: Optional[str]) -> SceneProfile:
    if scene and scene in SCENES:
        return SCENES[scene]
    return SceneProfile(
        id="unknown",
        label="出行计划",
        detect_hints=(),
        default_goal="",
        poi_keywords=("公园", "餐厅"),
        poi_keywords_rainy=("展览", "餐厅"),
        default_party_size=2,
        share_audience="朋友",
        share_tail="活动已安排好。",
        planner_hint="优先距离近、评分高的 POI。",
        scenic_keywords=("景点", "公园", "展览"),
        restaurant_keywords=("餐厅", "美食"),
        cafe_keywords=("咖啡", "甜品店"),
    )


# 固定3步推荐的三个类别(决定输出顺序: 景点 → 餐厅 → 咖啡)
PLAN_BUCKET_ORDER: Tuple[str, ...] = ("scenic", "restaurant", "cafe")


def plan_bucket_keywords(scene: Optional[str]) -> Dict[str, List[str]]:
    """返回某场景的三类专属搜索关键词链(scenic/restaurant/cafe)。
    每条链按优先级排列,搜不到时由调用方依次降级。"""
    profile = get_scene_profile(scene)
    return {
        "scenic": list(profile.scenic_keywords) or ["景点", "公园"],
        "restaurant": list(profile.restaurant_keywords) or ["餐厅"],
        "cafe": list(profile.cafe_keywords) or ["咖啡"],
    }


def detect_scene_from_text(text: str) -> str:
    """按 detect_hints 与 priority 识别场景。"""
    ranked = sorted(SCENES.values(), key=lambda s: s.detect_priority, reverse=True)
    for profile in ranked:
        if any(hint in text for hint in profile.detect_hints):
            return profile.id
    return "unknown"


def scene_keywords(scene: str, *, rainy: bool = False) -> List[str]:
    profile = get_scene_profile(scene)
    return list(profile.poi_keywords_rainy if rainy else profile.poi_keywords)


def default_goals() -> Dict[str, str]:
    return {sid: SCENES[sid].default_goal for sid in ALL_SCENE_IDS if SCENES[sid].default_goal}
