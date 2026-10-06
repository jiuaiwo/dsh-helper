/**
 * 会话跳转（执行记录里的「关联会话」与活跃指示的会话清单共用）。
 *
 * 从 dsh-expert 的 jobs.jsx 整段搬过来：openHostSession 按宿主版本依次试
 * uiWorkspace.openSession → sessions.open；sessionLinkState 判定会话是否还能打开
 * （归档会话宿主不让直接打开，硬跳会落到新建会话页）；restoreHostSession 走
 * uiWorkspace.unarchiveSession 把归档恢复回活跃。
 *
 * 2026-09-28 原名 schedule-jobs.js（只为定时任务的执行记录服务）；活跃指示迁进本插件后
 * 也走这里的 openHostSession，于是改名去掉 schedule 前缀 —— 它从来就不是定时任务专有的。
 */
// ---------------------------------------------------------------- 浮层仲裁 / 会话跳转

/**
 * 惰查 uiWorkspace：只能 `ctx.get("uiWorkspace")`，不能读 `ctx.uiWorkspace`。
 *
 * cordis 对未写入静态 inject 的服务做属性访问会抛
 * `cannot get property "uiWorkspace" without inject`；徽标点跳转一旦被这句打断，
 * 后面的 get() 根本走不到，表现就是「点了关面板、会话不动」。
 */
function lookupUiWorkspace(ctx) {
  if (typeof ctx?.get !== "function") return undefined;
  try {
    return ctx.get("uiWorkspace");
  } catch {
    return undefined;
  }
}

/**
 * 跳到会话（主会话 id，或 `{ parentSessionId, childSessionId, mode }` 子代理地址）。
 *
 * 顺序：标题栏官方 inject 的 `open(id)` → `ctx.get("uiWorkspace").openSession` →
 * 旧宿主 `sessions.open` / `openSubagent`。slotOpen 只认字符串 id（header 的 inject 签名）。
 */
export function openHostSession(ctx, target, slotOpen) {
  if (target === undefined || target === null || target === "") return;
  if (typeof target === "string" && typeof slotOpen === "function") {
    try {
      slotOpen(target);
      return;
    } catch (error) {
      console.error("[dsh-helper] 打开会话失败：", error);
    }
  }
  try {
    const uiWorkspace = lookupUiWorkspace(ctx);
    if (typeof uiWorkspace?.openSession === "function") {
      uiWorkspace.openSession(target);
      return;
    }
    if (typeof target === "string") {
      ctx?.sessions?.open?.(target);
      ctx?.layout?.selectPanel?.(null);
      return;
    }
    if (typeof ctx?.sessions?.openSubagent === "function") {
      ctx.sessions.openSubagent(target);
      return;
    }
    const childId = target?.childSessionId;
    if (typeof childId === "string") ctx?.sessions?.open?.(childId);
  } catch (error) {
    console.error("[dsh-helper] 打开会话失败：", error);
  }
}

/**
 * 跳到某个子代理的会话（与官方任务页同一个接口）。
 * 优先用宿主给的 subagentAddress 解析地址；拿不到就按 parentId 自己拼。
 */
export function openSubagentSession(ctx, item) {
  const sessions = ctx?.sessions;
  if (sessions === undefined || item?.id === undefined) return;
  const resolved = sessions.subagentAddress?.(item.id);
  const address = resolved ?? (item.parentId === undefined
    ? undefined
    : { parentSessionId: item.parentId, childSessionId: item.id, mode: item.mode ?? "continuable" });
  if (address === undefined) return;
  openHostSession(ctx, address);
}

/**
 * 判定一个会话"现在能不能打开"，口径与宿主官方任务页的 sessionLinkState **完全一致**：
 *   · `"archived"`    —— 在归档集合里。宿主从设计上不让直接打开归档会话（侧栏点它也只是提示），
 *                        `openSession` → `retain` 拿不到，最后会落到新建会话页；
 *   · `"unavailable"` —— 会话已经不在会话目录里（被删掉、或换了机器）；
 *   · `"loading"`     —— 目录还没就绪；
 *   · `"available"`   —— 正常，可以跳。
 *
 * 读的都是宿主自己的快照（`workspaces.list` 的 archivedSessionIds、`sessions.list` 的 phase/ids）。
 * 服务取不到、或形状对不上（宿主版本差异）时一律返回 `available` —— 判定失败不该挡住跳转，
 * 大不了退化成以前那种"点了落到新建页"的行为。
 */
export function sessionLinkState(ctx, sessionId) {
  if (typeof sessionId !== "string" || sessionId === "") return "unavailable";
  if (typeof ctx?.get !== "function") return "available";
  try {
    const sessions = ctx.get("sessions");
    const workspaces = ctx.get("workspaces");
    const sessionList = sessions?.list?.getSnapshot?.();
    const workspaceList = workspaces?.list?.getSnapshot?.();
    if (sessionList === undefined || workspaceList === undefined) return "available";
    if (workspaceList.state === "error") return "unavailable";
    if (sessionList.phase === "pending" || workspaceList.phase === "pending") return "loading";
    if (Array.isArray(workspaceList.archivedSessionIds) && workspaceList.archivedSessionIds.includes(sessionId)) return "archived";
    if (Array.isArray(sessionList.ids) && !sessionList.ids.includes(sessionId)) return "unavailable";
    return "available";
  } catch {
    // 未 inject 的服务做属性访问会抛（见上面 lookupUiWorkspace 的说明）——这里只读快照，
    // 拿不到就当"可跳"，不要把异常抛给调用方。
    return "available";
  }
}

/**
 * 恢复一个归档会话（`uiWorkspace.unarchiveSession` 在宿主的公开面上，与侧栏那枚
 * 「撤销归档」走的是同一个方法）。成功返回 true，失败返回 false —— 调用方据此决定要不要继续跳。
 */
export async function restoreHostSession(ctx, sessionId) {
  const uiWorkspace = lookupUiWorkspace(ctx);
  if (typeof uiWorkspace?.unarchiveSession !== "function") return false;
  try {
    await uiWorkspace.unarchiveSession(sessionId);
    return true;
  } catch (error) {
    console.error("[dsh-helper] 恢复归档会话失败：", error);
    return false;
  }
}
