#!/usr/bin/env node
/**
 * 客户端组件的**渲染冒烟测试**：把每个组件真的渲染一遍（react-dom/server + 桩上下文）。
 *
 * 为什么需要它（从 T专家 搬定时任务时一并搬过来的经验）：
 *   · esbuild **打包不报**；
 *   · 冒烟里的文本断言看不出异常；
 *   · `tsc` 只看静态引用；
 *   · 而"引用了不存在的东西 / 组件内部炸"只在**组件真的被渲染**时暴露。
 * T专家 那边 0.3.49 的 ExpertPicker 残留就是靠这种测试才抓住的（症状是定时任务表单白屏）。
 *
 * ⚠️ 验证优先级：先静默（本脚本 / client-smoke / host-smoke），确实需要真实浏览器时才用
 * agent-browser，且用 headless —— 不要弹可见窗口打断用户。
 *
 * 退出码：0 = 全部渲染成功；1 = 有组件渲染失败（逐条打印组件与错误首行）。
 */
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const SELF_DIR = fileURLToPath(new URL(".", import.meta.url));
const HERE = process.env.DSH_HELPER_PATCH_REPO
  ?? (existsSync(join(SELF_DIR, "..", "lib", "index.js")) ? resolve(SELF_DIR, "..") : process.cwd());
const CLIENT_DIR = join(HERE, "src", "client");

/** 带 React 组件的客户端源文件（不含 index.jsx：它只做注册与注入，组件由这些文件导出）。 */
const COMPONENT_SOURCES = ["schedule.jsx", "sidebar-glow.jsx", "sound.jsx", "appearance.jsx", "attention.jsx", "ui.jsx"];

// 产物必须落在**仓库内**：它 require("react") 才能解析到本仓的 react（与测试脚本同一个实例；
// 放到 /tmp 会变成两个 React，报 "Invalid hook call"）。node_modules/.cache 不进 git。
const CACHE = join(HERE, "node_modules", ".cache", "helper-patch-render-smoke");
mkdirSync(CACHE, { recursive: true });
const ENTRY = join(CACHE, "entry.jsx");
const BUNDLE = join(CACHE, "bundle.cjs");
writeFileSync(ENTRY, `${COMPONENT_SOURCES.map((name) => `export * from ${JSON.stringify(join(CLIENT_DIR, name))};`).join("\n")}\n`);
await build({
  entryPoints: [ENTRY],
  // 官方客户端包在产物里是外部 require（由宿主模块表提供单例），测试环境里指向最小替身：
  // 冒烟要验的是"我们的组件树能不能被真 React 渲染出来"，不是上游包本身。
  alias: { "@deepseek-ai/dsh-client-ui-primitives": join(SELF_DIR, "primitives-stub.jsx") },
  outfile: BUNDLE,
  bundle: true,
  format: "cjs",
  platform: "node",
  external: ["react"],
  jsx: "transform",
  logLevel: "error",
});

const require = createRequire(import.meta.url);
const React = require("react");
const { renderToString } = require("react-dom/server");
const M = require(BUNDLE);

// ---- 桩（形状贴近真实调用，否则会把桩的问题误报成代码 bug）----
const noop = () => {};
const snapshot = {
  file: "/tmp/schedule.json",
  armed: true,
  running: [],
  items: [{ id: "item-1", title: "每日热点新闻", prompt: "看新闻", cron: "0 9 * * *", enabled: true,
            runs: [{ at: "2026-09-25T03:00:00.000Z", ok: true, sessionId: "session-1", prompt: "看新闻" }] }],
  workspaces: [{ id: "ws-1", title: "定时任务", path: "/tmp/tesk" }],
  capabilities: { agents: true },
};
const remote = {
  getSchedule: async () => ({ ok: true, value: snapshot }),
  previewSchedule: async () => ({ ok: true, value: { fires: ["2026-09-26T01:00:00.000Z"] } }),
  ensureScheduleWorkspace: async () => ({ ok: true, value: { workspace: snapshot.workspaces[0] } }),
  createScheduleItem: async () => ({ ok: true, value: snapshot }),
  updateScheduleItem: async () => ({ ok: true, value: snapshot }),
  deleteScheduleItem: async () => ({ ok: true, value: snapshot }),
  runScheduleItem: async () => ({ ok: true, value: snapshot }),
};
const ctx = {
  get: () => undefined,
  effect: (fn) => { try { fn(); } catch { /* 桩环境下的 effect 失败不影响渲染 */ } return noop; },
  slots: { register: () => ({ dispose: noop }) },
};

// 活跃指示的桩：会话投影走 `ctx.get("sessions")` 惰查，槽位另外注入 sessionId/useSession/open。
const pulseSessions = {
  phase: "ready",
  ids: ["session-1"],
  byId: { "session-1": { id: "session-1", displayTitle: "主会话", running: true } },
};
const pulseCtx = {
  get: (name) => (name === "sessions"
    ? { list: { subscribe: () => noop, getSnapshot: () => pulseSessions } }
    : undefined),
  effect: ctx.effect,
  slots: ctx.slots,
};

const cases = [
  ["ScheduleGlyph", () => React.createElement(M.ScheduleGlyph, { size: 16 })],
  ["CronPicker", () => React.createElement(M.CronPicker, { remote, value: "0 9 * * *", onChange: noop, disabled: false })],
  // ★ 面板本体：列表 + 详情 + 执行记录都在里面，渲染它能一次覆盖大部分组件树。
  ["SchedulePanel", () => React.createElement(M.SchedulePanel, { ctx, remote })],
  ["GlowSettings", () => React.createElement(M.GlowSettings, {})],
  // 提示音那组设置：无 window / 无 localStorage 的 Node 环境也要能渲染出来
  // （偏好读取失败要退回默认值，而不是把卡片整块炸掉）。
  ["SoundSettings", () => React.createElement(M.SoundSettings, {})],
  // 界面外观那组：Node 里没有 document，isDarwinDesktop() 必须安全退回 false 而不是抛错
  // （偏好读取失败要退回默认值，而不是把卡片整块炸掉）。
  ["AppearanceSettings", () => React.createElement(M.AppearanceSettings, {})],
  // 活跃指示那组设置（开关 + 说明）。
  ["PulseSettings", () => React.createElement(M.PulseSettings, {})],
  // 标题栏那枚心电图：useSession 是宿主注入的选择器 hook，这里给一个最小桩；
  // ctx 里没有 window，偏好读取必须安全退回默认值而不是把组件炸掉。
  ["HeaderPulse", () => React.createElement(M.HeaderPulse, {
    ctx: pulseCtx,
    pluginCtx: pulseCtx,
    sessionId: "session-1",
    useSession: (selector) => selector(pulseSessions.byId["session-1"]),
    open: noop,
  })],
  // ★ 标题栏那枚独立的刷新按钮：无 props、无 ctx，渲染它只验证「不炸」与图标在场。
  ["HeaderRefresh", () => React.createElement(M.HeaderRefresh)],
  // ★ 点开后的面板本体：当前会话行 + 会话清单 + 复制按钮都在里面，渲染它能一次覆盖大部分组件树。
  ["AttentionPanel", () => React.createElement(M.AttentionPanel, {
    anchor: { right: 8, top: 40 },
    sessions: [
      { id: "session-1", title: "主会话", running: true },
      { id: "session-2", title: "待看会话", running: false },
    ],
    current: { ready: true, id: "session-1", title: "主会话", running: true },
    onClose: noop,
    onOpen: noop,
  })],
];

const failures = [];
const rendered = new Map();
for (const [name, make] of cases) {
  try {
    rendered.set(name, renderToString(make()));
  } catch (error) {
    failures.push(`${name}：${String(error?.message ?? error).split("\n")[0]}`);
  }
}

if (failures.length > 0) {
  process.stderr.write(`客户端组件渲染失败 ${failures.length}/${cases.length}：\n`);
  for (const line of failures) process.stderr.write(`  ✗ ${line}\n`);
  process.stderr.write("提示：若错误指向桩数据（例如某字段 undefined），先核对本脚本的桩形状是否与真实调用一致。\n");
  process.exit(1);
}

/* ---- 渲染成功 ≠ 内容对：钉几条"空态也必须显示"的口径 ----
 *
 * ⚠️ renderToString **不跑 effect**，所以 SchedulePanel 渲染出来的一律是初始态：还在取数据、
 * items 是空的 —— 也就是说这条用例天然就是**空态**那一路（这也正是它此前没被任何断言覆盖的原因）。
 * 2026-09-29 用户口径：没有任务时也要摆出筛选标签与搜索框（官方「自动化任务」页就是这样，
 * 那时我们的实现把它们藏在 items.length > 0 后面，空页面上少了两块）。
 */
const contentFailures = [];
const panelHtml = rendered.get("SchedulePanel") ?? "";
for (const cls of ["dsh-helper-sched-filterTab", "dsh-helper-sched-search"]) {
  if (!panelHtml.includes(cls)) {
    contentFailures.push(`SchedulePanel（空态）里没有 ${cls} —— 一条任务都没有时也必须显示筛选标签与搜索框`);
  }
}
if (contentFailures.length > 0) {
  process.stderr.write(`客户端组件渲染内容断言失败 ${contentFailures.length} 条：\n`);
  for (const line of contentFailures) process.stderr.write(`  ✗ ${line}\n`);
  process.exit(1);
}
process.stdout.write(`客户端组件渲染冒烟通过（${cases.length}/${cases.length}）\n`);

// 文档不许说谎：核对 docs/DEVELOPMENT.md 自检表里写的项数（另两套冒烟末尾各有一条同样的核对）。
try {
  const doc = readFileSync(join(HERE, "docs", "DEVELOPMENT.md"), "utf8");
  const claimed = /^\| `npm run render-smoke` \|.*\|\s*(\d+)\s*项\s*\|$/mu.exec(doc)?.[1];
  if (claimed !== undefined && Number(claimed) !== cases.length) {
    process.stderr.write(`  ✗ docs/DEVELOPMENT.md 的自检表说 render-smoke 是 ${claimed} 项，实际 ${cases.length} 项（加了用例就同步那三个数字）\n`);
    process.exit(1);
  }
} catch {
  /* 文档读不到就跳过：核对文档不该成为冒烟本身的失败原因 */
}
