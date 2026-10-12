// The desktop pet's animation rules (the animation pack's clips), from "Pet animation triggers.csv" in the My Assistant
// development notes. Weights: 1 normal, 3 "higher weight", 6 "higher than higher weight".
// Signals: "idle" = no keyboard/mouse input for IDLE_MS; "typing" = keyboard input; "tokens" = tokens used in the last
// TOKEN_ACTIVE_MS (app AI jobs or Claude Code); git events from the watched repositories.
import type { ActivityKind } from "./activity";

export interface ClipRule {
  clip: string;
  weight?: number; // default 1
  months?: number[]; // only in these months (1-12)
  dates?: string[]; // only on these days, "MM-DD"
  holiday?: boolean; // only on holidays (HOLIDAYS)
  minIdleMin?: number; // only after you've been idle this many minutes
  hours?: [number, number]; // only between these hours (e.g. [6.5, 9.5] = 06:30-09:30)
}

export const IDLE_MS = 60_000; // no input this long: idle
export const EXIT_IDLE_AFTER_MS = 3 * 60_000; // back after this long idle: an "exiting idle" clip
export const TOKEN_ACTIVE_MS = 75_000; // tokens seen this recently: "during token usage"

const H = 3; // higher weight
const HH = 6; // higher than higher weight

/** "Idle": the random routine while you're away from the keyboard and mouse. */
export const IDLE: ClipRule[] = [
  { clip: "东张西望" },
  { clip: "悠闲哼歌" },
  { clip: "超大伸懒腰" },
  { clip: "原地敲击桌面互动" },
  { clip: "原地重力下蹲压缩" },
  { clip: "照镜子" },
  { clip: "整体换装试色" },
  { clip: "原地专心玩魔方" },
  { clip: "原地蹲下玩玩具汽车" },
  { clip: "鲸鱼吐泡泡特效", minIdleMin: 5 },
  { clip: "原地跳跃抓碎头顶物品" },
  { clip: "玩游戏气急败坏" },
  { clip: "玩水枪" },
  { clip: "小提琴演奏" },
  { clip: "优雅女仆舞" },
  { clip: "轻快摇摆舞" },
  { clip: "可爱宅舞" },
  { clip: "吹气球" },
  { clip: "动物环绕" },
  { clip: "放风筝" },
  { clip: "拆礼物", holiday: true, weight: H },
  { clip: "变鸽子" },
  { clip: "扑克魔术" },
  { clip: "抽陀螺" },
  { clip: "吹笛子" },
  { clip: "蝴蝶蜜蜂环绕头顶开花" },
  { clip: "撸猫", minIdleMin: 5 },
  { clip: "凭空生花" },
  { clip: "骑木马" },
  { clip: "三球抛接" },
  { clip: "踢毽子" },
  { clip: "下五子棋" },
  { clip: "荡秋千" },
  { clip: "吃早餐", hours: [6.5, 9.5] },
  { clip: "吃午餐", hours: [11.5, 13.5] },
  { clip: "吃晚餐", hours: [17.5, 19.5] },
  { clip: "被落叶淹没", minIdleMin: 10 },
  { clip: "堆雪人", months: [12, 1, 2] },
  { clip: "放烟花", months: [12, 1, 2] },
  { clip: "写福字", months: [1, 2], weight: H },
  { clip: "穿针乞巧", months: [8], weight: H },
  { clip: "舞狮头", months: [1, 2], weight: H },
  { clip: "讨糖南瓜灯", months: [10, 11], weight: H },
  { clip: "插茱萸赏菊", months: [10], weight: H },
  { clip: "放河灯", months: [8, 9], weight: H },
  { clip: "萌化小幽灵", months: [10, 11], weight: H },
  { clip: "装点圣诞树", months: [12], weight: H },
  { clip: "放孔明灯", months: [2], weight: H },
  { clip: "螃蟹走路" },
  { clip: "原地漂浮踏步" },
  { clip: "碎碎念-擦桌碎碎念" },
  { clip: "碎碎念-发呆碎碎念" },
  { clip: "碎碎念-对屏碎碎念" },
];

/** "Typing": one after another while you type. */
export const TYPING: ClipRule[] = [{ clip: "写代码" }, { clip: "摇扇纳凉" }, { clip: "是啊，吃什么" }, { clip: "工作状态-原地踱步张望" }];

/** "During token usage": eating, one after another while tokens are being used. */
export const TOKENS: ClipRule[] = [
  { clip: "吃白饭" },
  { clip: "大口吃零食" },
  { clip: "吃Token" },
  { clip: "吃冰淇淋融化" },
  { clip: "吃大闸蟹" },
  { clip: "吃糖葫芦" },
  { clip: "吃长寿面", dates: ["06-06"], weight: HH },
  { clip: "吃西瓜" },
  { clip: "涮火锅" },
  { clip: "深度思考碎碎念" },
  { clip: "中秋赏月吃月饼", months: [9, 10], weight: HH },
  { clip: "吃粽子", months: [5, 6], weight: HH },
  { clip: "吃年糕", months: [1, 2], weight: HH },
  { clip: "吃青团", months: [3, 4], weight: HH },
  { clip: "吃腊八粥", months: [1], weight: HH },
  { clip: "吃重阳糕", months: [10], weight: HH },
  { clip: "收红包", months: [1, 2], weight: HH },
  { clip: "吃汤圆", months: [12, 2], weight: HH },
  { clip: "吃饺子", months: [12, 1, 2], weight: HH },
];

/** "Finishing token usage". */
export const TOKENS_DONE = "偷吃零食被抓住";

/** "Exiting idle": when you come back. In the morning, 打瞌睡被惊醒 is followed by 晨间刷牙. */
export const EXIT_IDLE: ClipRule[] = [{ clip: "女仆屈膝礼仪" }, { clip: "被吓一跳" }, { clip: "小幅度原地360度旋转展示" }, { clip: "打瞌睡被惊醒" }, { clip: "蓝鲸现世" }];
export const MORNING_AFTER: Record<string, string> = { 打瞌睡被惊醒: "晨间刷牙" };
export const MORNING: [number, number] = [5, 11];

/** Played right after another clip ends. */
export const FOLLOW: Record<string, string> = {
  偷吃零食被抓住: "用鲸鱼尾巴拍打地面",
  玩游戏气急败坏: "用鲸鱼尾巴拍打地面",
  "工作状态-垂头叹气冒汗": "用鲸鱼尾巴拍打地面",
};

/** Asleep (23:00-06:00 while you're idle): the nap loop, with a yawn now and then. */
export const SLEEP = { loop: "原地小憩沉眠", extra: ["哈欠连天"] };

/** While an app job runs: these clips take turns. */
export const WORK: Partial<Record<ActivityKind, string[]>> = {
  recording: ["轻快记录"],
  translating: ["轻快记录", "工作状态-思考冒泡"],
  transcribing: ["轻快记录", "工作状态-忙碌点按"],
  learning: ["工作状态-思考冒泡"],
  planning: ["工作状态-思考冒泡"],
  uploading: ["工作状态-忙碌点按"],
  importing: ["工作状态-忙碌点按"],
  saving: ["工作状态-忙碌点按"],
  syncing: ["工作状态-忙碌点按"],
};

/** Git, in the watched repositories. */
export const GIT = { committing: "工作状态-清点归档", committed: "工作状态-雀跃庆祝", reverted: "工作状态-垂头叹气冒汗" };
export const DEFAULT_REPOS = ["C:\\xampp\\htdocs\\chrisManager"];

/** Holidays (for 拆礼物): fixed days, plus Chinese New Year week. Edit to taste. */
const FIXED_HOLIDAYS = ["01-01", "05-01", "05-02", "05-03", "05-04", "05-05", "06-06", "10-01", "10-02", "10-03", "10-04", "10-05", "10-06", "10-07", "12-24", "12-25", "12-26"];
const CHINESE_NEW_YEAR = ["2026-02-17", "2027-02-06", "2028-01-26", "2029-02-13", "2030-02-03"];

const pad = (n: number) => String(n).padStart(2, "0");

export function isHoliday(d: Date): boolean {
  if (FIXED_HOLIDAYS.includes(`${pad(d.getMonth() + 1)}-${pad(d.getDate())}`)) return true;
  return CHINESE_NEW_YEAR.some((day) => {
    const diff = (d.getTime() - new Date(`${day}T12:00:00`).getTime()) / 86_400_000;
    return diff > -1.5 && diff < 6.5; // Eve to the 6th day
  });
}

/** Whether a rule applies now. */
export function allowed(r: ClipRule, now: Date, idleMin: number): boolean {
  const md = `${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const h = now.getHours() + now.getMinutes() / 60;
  if (r.months && !r.months.includes(now.getMonth() + 1)) return false;
  if (r.dates && !r.dates.includes(md)) return false;
  if (r.holiday && !isHoliday(now)) return false;
  if (r.minIdleMin && idleMin < r.minIdleMin) return false;
  if (r.hours && (h < r.hours[0] || h >= r.hours[1])) return false;
  return true;
}

/** A weighted pick among the rules that apply now, avoiding recently played clips when possible. */
export function pickRule(rules: ClipRule[], now: Date, idleMin: number, recent: string[], has: (clip: string) => boolean): string | null {
  const ok = rules.filter((r) => has(r.clip) && allowed(r, now, idleMin));
  if (!ok.length) return null;
  const fresh = ok.filter((r) => !recent.includes(r.clip));
  const pool = fresh.length ? fresh : ok;
  let x = Math.random() * pool.reduce((n, r) => n + (r.weight ?? 1), 0);
  return (pool.find((r) => (x -= r.weight ?? 1) < 0) ?? pool[0]).clip;
}
