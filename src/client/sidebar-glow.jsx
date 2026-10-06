/**
 * 活动呼吸灯：让「有活动会话」的工作区在左侧列表里呼吸，折叠时用橙色提示未读。
 *
 * 这一块原本是独立的 dsh-sidebar-glow 插件（0.1.x），后来整体并入 dsh-helper：
 * 逻辑一行没改，只是从「自己注册一个设置分区」改成接进「辅助补丁」分区里的一组设置。
 * 需要 shell.overlay 槽位（见 package.json 的 dsh.client.inject）。
 *
 * 官方没有给工作区行留插槽（`sidebar.workspaces` 是 single 且被 ui-workspace 占用，
 * 抢它等于重写整个工作区浏览器），所以这里走补丁路线：
 *
 *   1. 挂一个常驻的观察组件（`shell.overlay`，shell 级、不随侧边栏折叠卸载），
 *      从框架注入的 selector hook 里读活动状态；
 *   2. 给官方工作区行写一个自定义属性（`data-row-key` 是稳定的语义锚点，
 *      group.key 就等于 workspaceId）；
 *   3. 由注入的 CSS 驱动动画。
 *
 * 刻意不碰 className：那是一行由 React 的 clsx 管理的，下次重渲染就会把我们
 * 加的类抹掉；自定义属性和 inline style 不会被 React 清除。
 *
 * 三种提示风格都只动图标本身。早先试过「整行底色呼吸」——实拍对比里它确实最
 * 显眼，但整块都在闪太吵，已去掉。剩下的约束是：缩放 1.15 只差 2.4px，真正
 * 好认的还是「颜色」本身，所以默认风格让颜色在蓝 → 青 → 品红之间缓慢流转，
 * 并在轮廓外带一层同色的边缘光。光晕在两个风格里各司其职：默认风格是贴着轮廓
 * 的边缘光，光环风格是整圈光晕的呼吸扩散 —— 两者都用 drop-shadow 贴着图标
 * 轮廓走，而不是在外面套一个圆形。
 */
import React, { useEffect, useRef } from "react";
import { Row, ChoiceGroup } from "./ui.jsx";
import { createPreference } from "./prefs.js";

const NS = "dsh-helper-glow";
/** 打在活动工作区行上的标记属性；CSS 只认它。 */
const MARK_ATTR = "data-dsh-glow";
/**
 * 打在「有未读会话」的工作区行上的标记属性。
 *
 * 「未读」= 会话停下来等你确认（`status.completionUnread`），也就是会话行上
 * 那颗绿点（`[data-state="done"]`）。折叠的时候绿点看不见，所以把文件夹图标
 * 染成橙色顶上。
 *
 * 注意这里**只管有没有未读**，折叠与否交给 CSS 判：官方工作区行本来就是
 * `role="treeitem"` 带 `aria-expanded`，折叠时它自己会变，CSS 跟着重算，
 * 不用我们去监听属性变化。
 */
const UNREAD_ATTR = "data-dsh-glow-unread";
/** 挂在 <html> 上的风格开关，让 CSS 按风格切换动画。 */
const STYLE_ATTR = "data-dsh-glow-style";
/** 官方工作区行的锚点：`workspace:<workspaceId>`，未分组那组 id 为空串。 */
const ROW_SELECTOR = '[data-row-key^="workspace:"]';
const ROW_PREFIX = "workspace:";
/**
 * 偏好沿用并入前的 localStorage 键名（`dsh-sidebar-glow:*`）：改键名等于把现有的
 * 风格与节奏选择重置回默认，而这里的读取本来就能容忍缺失与旧值。
 */
const ENABLED_KEY = "dsh-sidebar-glow:enabled";
const STYLE_KEY = "dsh-sidebar-glow:style";
const SPEED_KEY = "dsh-sidebar-glow:speed";

const STYLES = [
  {
    id: "hue",
    label: "彩色流转",
    hint: "图标颜色在蓝 → 青 → 品红之间缓慢流转，轮廓外一层同色边缘光；大小、位置、描边都不动。",
  },
  {
    id: "beat",
    label: "脉冲",
    hint: "图标在常态灰与主题蓝之间明暗脉动。",
  },
  {
    id: "halo",
    label: "光环",
    hint: "图标轮廓外一层柔光呼吸扩散，形状跟着文件夹走，不占用行的背景色。",
  },
];
const DEFAULT_STYLE = "hue";
const STYLE_IDS = STYLES.map((style) => style.id);

/**
 * 节奏档。写成 CSS 变量 --dsh-glow-speed 挂在 <html> 上，
 * 三种风格按各自比例缩放（呼吸类动画比色相流转快一点才跟得上）。
 */
const SPEEDS = [
  { id: "slow", label: "慢", duration: "3.6s" },
  { id: "normal", label: "中", duration: "2.4s" },
  { id: "fast", label: "快", duration: "1.6s" },
];
const DEFAULT_SPEED = "normal";
const SPEED_IDS = SPEEDS.map((speed) => speed.id);

const CSS = `
/* 所有风格共有的图标着色。 */
[${MARK_ATTR}] > span:first-child {
  color: var(--dsw-alias-state-business-primary, #4d6bfe);
}

/* ---- 风格 beat：脉冲 ----
   只动图标。有效的是「颜色」：常态灰 → 主题蓝的跳变在 16px 上比透明度变化
   好认得多；缩放和光晕只是辅助。
   （这里原本编号为「风格 A（默认）」，但默认其实是 hue、数组顺序也是 hue 在前 ——
     按字母编号迟早与代码对不上，所以三段一律改用 id 命名。） */
html[${STYLE_ATTR}="beat"] [${MARK_ATTR}] > span:first-child svg {
  animation: dsh-sidebar-glow-beat 1.6s ease-in-out infinite;
  animation-duration: calc(var(--dsh-glow-speed, 2.4s) * 0.66);
}
@keyframes dsh-sidebar-glow-beat {
  0%, 100% {
    color: var(--dsw-alias-label-tertiary, #9aa0a6);
  }
  50% {
    color: var(--dsw-alias-state-business-primary, #4d6bfe);
  }
}

/* ---- 风格 halo：光环 ----
   光环的形状跟着图标走，而不是套一个圈。

   这里原本是两个正圆伪元素（border-radius 取 50%）向外扩散：
   参数调得再准，形状也对不上 —— 工作区图标是文件夹，一个正圆罩在外面很突兀。
   而图标本身有两种形状（row.expanded ? 展开文件夹 : 折叠文件夹），所以也不能
   拿一份写死的轮廓（mask）去贴，总有一种是错的。

   drop-shadow 的投影就是元素自己的 alpha 轮廓，两种图标都自动贴合：描边型的
   折叠图标得到一圈文件夹轮廓的柔光，填充型的展开图标得到同形状的柔光块。
   半径从 0.5px 呼吸到 1px + 3px + 8px：最内层是一道贴着轮廓的亮边 —— 描边型
   图标本身线细、投影的 alpha 少，少了这一层在浅色主题下几乎看不见；外面两层
   把光雾一圈圈推开。

   颜色用变量而不是 currentColor：filter 函数里的 currentColor 在部分 Safari
   版本上不生效。 */
html[${STYLE_ATTR}="halo"] [${MARK_ATTR}] > span:first-child {
  --dsh-glow-halo-color: var(--dsw-alias-state-business-primary, #4d6bfe);
}
html[${STYLE_ATTR}="halo"] [${MARK_ATTR}] > span:first-child svg {
  animation: dsh-sidebar-glow-halo 1.8s ease-in-out infinite;
  animation-duration: calc(var(--dsh-glow-speed, 2.4s) * 0.75);
}
@keyframes dsh-sidebar-glow-halo {
  0%, 100% {
    filter: drop-shadow(0 0 0.5px var(--dsh-glow-halo-color));
    opacity: 0.9;
  }
  50% {
    filter: drop-shadow(0 0 1px var(--dsh-glow-halo-color))
      drop-shadow(0 0 3px var(--dsh-glow-halo-color))
      drop-shadow(0 0 8px var(--dsh-glow-halo-color));
    opacity: 1;
  }
}

/* ---- 风格 hue：彩色流转（默认，见 DEFAULT_STYLE）----
   颜色流转 + 一圈贴着轮廓的边缘光。

   两层 drop-shadow 里，0.5px 那层是近场亮边（16px 上单靠 2.5px 的外层光晕
   几乎看不见，这道亮边才是"边缘"本身），2.5px 那层把光散出去。

   顺序上 drop-shadow 在前、hue-rotate 在后：投影先按主题色画好，再跟图标
   一起被旋转色相，所以边缘光的颜色始终跟当前色相一致 —— 变成橙金色的时候，
   边缘光也是橙金色的。反过来写（hue-rotate 在前）光晕会一直停在主题蓝。

   投影画在元素下方，填充型的展开图标会把中间那部分挡住，露出来的只有外圈，
   所以这层光只体现在边缘上。 */
html[${STYLE_ATTR}="hue"] [${MARK_ATTR}] > span:first-child {
  --dsh-glow-hue-color: var(--dsw-alias-state-business-primary, #4d6bfe);
}
html[${STYLE_ATTR}="hue"] [${MARK_ATTR}] > span:first-child svg {
  animation: dsh-sidebar-glow-hue 4s ease-in-out infinite;
  animation-duration: var(--dsh-glow-speed, 2.4s);
}
@keyframes dsh-sidebar-glow-hue {
  0% {
    filter: drop-shadow(0 0 0.5px var(--dsh-glow-hue-color))
      drop-shadow(0 0 2.5px var(--dsh-glow-hue-color))
      hue-rotate(0deg);
    opacity: 0.85;
  }
  50% {
    filter: drop-shadow(0 0 0.5px var(--dsh-glow-hue-color))
      drop-shadow(0 0 2.5px var(--dsh-glow-hue-color))
      hue-rotate(150deg);
    opacity: 1;
  }
  100% {
    filter: drop-shadow(0 0 0.5px var(--dsh-glow-hue-color))
      drop-shadow(0 0 2.5px var(--dsh-glow-hue-color))
      hue-rotate(360deg);
    opacity: 0.85;
  }
}

/* 关掉动效偏好时保留静态强调：颜色照给，动画全停。 */
@media (prefers-reduced-motion: reduce) {
  html[${STYLE_ATTR}] [${MARK_ATTR}],
  html[${STYLE_ATTR}] [${MARK_ATTR}] > span:first-child svg {
    animation: none;
    opacity: 1;
    transform: none;
  }
  /* 动画全停之后，图标仍然保持主题色，是静态但看得见的强调。 */
  html[${STYLE_ATTR}] [${MARK_ATTR}] > span:first-child svg {
    color: var(--dsw-alias-state-business-primary, #4d6bfe);
  }
  /* 光环停在一层贴着轮廓的柔光上。 */
  html[${STYLE_ATTR}="halo"] [${MARK_ATTR}] > span:first-child svg {
    filter: drop-shadow(0 0 2px var(--dsh-glow-halo-color));
  }
}

/* ---- 未读：折叠的工作区里有会话停下来等你确认（会话行上那颗绿点），
   就把文件夹图标染成橙色 —— 折叠时绿点看不见，只能靠图标本身说。

   这里只认「有没有未读」，折叠与否交给 CSS 判：官方工作区行是
   role="treeitem" 且带 aria-expanded，那是标准 ARIA 属性（不是哈希类名），
   而且它随折叠在 DOM 上变化，CSS 自己就会跟着重算 —— 不用为它监听属性变更。

   :root 前缀是为了压过风格规则的 animation/filter：未读是「要你回来看」的信号，
   比呼吸灯优先，所以直接停掉动画、清掉光晕，让橙色稳定可见。 */
:root [${UNREAD_ATTR}][aria-expanded="false"] > span:first-child {
  color: var(--dsw-alias-state-warn-primary, #f59e0b);
}
:root [${UNREAD_ATTR}][aria-expanded="false"] > span:first-child svg {
  animation: none;
  filter: none;
}
`;

/* --------------------------------------------------------------- 偏好存储 */

// createPreference 已提到 prefs.js：做「完成提示音」时它也要同一套东西，
// 复制第二份实现迟早会漂移。行为一字未改，只是换了个地方住。

const enabledPref = createPreference(ENABLED_KEY, (raw) => raw !== "false", true);
const stylePref = createPreference(
  STYLE_KEY,
  (raw) => (STYLE_IDS.includes(raw) ? raw : DEFAULT_STYLE),
  DEFAULT_STYLE,
);
const speedPref = createPreference(
  SPEED_KEY,
  (raw) => (SPEED_IDS.includes(raw) ? raw : DEFAULT_SPEED),
  DEFAULT_SPEED,
);

/** 当前节奏档的时长，作为 CSS 变量喂给三种动画。 */
function currentSpeed() {
  const id = speedPref.read();
  return (SPEEDS.find((item) => item.id === id) ?? SPEEDS[1]).duration;
}

/* ------------------------------------------------------------------ 样式 */

/**
 * 注入样式表；返回撤销它的函数（幂等）。
 *
 * 返回撤销函数而不是各扫门前雪：注入与移除必须成对，而 cordis 的 `ctx.effect` 正是
 * 表达"成对"的地方 —— 见 installGlow 里为什么这两件事都要在 effect 内做。
 */
function ensureStyle() {
  const tagId = `${NS}/active-workspace.css`;
  const existing = document.querySelector(`style[data-plugin-css="${tagId}"]`);
  // 已经在了就复用（同页可能被装两次），撤销时把它摘掉即可。
  if (existing !== null) return () => existing.remove();
  const tag = document.createElement("style");
  tag.dataset.plugin = NS;
  tag.dataset.pluginCss = tagId;
  tag.textContent = CSS;
  document.head.appendChild(tag);
  return () => tag.remove();
}

/** 把风格与节奏写到 <html> 上：风格决定播哪段动画，节奏决定多快。 */
function syncStyleAttribute() {
  const root = document.documentElement;
  root.setAttribute(STYLE_ATTR, stylePref.read());
  root.style.setProperty("--dsh-glow-speed", currentSpeed());
}

/**
 * 擦掉 syncStyleAttribute 写在 <html> 上的两处痕迹。
 *
 * `<html>` 是宿主的节点、不是我们创建的，所以组件卸载不会带走它们。不清的话插件
 * 卸载后 html 上仍挂着 `data-dsh-glow-style` 与那个 CSS 变量 —— 单独看无害，
 * 但重装/重载一次就多一层"上一次的残留"，而这类残留最难查（样式对不上却找不到来源）。
 */
function clearStyleAttribute() {
  const root = document.documentElement;
  root.removeAttribute(STYLE_ATTR);
  root.style.removeProperty("--dsh-glow-speed");
}

/**
 * 擦掉所有工作区行上的发光标记（`data-dsh-glow` / `data-dsh-glow-unread`）。
 *
 * 同上面的理由：这些属性写在**宿主侧栏的 DOM 节点**上，观察组件卸载时不会自动消失。
 * 不清的话插件卸载后侧栏那些行还在发光（CSS 也还在的话），或者留下一堆没人维护的属性。
 */
function clearMarks() {
  for (const node of document.querySelectorAll(`[${MARK_ATTR}], [${UNREAD_ATTR}]`)) {
    node.removeAttribute(MARK_ATTR);
    node.removeAttribute(UNREAD_ATTR);
  }
}

/* -------------------------------------------------------------- 活动判定 */

/**
 * 算出「有活动会话」的工作区 id 集合。
 *
 * 活动 = 会话正在跑，或停在等你操作（审批 / 回答 / 计划待审）。
 * 两者都取自框架的会话状态快照，而不是 DOM —— 折叠的工作区一样能被标记。
 *
 * @param statuses - sessionId → SessionStatus 的快照。
 * @param workspaces - 工作区快照，每项自带 sessionIds，归属不用自己按路径猜。
 * @returns 活动工作区的 id 集合。
 */
function collectActiveIds(statuses, workspaces) {
  const active = new Set();
  const items = workspaces?.items;
  if (!Array.isArray(items) || typeof statuses?.get !== "function") return active;
  for (const item of items) {
    const workspaceId = item?.workspaceId;
    const sessionIds = item?.sessionIds;
    if (workspaceId === undefined || !Array.isArray(sessionIds)) continue;
    for (const sessionId of sessionIds) {
      const status = statuses.get(sessionId);
      if (status === undefined) continue;
      const pending = status.pendingInteraction;
      if (status.running === true || (pending !== undefined && pending !== null)) {
        active.add(workspaceId);
        break;
      }
    }
  }
  return active;
}

/**
 * 算出「有未读会话」的工作区 id 集合。
 *
 * 未读 = `status.completionUnread`，也就是会话在主视图之外停下来、还等你确认
 * 的那种状态 —— 官方会话行上那颗绿点（`StateDot` 的 `state: "done"`）画的就是它。
 * 归档的会话不算：官方对归档行不画状态点，我们也不该点亮文件夹。
 *
 * @param statuses - sessionId → SessionStatus 的快照。
 * @param workspaces - 工作区快照，含成员 sessionIds 与全局归档集合。
 * @returns 有未读会话的工作区 id 集合。
 */
function collectUnreadIds(statuses, workspaces) {
  const unread = new Set();
  const items = workspaces?.items;
  if (!Array.isArray(items) || typeof statuses?.get !== "function") return unread;
  const archivedList = workspaces?.archivedSessionIds;
  const archived = new Set(Array.isArray(archivedList) ? archivedList : []);
  for (const item of items) {
    const workspaceId = item?.workspaceId;
    const sessionIds = item?.sessionIds;
    if (workspaceId === undefined || !Array.isArray(sessionIds)) continue;
    for (const sessionId of sessionIds) {
      if (archived.has(sessionId)) continue;
      if (statuses.get(sessionId)?.completionUnread === true) {
        unread.add(workspaceId);
        break;
      }
    }
  }
  return unread;
}

/**
 * 把标记对齐到当前 DOM。幂等：多余的标记会被摘掉。
 *
 * 活动与未读是两个独立属性：一个工作区可以同时在跑、又攒着未读。
 * 「折叠才显示橙色」不在这里判 —— 那是 CSS 按 `aria-expanded` 自己算的。
 *
 * @param activeIds - 活动工作区 id 集合。
 * @param unreadIds - 有未读会话的工作区 id 集合。
 */
function applyMarks(activeIds, unreadIds) {
  for (const row of document.querySelectorAll(ROW_SELECTOR)) {
    const key = row.getAttribute("data-row-key") ?? "";
    const workspaceId = key.slice(ROW_PREFIX.length);
    // 未分组那组的 key 是空串，没有对应的 workspaceId，不参与标记。
    const known = workspaceId !== "";
    if (known && activeIds.has(workspaceId)) row.setAttribute(MARK_ATTR, "");
    else row.removeAttribute(MARK_ATTR);
    if (known && unreadIds.has(workspaceId)) row.setAttribute(UNREAD_ATTR, "");
    else row.removeAttribute(UNREAD_ATTR);
  }
}

/* -------------------------------------------------------------- 观察组件 */

/** selector hook 需要返回快照本身；用同一个函数免得每次渲染都换引用。 */
function selectSelf(snapshot) {
  return snapshot;
}

/**
 * 只读状态、不渲染界面的常驻观察者。
 *
 * 挂在 `shell.overlay` 上：那是 shell 级的覆盖层，随应用常驻，
 * 不会因为侧边栏折叠而卸载（折叠时本来也看不到工作区列表，但重新展开时
 * 我们的标记已经在位，不会闪一下才亮）。
 *
 * @param props - 框架注入的 session / workspace selector hook。
 * @returns 一个隐藏占位节点。
 */
function ActiveWorkspaceWatcher({ useSessionStatus, useWorkspaces }) {
  const enabled = enabledPref.use();
  const statuses = useSessionStatus(selectSelf);
  const workspaces = useWorkspaces(selectSelf);
  const activeRef = useRef(new Set());
  const unreadRef = useRef(new Set());

  // 状态一变就重算并打标。两组 id 一起算、一起打：它们来自同一份快照，
  // 分两次遍历 DOM 只会白扫一遍。
  useEffect(() => {
    if (!enabled) {
      activeRef.current = new Set();
      unreadRef.current = new Set();
      applyMarks(activeRef.current, unreadRef.current);
      return;
    }
    activeRef.current = collectActiveIds(statuses, workspaces);
    unreadRef.current = collectUnreadIds(statuses, workspaces);
    applyMarks(activeRef.current, unreadRef.current);
  }, [enabled, statuses, workspaces]);

  // React 重建工作区行时标记会随节点一起消失，补一次。
  // 只认「新增节点里含工作区行」这一种情况：对话流式输出也在狂改 DOM，
  // 逐节点判断可以避免那些无关变更把我们叫醒。
  //
  // 不监听属性变化：折叠（aria-expanded）由 CSS 自己跟着算，我们需要重打的
  // 只有「节点被重建」这一种。
  useEffect(() => {
    if (!enabled) return undefined;
    let frame = 0;
    const schedule = () => {
      if (frame !== 0) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        applyMarks(activeRef.current, unreadRef.current);
      });
    };
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (node.nodeType !== 1) continue;
          const hit = node.matches?.(ROW_SELECTOR) === true
            || node.querySelector?.(ROW_SELECTOR) != null;
          if (hit) {
            schedule();
            return;
          }
        }
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      if (frame !== 0) cancelAnimationFrame(frame);
      // 标记写在宿主侧栏的节点上，组件卸载不会带走它们。这里擦掉，覆盖两种情况：
      // 用户关掉了「活动呼吸灯」开关（依赖 [enabled] 变化时也会跑这个清理），
      // 以及插件被卸载 —— 否则关掉开关后侧栏还在发光。
      clearMarks();
    };
  }, [enabled]);

  // 占位节点而非 null：不赌渲染器是否接受空返回，隐藏起来同样不占位。
  return React.createElement("span", { style: { display: "none" }, "aria-hidden": true });
}

/* -------------------------------------------------------------- 设置面板 */

// 开关（Switch）、行（Row）、互斥按钮组（ChoiceGroup）都在 ui.jsx：
// 插件设置卡片里两组设置共用同一套观感，各写一份迟早会漂移。

export function GlowSettings() {
  const enabled = enabledPref.use();
  const style = stylePref.use();
  const speed = speedPref.use();
  const activeStyle = STYLES.find((item) => item.id === style) ?? STYLES[0];

  // 外层容器与卡片标题交给设置卡片（index.jsx 的 Card「活动提示」），这里只出内容。
  return React.createElement(React.Fragment, null,
    React.createElement(Row, {
      title: "活动呼吸灯",
      hint: "打开后，左侧工作区列表里凡是有会话正在运行、或停在等你操作（审批 / 回答 / 计划待审）的工作区，"
        + "其文件夹图标会持续变色提示（行本身不变）。另外，折叠起来的工作区里若有未读"
        + "（会话停下来等你确认，也就是会话行上那颗绿点），文件夹图标会变成橙色。"
        + "关掉后所有提示立即停止。",
      checked: enabled,
      onToggle: () => enabledPref.write(!enabled),
    }),
    React.createElement(ChoiceGroup, {
      label: "提示风格",
      hint: activeStyle.hint,
      options: STYLES,
      value: style,
      onSelect: (id) => stylePref.write(id),
    }),
    React.createElement(ChoiceGroup, {
      label: "节奏",
      hint: "动画一轮的时长。三种风格按各自比例跟着缩放。",
      options: SPEEDS,
      value: speed,
      onSelect: (id) => speedPref.write(id),
    }),
  );
}

/* ------------------------------------------------------------------ 装配 */

/**
 * 装进宿主插件的 apply：注入样式、同步偏好、注册常驻观察组件。
 * 设置界面由插件信息页的设置卡片负责渲染（这里只导出 GlowSettings）。
 *
 * @param ctx - 客户端 cordis 上下文。
 */
export function installGlow(ctx) {
  ctx.effect(() => {
    // 样式表与 <html> 上的属性都必须在 effect **里面**注入：cordis 卸载 fiber 时会跑这些
    // 清理函数，注入与移除才成对。原先这两句写在 effect 外面，于是插件卸载后 CSS 标签与
    // data-dsh-glow-style 会一直留在页面上（重载一次叠一份；样式标签靠 ensureStyle 里的
    // querySelector 去重才没炸开 —— 那是运气，不是设计）。
    const removeStyle = ensureStyle();
    syncStyleAttribute();
    const unsubscribe = [
      stylePref.subscribe(syncStyleAttribute),
      speedPref.subscribe(syncStyleAttribute),
    ];
    const onStorage = (event) => {
      if (event.key === enabledPref.key) enabledPref.invalidate();
      if (event.key === stylePref.key) stylePref.invalidate();
      if (event.key === speedPref.key) speedPref.invalidate();
    };
    window.addEventListener("storage", onStorage);
    return () => {
      for (const off of unsubscribe) off();
      window.removeEventListener("storage", onStorage);
      // 顺序：先擦标记再摘样式、最后还原 <html> —— 反过来会有一瞬间"属性还在、样式没了"。
      clearMarks();
      clearStyleAttribute();
      removeStyle();
    };
  }, "dsh-helper: 呼吸灯样式与偏好同步");

  ctx.slots.inject("shell.overlay", () => ctx.slots.register({
    name: "shell.overlay",
    id: NS,
    order: 90,
  }, (props) => React.createElement(ActiveWorkspaceWatcher, props)));
}
