/**
 * 活跃指示：会话标题栏里那枚心电图图标（全局活动脉冲与会话清单）。
 *
 * 2026-09-28 从 dsh-expert 整体迁来（原 `src/client/attention.jsx` +
 * `jobs.jsx` 里的浮层仲裁）。逻辑没有改，只做了三件搬家必须做的事：
 *
 *   1. 类名与关键帧前缀改成 `dsh-helper-pulse`（见 attention-css.js）——
 *      两个插件可能同时装在同一页上，各用各的前缀才不会互相覆盖。
 *   2. 文案从 T专家 的 locale 字典改成这里的中文常量表（辅助补丁没有 i18n 框架，
 *      与 schedule-copy.js 同一风格）。
 *   3. 偏好从「宿主持久化的设置项」改成 localStorage（见下面的 PULSE_PREF）——
 *      本插件里纯浏览器侧的开关一律存 localStorage，不为一个布尔值开一条 HTTP 路由。
 *      代价：原来在 T专家 设置里关掉过它的用户，迁过来是**开着**的，需要再关一次。
 *
 * 挂载点是 `conversation.session.header.utilities`（会话标题栏右侧那排按钮），
 * 与在 T专家 里完全一样 —— 位置、外观、行为都不变。
 *
 * ⚠️ 别改挂 `conversation.session.header.actions`：试过，实测落点在标题栏**左侧**
 * （x≈583）而那排按钮在右侧，位置不对（2026-09-15 用户定下 utilities 这个槽）。
 *
 * 颜色语义：彩色 = 有会话正在活动（自己在跑、或子代理在跑）**或**有事等你查看
 * （完成提醒还没消费）；灰色 = 全部空闲且没有待看。判定与宿主画会话行状态点**同源**：
 *   · `running`（或它下面有子代理在跑）→ 宿主 status `ongoing`
 *   · `completed`                      → 宿主 status `completed`（"有待查看的完成提醒"）
 *
 * 数据来源：会话投影（`sessions.list`）。⚠️ 这里刻意用 `ctx.get("sessions")` **惰查**，
 * 而不是把 "sessions" 写进客户端 cordis inject：inject 里声明了而宿主某版本没有这个服务，
 * 整个客户端 entry 会变成 FAILED，宿主的启动审计会让**整个 Web GUI** 停在
 * "Failed to load plugins" 页。一个可选的心电图图标，不该有这种后果。
 */
import React from "react";
import { PULSE_CSS } from "./attention-css.js";
import { createPreference } from "./prefs.js";
import { openHostSession } from "./session-nav.js";
import { Row } from "./ui.jsx";

/**
 * 是否显示这枚心电图图标。
 *
 * 键名用本插件前缀：搬过来时没有可继承的 localStorage 值（T专家 那份存在宿主设置文档里），
 * 所以键名无从"沿用"，直接用自己的前缀。默认 true —— 与原实现一致（设置没读到就先按显示处理）。
 */
export const PULSE_PREF = createPreference("dsh-helper:pulse:enabled", (raw) => raw !== "false", true);

/** 面板与无障碍标签的文案（原 T专家 字典里的 `pulse.*`）。 */
export const PULSE_TEXT = {
  on: "有会话正在活动，或有事等你查看",
  off: "全部空闲，且没有待你查看的",
  title: "需要注意的会话",
  empty: "现在没有需要注意的会话",
  running: "运行中",
  pending: "待查看",
  current: "当前会话",
  copy: "点此复制",
  copyHint: "复制会话 id",
  copied: "已复制",
  idPending: "暂无 id",
  idPendingHint: "当前会话的 id 尚未就绪",
  refresh: "刷新",
  refreshHint: "重新加载界面 —— 新装的技能、插件立即生效",
};
const t = (key) => PULSE_TEXT[key] ?? key;

/* ------------------------------------------------------------ 服务惰查 */

/**
 * 惰查一个客户端服务。
 *
 * cordis 对**未写进静态 inject** 的服务做属性访问会抛
 * `cannot get property "xxx" without inject`，而 `ctx.get(name)` 不会 ——
 * 所有可选依赖都从这里走，拿不到就降级，绝不把异常抛给组件树。
 */
function lookupService(ctx, name) {
  if (typeof ctx?.get !== "function") return undefined;
  try {
    return ctx.get(name);
  } catch {
    return undefined;
  }
}

/** 会话服务：先看槽位注入的 ctx，再退回插件自己的 ctx。 */
function sessionsService(...candidates) {
  for (const ctx of candidates) {
    const sessions = lookupService(ctx, "sessions");
    if (sessions?.list !== undefined) return sessions;
  }
  return undefined;
}

/* ------------------------------------------------------------ 活动清单 */

/**
 * 需要你注意的**主会话**清单：正在跑（自己或子代理）**或**有待查看的完成提醒。
 * 刻意排除两类：`origin === "subagent"`（子代理）与 `blank`（"新会话"占位行）—— 用户要的是
 * "点开能接上的主会话"。
 *
 * ⚠️ 返回的数组在内容未变时**必须保持同一个引用**：useSyncExternalStore 每次渲染都会调 getSnapshot，
 * 每次 new 一个数组会让 React 认为快照一直在变，直接重渲染死循环。所以用 key 做缓存。
 */
export const attentionCache = { key: "", list: [] };
export function useAttentionSessions(ctx) {
  const subscribe = React.useCallback((onChange) => {
    const list = sessionsService(ctx)?.list;
    if (typeof list?.subscribe !== "function") return () => {};
    return list.subscribe(onChange);
  }, [ctx]);
  const read = React.useCallback(() => {
    const byId = sessionsService(ctx)?.list?.getSnapshot?.()?.byId ?? {};
    // 「只有子代理在跑」也算这个主会话在活动。宿主投影里**没有**「在跑的子代理数」这个字段
    // （byId 只有 id/displayTitle/running/completed/blank/updatedAt/title/cwd/parentId/origin 这些），
    // 侧栏那枚状态点是它自己在 UI 层按 parentId 聚合出来的 —— 这里照同一口径自己算一份，
    // 而不是去读一个宿主从不投影的字段（那样这条判断永远为假，写了等于白写）。
    const runningSubagents = new Map();
    for (const id of Object.keys(byId)) {
      const child = byId[id];
      if (child?.origin !== "subagent" || child.running !== true) continue;
      // 子代理下面还可能有子代理：沿 parentId 上溯，把计数落到每一层祖先上。
      const seen = new Set();
      let parent = child.parentId;
      while (typeof parent === "string" && parent !== "" && !seen.has(parent)) {
        seen.add(parent);
        runningSubagents.set(parent, (runningSubagents.get(parent) ?? 0) + 1);
        parent = byId[parent]?.parentId;
      }
    }
    const rows = [];
    for (const id of Object.keys(byId)) {
      const session = byId[id];
      if (session === undefined || session === null) continue;
      if (session.origin === "subagent" || session.blank === true) continue;
      const running = session.running === true || (runningSubagents.get(id) ?? 0) > 0;
      const pending = session.completed === true;
      if (!running && !pending) continue;
      rows.push({
        id,
        title: session.displayTitle || session.title || id,
        running,
        pending,
        at: typeof session.updatedAt === "number" ? session.updatedAt : 0,
      });
    }
    // 正在跑的排前面，其次按最近活动时间倒序 —— 最该看的那条永远在最上面。
    rows.sort((a, b) => (a.running === b.running ? b.at - a.at : a.running ? -1 : 1));
    const key = rows.map((row) => `${row.id}:${row.running ? 1 : 0}${row.pending ? 1 : 0}:${row.title}`).join("|");
    if (key !== attentionCache.key) {
      attentionCache.key = key;
      attentionCache.list = rows;
    }
    return attentionCache.list;
  }, [ctx]);
  return React.useSyncExternalStore(subscribe, read, () => attentionCache.list);
}

/* ------------------------------------------------------------ 跳转到所属工作区 */

/** 展开失败只在第一次提示：能走到那里的是「上游接口变了 / 实例已释放」这类可疑态，每次点击都刷屏会淹掉有用的日志。 */
export let expandGroupFailureReported = false;
export function reportExpandFailure(cause) {
  if (expandGroupFailureReported) return;
  expandGroupFailureReported = true;
  console.warn("[dsh-helper] 展开工作区分组失败（只提示一次，不影响跳转）：", cause);
}

/**
 * 分组 key 沿用原生算法（`ui-workspace` 的 `owningGroupKey`）：会话所在工作区的 `workspaceId`；
 * 不属于任何工作区就是空串 —— 那是真实的「未分组桶」，不是空值。
 */
export function owningWorkspaceKey(items, sessionId) {
  return items.find((item) => Array.isArray(item?.sessionIds) && item.sessionIds.includes(sessionId))?.workspaceId ?? "";
}

/**
 * 跳转会话时顺带展开侧栏里它所属的工作区分组。
 *
 * 为什么得自己动手：原生侧栏的自动展开只在「该分组从未被记录过展开状态」时生效
 * （`ui-workspace` 里 `!Object.hasOwn(groupExpansion, group)` 那个 effect），用户手动折叠过一次的分组
 * 就被持久化成 false、从此跳过去也不展开；真正能强制展开的那条路（`revealSessionId`）只服务于侧栏搜索。
 * 展开状态存在 `sidebar.workspaces` 这个 slot 自己的 store 里，插件没有公开写入口 —— 这里用
 * `ctx.slots.hostFace().storeOf(entry)` 取回**侧栏正在用的那个 store 实例**（实例按 handle 缓存在
 * `resolveStore` 里、是同一个对象），直接调它的 `setGroupExpanded`，所以当场重渲染、不需要刷新页面。
 *
 * 预期态（工作区数据还没到、侧栏还没注册）就当这次不展开 —— 展开是顺手的体验优化，绝不能拖累跳转；
 * 可疑态（槽在、store 却认不出来）与异常才提示一次：上游接口改名时必须查得出来，又不能每次点击都刷屏。
 */
export function expandOwningWorkspaceGroup(ctx, sessionId) {
  try {
    if (typeof sessionId !== "string" || sessionId === "") return;
    const items = lookupService(ctx, "workspaces")?.list?.getSnapshot?.()?.items;
    // 工作区数据还没到就别猜：items 为空时任何会话都会被算成「未分组」，那等于把未分组桶
    // 展开并持久化下来（刷新后还在）。宁可这次不展开，用户再点一次自然会补上。
    if (!Array.isArray(items) || items.length === 0) return;
    // 认槽认的是 store 声明本身（`defineStore` 的 handle 上就带着 `spec.actions`），不认注册顺序：
    // 这样别的插件也往这条槽注册 store 时不会认错人，也不会顺手给它们白创建一个实例。
    const entries = ctx?.slots?.entries?.("sidebar.workspaces");
    if (!Array.isArray(entries) || entries.length === 0) return; // 侧栏还没注册：预期态，不报警。
    const entry = entries.find((row) => row?.store?.spec?.actions?.setGroupExpanded !== undefined);
    if (entry === undefined) {
      // 槽在、却没有任何 entry 认得出这个 store 声明 —— 只有上游改过接口才会这样，得能查出来。
      reportExpandFailure("侧栏槽里找不到带 setGroupExpanded 的 store 声明（上游接口可能改了）");
      return;
    }
    const store = ctx?.slots?.hostFace?.()?.storeOf?.(entry);
    if (store?.actions?.setGroupExpanded === undefined) {
      reportExpandFailure("拿到的侧栏 store 实例没有 setGroupExpanded（上游接口可能改了）");
      return;
    }
    const key = owningWorkspaceKey(items, sessionId);
    // 已经是展开态就别再写：store 每写一次都会通知订阅者，等于白让侧栏重渲染一轮。
    if (store.getSnapshot?.()?.groupExpansion?.[key] === true) return;
    store.actions.setGroupExpanded(key, true);
  } catch (error) {
    // 走到这里只剩「实例已释放 / storeOf 拒绝」这类意外；提示一次够诊断，且绝不冒泡打断跳转。
    reportExpandFailure(error);
  }
}

/* ------------------------------------------------------------ 复制会话 id */

/**
 * 当前会话 id 复制：Clipboard API 拒绝时退到 `document.execCommand("copy")`，
 * 两条路任一成功就当成功 —— 沙箱 iframe 里两者都可能丢，那也得给个反馈。
 * 这里只负责"复制"，失败也不冒泡 —— 复制是个锦上添花的体验，绝不能影响跳转。 */
function copyAttentionText(value) {
  try {
    if (typeof navigator !== "undefined" && typeof navigator.clipboard?.writeText === "function") {
      navigator.clipboard.writeText(value).catch(() => fallbackAttentionCopy(value));
      return true;
    }
  } catch {
    // navigator.clipboard 不在（嵌入 iframe / 老内核）就试 fallback。
  }
  return fallbackAttentionCopy(value);
}
function fallbackAttentionCopy(value) {
  try {
    const ta = document.createElement("textarea");
    ta.value = value;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.top = "0";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------ 浮层仲裁 */

/**
 * 标题栏那排浮层同一时刻只允许开一个 —— 两个都开必然互相遮挡。谁打开谁「认领」，
 * 另一方收到通知就让位。（从 T专家 `jobs.jsx` 搬来；本插件目前只有这一个标题栏浮层，
 * 留着这套机制是为了将来再有第二个时不必重写，成本只有一个 Set。）
 *
 * 这里**只发通知、不替对方改状态**：关面板各有各的语义。
 */
export const popoverClaim = { owner: "", listeners: new Set() };
export function claimPopover(id) {
  if (popoverClaim.owner === id) return;
  popoverClaim.owner = id;
  for (const listener of [...popoverClaim.listeners]) listener(popoverClaim.owner);
}
export function releasePopover(id) {
  if (popoverClaim.owner !== id) return;
  popoverClaim.owner = "";
  for (const listener of [...popoverClaim.listeners]) listener(popoverClaim.owner);
}
/** 订阅「谁认领了浮层」；回调收到当前认领者 id（没人认领是空串）。 */
export function subscribePopoverClaims(listener) {
  popoverClaim.listeners.add(listener);
  return () => popoverClaim.listeners.delete(listener);
}

/* ------------------------------------------------------------ 渲染 */

/** 当前会话快照的形状（id / 标题 / 是否在跑）。
 *
 * 字段由父组件 `HeaderPulse` 通过 host 标准 prop(`sessionId`)+ 选择器 hook(`useSession`)
 * 计算好，再以单条 prop 注入面板。面板里**不**订阅 store、不读 `sessions.list`
 * —— 之前的 `snapshot.current` 字段根本不在 SessionListState 的 schema 里
 * （只有 `ids + byId + phase + subagentsByParent + jobsBySession`），所以凡是
 * "读 list.getSnapshot().current" 的旧写法都拿不到值。这里直接从宿主给的 `sessionId`
 * 入手，host 保证它有值（只要当前还有活动的会话）。 */
export function deriveCurrentSession({ sessionId, sessionSnapshot, listEntry }) {
  // 三条来源按从硬到软排：标准 prop sessionId 永远有值；useSession 抓的是该 id 的完整快照；
  // listEntry 是 sessions.list.byId[id]，用来兜底题图与 running 状态。
  const id = typeof sessionId === "string" && sessionId !== "" ? sessionId : "";
  const entry = id !== "" ? listEntry : undefined;
  const snap = sessionSnapshot ?? entry ?? undefined;
  const title = (snap && (snap.displayTitle ?? snap.title)) ?? (entry && (entry.displayTitle ?? entry.title)) ?? "";
  const running = (snap && snap.running === true) || (entry && entry.running === true) || false;
  return { ready: id !== "", id, title, running };
}

/**
 * 刷新整页。
 *
 * 为什么是「整个页面」而不是「只刷新当前会话」：DSH 没有对外暴露单会话重载的接口，
 * 而技能目录在 `dsh-client-ui-skill` 里按 sessionId **永久缓存**，只有 `connection/reset`
 * 与 `agent-preset/selected` 两条失效路径 —— 新装的技能要出现在输入框的 `/` 菜单里，
 * 最省事又确定的做法就是整页重载（等价于宿主里 F12 → `location.reload()`）。
 *
 * 代价：界面状态（打开的面板、滚动位置）重置；会话本身在宿主侧，不会丢。
 */
function reloadPage() {
  try {
    window.location.reload();
    return;
  } catch (error) {
    // 预览 / 冒烟环境没有真实 location；真实页面里也可能是重载被策略拒绝。
    // 不静默吞：控制台留一条，排查时看得见。
    console.error("[dsh-helper] 刷新：location.reload() 抛错，改用 replace()", error);
  }
  try {
    window.location.replace(window.location.href);
  } catch (error) {
    console.error("[dsh-helper] 刷新：location.replace() 也抛错", error);
  }
}

/**
 * 标题栏里那枚独立的「刷新」按钮，紧挨在心电图右边。
 *
 * 为什么不放在心电图点开的面板里（2026-09-29 的教训）：那面板是 position:fixed 浮层，
 * 视觉上落在宿主 header 的**窗口拖动带**（-webkit-app-region:drag）里。拖动带拦的是
 * Chromium 浏览器层的事件 —— 鼠标按下那一刻就被系统拿去拖窗口了，**根本不会派进页面**，
 * 所以 document.elementFromPoint 查不出问题、补 no-drag 实测也救不回来。
 * 而标题栏这一排按钮（含心电图自己）由宿主统一罩在 no-drag 容器里、且都不脱离文档流，
 * 事件正常 —— 刷新按钮因此放在这一排，而不是浮层里。
 */
export function HeaderRefresh() {
  return (
    <button
      type="button"
      className="dsh-helper-refresh"
      onClick={reloadPage}
      title={t("refreshHint")}
      aria-label={t("refresh")}
    >
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
        <path d="M13.4 7.2a5.4 5.4 0 1 1-1.9-3.9" />
        <path d="M13.3 1.9v3.6H9.7" />
      </svg>
    </button>
  );
}

/** 点徽章弹出的会话清单：点一条就接上那个会话（宿主给的 `open(id)`）。 */
export function AttentionPanel({ anchor, sessions, onClose, onOpen, current }) {
  const [currentCopied, setCurrentCopied] = React.useState(false);
  // 复制成功的瞬时提示：1.5 秒回弹，避免误以为状态卡住。
  React.useEffect(() => {
    if (!currentCopied) return undefined;
    const timer = window.setTimeout(() => setCurrentCopied(false), 1500);
    return () => window.clearTimeout(timer);
  }, [currentCopied]);

  React.useEffect(() => {
    const onKey = (event) => { if (event.key === "Escape") onClose(); };
    const onDown = (event) => {
      const target = event.target;
      // 点面板内部或徽章本身都不关（徽章自己管开合），点其它地方才关。
      if (target instanceof Element && target.closest(".dsh-helper-pulse-pop, .dsh-helper-pulse") !== null) return;
      onClose();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onDown, true);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onDown, true);
    };
  }, [onClose]);
  // 渲染「当前会话」行：id 有就展示真实值、没有就展示占位符 + hint；
  // 当前会话标题跟在 id 后面（不是默认 session.list 里的条目，所以只需 `byId[id]`）。
  // 不论下面有没有「需要注意」的会话，这一行**始终显示**。
  const safeCurrent = current ?? { ready: false, id: "", title: "", running: false };
  const currentDisplayId = safeCurrent.id !== "" ? safeCurrent.id : (safeCurrent.ready ? "—" : "·");
  const currentHintKey = safeCurrent.id === "" ? "idPending" : (currentCopied ? "copied" : "copy");
  return (
    <div className="dsh-helper-pulse-pop" style={{ right: anchor.right, top: anchor.top }} role="dialog" aria-label={t("title")}>
      <div className="dsh-helper-pulse-pop-head">{t("title")}</div>
      <button
        type="button"
        className="dsh-helper-pulse-pop-current"
        data-copied={currentCopied}
        data-pending={safeCurrent.id === ""}
        onClick={() => {
          // 没 id 时不触发复制（点没意义），保持视觉静默（hint 已提示）。
          if (safeCurrent.id === "") return;
          const ok = copyAttentionText(safeCurrent.id);
          if (ok) setCurrentCopied(true);
        }}
        title={safeCurrent.id === "" ? t("idPendingHint") : t("copyHint")}
      >
        <span className="dsh-helper-pulse-pop-current-label">{t("current")}</span>
        <span className="dsh-helper-pulse-pop-id" data-monospace="true">{currentDisplayId}</span>
        {safeCurrent.title !== "" && <span className="dsh-helper-pulse-pop-current-title" title={safeCurrent.title}>{safeCurrent.title}</span>}
        <span className="dsh-helper-pulse-pop-current-hint">{t(currentHintKey)}</span>
      </button>
      {sessions.length === 0 ? (
        <div className="dsh-helper-pulse-pop-empty">{t("empty")}</div>
      ) : (
        sessions.map((row) => (
          <div key={row.id} className="dsh-helper-pulse-pop-item">
            <button type="button" className="dsh-helper-pulse-pop-row" onClick={() => onOpen(row.id)} title={row.title}>
              <span className="dsh-helper-pulse-pop-dot" data-state={row.running ? "running" : "pending"} aria-hidden="true" />
              <span className="dsh-helper-pulse-pop-title">{row.title}</span>
              <span className="dsh-helper-pulse-pop-tag">{t(row.running ? "running" : "pending")}</span>
            </button>
            <button
              type="button"
              className="dsh-helper-pulse-pop-id-btn"
              onClick={(event) => { event.stopPropagation(); copyAttentionText(row.id); }}
              title={t("copyHint")}
            >
              <span className="dsh-helper-pulse-pop-id" data-monospace="true">{row.id}</span>
            </button>
          </div>
        ))
      )}
    </div>
  );
}

/**
 * 标题栏里那枚心电图。props 全部来自宿主的槽位契约：
 * `sessionId` / `useSession`（会话快照选择器 hook）/ `open(id)`（官方跳转入口），
 * 外加注册时补进来的两个 ctx（槽位给的与插件自己的，见 installAttention）。
 */
export function HeaderPulse({ ctx, pluginCtx, sessionId, useSession, open }) {
  const show = PULSE_PREF.use();
  const sessions = useAttentionSessions(ctx);

  // 当前会话：host 在每会话槽里都给两个标准 prop —— `sessionId: SessionId` 与
  // `useSession: SnapshotSelectorHook<SessionSnapshot>`。这两个里 `useSession` 是 host 内部
  // 写的快照选择器 hook，与 `sessions.list.getSnapshot()` 那个 store 不在一棵订阅树里，
  // 所以不会出现"父组件已订阅同一 store、子组件再订阅"导致的 React 18 自检熔断。
  //
  // 老 fallback：`sessions.list.byId[sessionId]` —— 这一条只在 `useSession` 未提供时启用
  // （如 render-smoke 这种传了 ctx 但没传 prop 的场景），保证测试桩不爆。
  let current = { ready: false, id: "", title: "", running: false };
  if (typeof sessionId === "string" && sessionId !== "") {
    let snap;
    if (typeof useSession === "function") {
      // 注意：useSession 是选择器 hook，host 会按其调用解析当前 binding 的 session 快照。
      // 它自己维护订阅 / 稳定性，调用方只负责按需选字段。空选 sentinel 用 `.`，host 文档
      // 显式允许 "selector 可返回 snapshot 自身 / 任意子字段"。
      try {
        const got = useSession((s) => s ?? null);
        if (got && typeof got === "object") snap = got;
      } catch {
        // 新版 host 可能更改 useSession 的形参；不让一个 hook 失败把整棵子树炸了。
      }
    }
    let entry;
    if (snap === undefined) {
      entry = sessionsService(ctx)?.list?.getSnapshot?.()?.byId?.[sessionId];
    }
    current = deriveCurrentSession({ sessionId, sessionSnapshot: snap, listEntry: entry });
  } else {
    // 没有 sessionId 但有会话列表（比如某些嵌入式 / 占位槽）：回退去拿第一条非子代理的，
    // 保证面板里能看到一行。原始场景仅在没有活动会话时进入。
    const byId = sessionsService(ctx)?.list?.getSnapshot?.()?.byId ?? {};
    const first = Object.values(byId).find((e) => e?.origin !== "subagent");
    if (first !== undefined) {
      current = deriveCurrentSession({ sessionId: first.id, listEntry: first });
    }
  }

  // anchor === null 表示面板关着；否则记住"贴着徽章右缘、图标下方"的固定坐标。
  const [anchor, setAnchor] = React.useState(null);
  // 标题栏那排浮层互斥：别的浮层一开，这个面板就让位（两个都开会互相遮挡）。
  React.useEffect(() => subscribePopoverClaims((owner) => {
    if (owner !== "pulse") setAnchor(null);
  }), []);
  /** 关闭面板并交还浮层占用（Esc / 点外部 / 跳转会话都走这里）。 */
  const close = () => {
    setAnchor(null);
    releasePopover("pulse");
  };
  const attention = sessions.length > 0;
  if (!show) return null;
  const label = attention ? t("on") : t("off");
  const toggle = (event) => {
    if (anchor !== null) {
      close();
      return;
    }
    const rect = event.currentTarget.getBoundingClientRect();
    // 先认领再开面板：别的浮层收到通知会自己关掉。
    claimPopover("pulse");
    setAnchor({ right: Math.max(8, window.innerWidth - rect.right - 24), top: Math.round(rect.bottom) + 6 });
  };
  return (
    <React.Fragment>
      <button
        type="button"
        className="dsh-helper-pulse"
        data-on={attention}
        onClick={toggle}
        aria-label={label}
        aria-expanded={anchor !== null}
        title={label}
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          focusable="false"
        >
          {/* pathLength=100：把路径长度归一化，CSS 的 dasharray/dashoffset 就不用手算真实长度。 */}
          <path pathLength="100" d="M1 8h3.2l1.4-4.2 2.6 8.4 1.5-5.2 1 1H15" />
        </svg>
      </button>
      {anchor !== null && (
        <AttentionPanel
          sessions={sessions}
          anchor={anchor}
          current={current}
          onClose={close}
          onOpen={(id) => {
            // 先展开工作区分组再跳：侧栏能定位到这个会话，用户才看得到它接上了哪个工作区。
            const navCtx = pluginCtx ?? ctx;
            expandOwningWorkspaceGroup(navCtx, id);
            // 标题栏 utilities 会带上 header inject 的 open(id)，那才是宿主自己的跳转入口。
            openHostSession(navCtx, id, open);
            close();
          }}
        />
      )}
    </React.Fragment>
  );
}

/**
 * 设置卡片里的一组：开关 + 说明。
 *
 * 与呼吸灯、提示音同一套观感（ui.jsx 的 Row）。这里**不需要**跨槽位广播：
 * 开关只影响标题栏那一个组件的渲染，localStorage 偏好自带的订阅就够。
 */
export function PulseSettings() {
  const enabled = PULSE_PREF.use();
  return React.createElement(Row, {
    title: "显示活跃指示",
    hint: "会话标题栏里那枚心电图图标：有会话正在跑、或有事等你查看时显示彩色，全部空闲且无待看时显示灰色。点它可以列出需要注意的会话，点其中一条就直接接上那个会话。",
    checked: enabled,
    onToggle: () => PULSE_PREF.write(!enabled),
  });
}

/* ------------------------------------------------------------ 安装 */

/** 槽位 id：既是注册标识，也是 client-smoke 断言的对象。 */
export const PULSE_SLOT_ID = "dsh-helper-pulse";
/** 刷新按钮的槽位 id（与心电图同排，order 更大 = 排在它右边）。 */
export const REFRESH_SLOT_ID = "dsh-helper-refresh";

/**
 * 装活跃指示：注入样式 + 往标题栏 utilities 槽注册那枚心电图。
 *
 * ⚠️ 与 T专家 一样是**同步注册**（apply 不 await）：注册排在异步动作后面会表现为
 * "图标时有时无"。偏好关掉时组件自己 `return null`，不需要注销注册 —— 这与侧栏入口不同
 * （那是宿主画的行，只能靠注销），所以这里不必按偏好动静注册。
 */
export function installAttention(ctx) {
  ctx.effect(() => {
    const tag = document.createElement("style");
    tag.dataset.plugin = "dsh-helper-pulse";
    tag.textContent = PULSE_CSS;
    document.head.appendChild(tag);
    return () => tag.remove();
  }, "dsh-helper: pulse styles");

  ctx.slots.inject("conversation.session.header.utilities", () => ctx.slots.register({
    name: "conversation.session.header.utilities",
    id: PULSE_SLOT_ID,
    // order 取小：贴在那排按钮的靠前位置（与在 T专家 里一样）。
    order: 1,
    label: () => PULSE_TEXT.on,
  }, (props) => React.createElement(HeaderPulse, {
    ...props,
    // 槽位给的 ctx 用来读会话投影；插件自己的 ctx 用来跳转与展开分组（它一定能拿到 slots）。
    ctx: props?.ctx ?? ctx,
    pluginCtx: ctx,
  })));

  // 刷新按钮：与心电图同排、排在它右边（order 更大）。**不接 PULSE_PREF** ——
  // 它与「有没有会话在跑」无关，是个常驻小工具，不该被活跃指示的开关连坐。
  ctx.slots.inject("conversation.session.header.utilities", () => ctx.slots.register({
    name: "conversation.session.header.utilities",
    id: REFRESH_SLOT_ID,
    order: 2,
    label: () => PULSE_TEXT.refresh,
  }, () => React.createElement(HeaderRefresh)));
}
