/**
 * 定时事项的 cron 模型 ↔ 表达式纯函数（无 DOM、无 React）。
 *
 * 结构化选择器编辑一个小模型，产出 cron 表达式（croner 口径）：
 *   · **五段** `分 时 日 月 周` —— 老数据与一键模板都是这种写法，秒恒为 0；
 *   · **六段** `秒 分 时 日 月 周` —— 只有「秒 ≠ 0」时才这么写（2026-09-25 用户要求对齐官方
 *     「自动化任务」的时间选择器，那一页的时间是带秒的）。croner 与宿主都接受六段。
 * 模型表达不了的表达式一律回落 `custom` 模式并保留原文，打开一个"古怪"的定时器不会丢数据。
 *
 * 从 dsh-expert 迁移过来时整份照搬：本文件是纯函数，不依赖任何插件状态。
 */

/** 周几按钮的 UI 顺序（周一到周日）。cron 的 dow：周一=1 … 周六=6，周日=0。 */
export const WEEKDAY_KEYS = [1, 2, 3, 4, 5, 6, 0];

/** 一键模板：每一条都能反解回结构化模式（而不是落到 custom）。 */
export const CRON_PRESETS = [
  { id: "hourly", cron: "0 * * * *" },
  { id: "min30", cron: "*/30 * * * *" },
  { id: "daily9", cron: "0 9 * * *" },
  { id: "weekday830", cron: "30 8 * * 1-5" },
  { id: "mon10", cron: "0 10 * * 1" },
];

/** 「工作日」——「周一至周五」这个重复项直接落成 weekly + 这五天。 */
export const WORKDAYS = [1, 2, 3, 4, 5];

/**
 * 「每 N 秒 / 分钟 / 小时」可选的步长。
 *
 * 2026-09-25 用户要求「重复」的选项对齐官方「自动化任务」那一页（每周 / 周一至周五 / 每天 /
 * 每 N 小时 / 每 N 分钟 / 每 N 秒 / 自定义）；官方那页还有「仅一次」，cron 是周期语义、
 * 表达不了"跑一次就结束"，所以这里没有对应项（要做就得改宿主的调度与存储）。
 */
export const INTERVAL_STEPS = {
  second: [1, 5, 10, 15, 20, 30],
  minute: [1, 2, 5, 10, 15, 20, 30],
  hour: [1, 2, 3, 4, 6, 8, 12],
};

/** 解析一个十进制整数，超出 [min, max] 或非纯数字返回 null。 */
function int(value, min, max) {
  if (!/^\d+$/.test(value)) return null;
  const n = Number(value);
  return n >= min && n <= max ? n : null;
}

/**
 * 把 dow 字段（`*`、`1-5`、`1,3,5`、`0`/`7` 表示周日…）解析成周几键数组；
 * 不是"纯列表/范围"的写法（步长、英文缩写等）返回 null —— 那些一律走 custom 模式。
 */
export function parseDow(field) {
  if (field === "*") return null;
  const days = new Set();
  for (const token of field.split(",")) {
    const range = token.match(/^(\d+)-(\d+)$/);
    let lo;
    let hi;
    if (range) {
      lo = Number(range[1]);
      hi = Number(range[2]);
      if (lo > hi) return null;
    } else {
      lo = hi = Number(token);
    }
    for (let atom = lo; atom <= hi; atom++) {
      if (!Number.isInteger(atom)) return null;
      if (atom < 0 || atom > 7) return null;
      days.add(atom === 7 ? 0 : atom); // cron 里 7 也是周日
    }
  }
  if (days.size === 0) return null;
  return WEEKDAY_KEYS.filter((key) => days.has(key));
}

/**
 * 把 cron 表达式解析成选择器模型。
 * `model.mode` ∈ every | daily | weekly | custom。
 *   · every —— 「每 N 秒 / 分钟 / 小时」（`{ mode:"every", unit, n, minute?, second? }`）；
 *     `unit:"hour"` 时 `minute`（第几分）与 `second`（第几秒）才是时刻，秒/分钟单位用不到它们。
 *   · daily / weekly —— 固定时刻，weekly 带 `days`；秒为 0 表示表达式是五段写法。
 */
export function parseCron(str) {
  const raw = typeof str === "string" ? str.trim() : "";
  const custom = { mode: "custom", raw };
  const fields = raw.split(/\s+/);
  // 六段 = croner 的「秒 分 时 日 月 周」。秒位有两种合法形态：
  //   · 一个具体数字（0-59）—— 「每天 09:00:30」这种，照抄进模型，别丢进自定义模式；
  //   · `*/N` —— 「每 N 秒」的唯一写法，整条表达式必须只剩 `*`。
  let second = 0;
  let rest = fields;
  if (fields.length === 6) {
    const parsed = int(fields[0], 0, 59);
    if (parsed === null) {
      const stepSecond = fields[0].match(/^\*\/(\d+)$/);
      const tail = fields.slice(1);
      if (stepSecond && tail.every((field) => field === "*")) {
        const n = Number(stepSecond[1]);
        return INTERVAL_STEPS.second.includes(n) ? { mode: "every", unit: "second", n } : custom;
      }
      return custom;
    }
    second = parsed;
    rest = fields.slice(1);
  }
  if (rest.length !== 5) return raw === "" ? { mode: "daily", minute: 0, hour: 9, second: 0 } : custom;
  const [mf, hf, domf, monf, dowf] = rest;
  if (domf !== "*" || monf !== "*") return custom;

  // 间隔类：分位 / 小时位是 `*/N`，其余位置全是 *（dow 也必须是 *）。
  // 注意五段的步长写法里没有秒的位置 —— 带秒（≠0）的一律回落自定义，免得静默把秒吃掉。
  if (dowf === "*") {
    const stepMinute = mf.match(/^\*\/(\d+)$/);
    if (stepMinute !== null && hf === "*") {
      const n = Number(stepMinute[1]);
      if (second !== 0) return custom;
      return INTERVAL_STEPS.minute.includes(n) ? { mode: "every", unit: "minute", n } : custom;
    }
    const stepHour = hf.match(/^\*\/(\d+)$/);
    if (stepHour !== null) {
      const minute = int(mf, 0, 59);
      const n = Number(stepHour[1]);
      if (minute === null) return custom;
      return INTERVAL_STEPS.hour.includes(n) ? { mode: "every", unit: "hour", n, minute, second } : custom;
    }
  }

  // 时位是 `*`：`* * * * *`（每分钟）与 `M * * * *`（每小时第 M 分）都归到「每 N 小时」里（N=1）。
  if (hf === "*" && dowf === "*") {
    if (mf === "*") {
      if (second !== 0) return custom;
      return { mode: "every", unit: "minute", n: 1 };
    }
    const minute = int(mf, 0, 59);
    return minute === null ? custom : { mode: "every", unit: "hour", n: 1, minute, second };
  }

  // 每天 / 每周需要一个确定的时与分。
  const hour = int(hf, 0, 23);
  const minute = int(mf, 0, 59);
  if (hour === null || minute === null) return custom;
  const days = parseDow(dowf);
  if (days === null) return dowf === "*" ? { mode: "daily", hour, minute, second } : custom;
  return { mode: "weekly", hour, minute, second, days };
}

/** 把周几键数组压成 cron 记号（`[1..5]` → `1-5`）；周日（0）单独列在末尾。 */
export function formatDow(days) {
  const week = days.filter((d) => d >= 1 && d <= 6).sort((a, b) => a - b);
  const tokens = [];
  let start = null;
  let prev = null;
  const flush = () => {
    if (start === null) return;
    tokens.push(start === prev ? String(start) : `${start}-${prev}`);
    start = null;
  };
  for (const d of week) {
    if (start === null) { start = d; prev = d; } else if (d === prev + 1) { prev = d; } else { flush(); start = d; prev = d; }
  }
  flush();
  if (days.includes(0)) tokens.push("0");
  return tokens.join(",");
}

/** 由模型生成 cron 表达式（秒 ≠ 0 时写成六段）。 */
export function buildCron(model) {
  if (!model || model.mode === "custom") return (model?.raw || "").trim();
  const minute = model.minute ?? 0;
  const second = model.second ?? 0;
  const head = second === 0 ? "" : `${second} `;
  if (model.mode === "every") {
    const n = model.n ?? 1;
    if (model.unit === "second") return n === 1 ? "* * * * * *" : `*/${n} * * * * *`;
    if (model.unit === "minute") {
      // 每分钟的写法是 `* * * * *`（不是 `*/1`），与 parseCron 对称。
      return n === 1 ? "* * * * *" : `*/${n} * * * *`;
    }
    // 小时：`M */N * * *`，N=1 时退化成 `M * * * *`（每小时的第 M 分）。
    return `${head}${minute} ${n === 1 ? "*" : `*/${n}`} * * *`;
  }
  const hour = model.hour ?? 9;
  if (model.mode === "daily") return `${head}${minute} ${hour} * * *`;
  if (model.mode === "weekly") {
    const days = model.days && model.days.length ? model.days : [1];
    return `${head}${minute} ${hour} * * ${formatDow(days)}`;
  }
  return "";
}
