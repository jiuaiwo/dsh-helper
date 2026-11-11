/**
 * 客户端侧的 remote 信封（direct + TYPERT_REMOTE）。
 *
 * 与 host 的 lib/schedule-remote.js 一一对应：id / service / namespace 必须逐字一致，
 * 否则 api-gateway 找不到服务；typeSymbol 也保持同名（HelperPatchSchedule*），
 * 迁移自 dsh-expert 时只换命名空间不换 typeSymbol 会留下 TTeamSchedule* 残留。
 * 方法集合只保留定时任务那 7 个。
 */
import { z } from "zod";
import {
  scheduleInputSchema,
  schedulePatchSchema,
  schedulePreviewSchema,
  scheduleWorkspaceSchema,
  scheduleSnapshotSchema,
} from "../../lib/schedule-schemas.js";

/** 本插件 id（remote 描述符的 package 字段要与 package.json 的 name 一致）。 */
const PLUGIN_ID = "dsh-helper";

/** 客户端侧的 direct 调用信封（host 侧对应 lib/schedule-remote.js 的 descriptor()）。 */
export function direct(method, parameters, typeSymbol, schema) {
  return {
    id: `${PLUGIN_ID}#helperPatch/${method}`,
    service: "helperPatch",
    namespace: "helperPatch",
    method,
    invocation: { kind: "direct" },
    parameters,
    result: { mode: "strict", typeSymbol, schema, create: () => schema },
  };
}

export const TYPERT_REMOTE = {
  package: PLUGIN_ID,
  descriptors: [
    // 定时任务：读一份快照；写操作全部回传刷新后的整份快照，面板拿到直接重绘。
    direct("getSchedule", [], "HelperPatchSchedule", scheduleSnapshotSchema),
    direct("createScheduleItem", [
      { name: "input", wire: "input", source: "json", codec: { mode: "strict", typeSymbol: "HelperPatchScheduleInput", schema: scheduleInputSchema, create: () => scheduleInputSchema } },
    ], "HelperPatchSchedule", scheduleSnapshotSchema),
    direct("updateScheduleItem", [
      { name: "id", wire: "id", source: "json", codec: { mode: "strict", typeSymbol: "string", schema: z.string().min(1).max(128), create: () => z.string().min(1).max(128) } },
      { name: "patch", wire: "patch", source: "json", codec: { mode: "strict", typeSymbol: "HelperPatchSchedulePatch", schema: schedulePatchSchema, create: () => schedulePatchSchema } },
    ], "HelperPatchSchedule", scheduleSnapshotSchema),
    direct("deleteScheduleItem", [
      { name: "id", wire: "id", source: "json", codec: { mode: "strict", typeSymbol: "string", schema: z.string().min(1).max(128), create: () => z.string().min(1).max(128) } },
    ], "HelperPatchSchedule", scheduleSnapshotSchema),
    direct("runScheduleItem", [
      { name: "id", wire: "id", source: "json", codec: { mode: "strict", typeSymbol: "string", schema: z.string().min(1).max(128), create: () => z.string().min(1).max(128) } },
    ], "HelperPatchSchedule", scheduleSnapshotSchema),
    direct("ensureScheduleWorkspace", [
      { name: "path", wire: "path", source: "json", codec: { mode: "strict", typeSymbol: "string", schema: z.string().max(1024), create: () => z.string().max(1024) } },
    ], "HelperPatchScheduleWorkspace", scheduleWorkspaceSchema),
    // 只读解析：面板「新建任务」表单取默认工作区用它 —— 不建目录也不建工作区，
    // 所以"点开表单看一眼 / 填完又取消"不会留下副作用。返回的 workspace.id 可能是空串
    // （表示那个工作区还不存在，任务第一次执行时才建）。
    direct("resolveScheduleWorkspace", [
      { name: "path", wire: "path", source: "json", codec: { mode: "strict", typeSymbol: "string", schema: z.string().max(1024), create: () => z.string().max(1024) } },
    ], "HelperPatchScheduleWorkspacePeek", scheduleWorkspaceSchema),
    direct("previewSchedule", [
      { name: "cron", wire: "cron", source: "json", codec: { mode: "strict", typeSymbol: "string", schema: z.string().min(1).max(120), create: () => z.string().min(1).max(120) } },
    ], "HelperPatchSchedulePreview", schedulePreviewSchema),
  ],
};

/**
 * 解开 RemoteResult：远程调用成功返回 { ok: true, value }，失败返回 { ok: false, error }。
 * 失败时抛出带 code 的 Error，让调用方按 code 判别（载体失败不能用 try/catch 捕）。
 */
export function unwrap(result, action) {
  if (result !== null && typeof result === "object" && typeof result.ok === "boolean") {
    if (result.ok !== true) {
      const error = new Error(result.error?.message ?? `${action} failed`);
      error.code = result.error?.code;
      throw error;
    }
    return result.value;
  }
  return result;
}
