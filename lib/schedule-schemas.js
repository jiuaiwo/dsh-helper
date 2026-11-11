// @ts-check
/**
 * 定时任务的线格式 schema（**单一源**，host 与客户端共用）。
 *
 * 从 dsh-expert 迁移过来时整段照搬，只把命名空间改掉：
 * 服务名、数据文件、错误码都与 T专家 无关，两个插件同时装也不会互相影响。
 */
import { z } from "zod";

// ---------------------------------------------------------------- 定时事项
// 与 @weibaohui/dsh-tasks 的线格式**刻意不同名**：两个插件可以同时安装，各自的 schema / 服务名 /
// 数据文件互不相干，谁先加载都不会影响对方。

/** 一次执行尝试：什么时候跑的、开出哪个会话、成败与失败原因。 */
export const scheduleRunSchema = z.object({
  at: z.string(),
  ok: z.boolean(),
  sessionId: z.string().optional(),
  error: z.string().optional(),
  // 这一次实际提交的提示词（2026-09-25 加：执行记录里要能看到"那次跑的是什么"）。
  // **可选**：这个字段是后加的，之前攒下的执行记录里没有 —— 面板据此判断要不要渲染那一段。
  prompt: z.string().optional(),
});

/** 一条定时事项。 */
export const scheduleItemSchema = z.object({
  id: z.string(),
  title: z.string(),
  prompt: z.string(),
  cron: z.string(),
  enabled: z.boolean(),
  /**
   * 执行次数上限与已执行次数（一次性任务 = maxRuns 1）。
   *
   * ⚠️ 这两个字段**必须**写进线格式 schema：zod 的 z.object 默认是 strip 模式，
   * 没声明的键过网关时会被**静默剥掉** —— 面板会拿不到它们，界面于是永远不显示限次信息
   * （踩过：加了引擎字段却忘了同步 schema）。
   */
  maxRuns: z.number().optional(),
  runCount: z.number().optional(),
  /**
   * 连续失败次数：成功一次清零，达到 MAX_FAIL_STREAK 自动停用这条事项。
   * 同样必须写进线格式（理由见上）—— 面板要靠它说明「为什么被自动停用了」，
   * 被 strip 掉就只剩一个光秃秃的停用状态，用户看不出是自己关的还是失败止损的。
   */
  failStreak: z.number().optional(),
  workspaceId: z.string().optional(),
  /** 绑定时记下的工作区目录：工作区被删后凭它「重建」回到原路径。面板也会在编辑表单里显示它。 */
  workspacePath: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  lastRunAt: z.string().optional(),
  lastRunError: z.string().optional(),
  runs: z.array(scheduleRunSchema),
});

/** 面板一次性拿全的数据：事项 + 开关 + 工作区选项 + 宿主能力探测。 */
export const scheduleSnapshotSchema = z.object({
  items: z.array(scheduleItemSchema),
  /** 定时事项功能是否启用（= 设置页那个开关的当前值）。 */
  armed: z.boolean(),
  /** 数据文件绝对路径（面板把它显示在说明里，便于用户备份）。 */
  file: z.string(),
  /** 正在执行中的事项 id（面板据此显示「执行中…」）。 */
  running: z.array(z.string()),
  /**
   * 迁移诊断：`merged` = 旧文件已自动合并到空目标；`stranded` = 旧文件仍有任务且目标非空，
   * 没法自动覆盖，需用户处理。日志用户在桌面/Web 里看不见，这条只能走面板 —— 缺了它，
   * 用户会以为任务还在跑或凭空消失。
   */
  migrationNotice: z.object({
    legacy: z.string(),
    target: z.string(),
    count: z.number().int().min(0),
    /** `merged` = 已自动合并；`stranded` = 仍搁浅，需用户处理。决定面板用哪条文案。 */
    kind: z.enum(['merged', 'stranded']),
  }).optional(),
  capabilities: z.object({ agents: z.boolean(), presets: z.boolean() }),
  /** 可选工作区（下拉选项）；path 是目录，面板显示给用户看落地位置。 */
  workspaces: z.array(z.object({ id: z.string(), title: z.string(), path: z.string().optional() })),
});

/** 新建/编辑表单提交的字段。 */
export const scheduleInputSchema = z.object({
  title: z.string().min(1).max(200),
  prompt: z.string().min(1).max(20000),
  cron: z.string().min(1).max(120),
  enabled: z.boolean(),
  /** 执行次数上限：留空/0 = 不限次数，1 = 一次性任务（跑完自动停用）。同样不能漏（见 item 上的说明）。 */
  maxRuns: z.number().int().min(0).optional(),
  /** 空串 = 不绑定工作区（显式解绑也走这个值）。 */
  workspaceId: z.string().max(200).optional(),
  /** 绑定时记下的工作区目录；老数据可缺省，按当前选中的 workspace 自动补。 */
  workspacePath: z.string().max(1024).optional(),
});

/** 编辑时的局部更新（未传的键保持原值）。 */
export const schedulePatchSchema = scheduleInputSchema.partial();

/** `previewSchedule` 的结果：接下来几次触发时间（ISO）。 */
export const schedulePreviewSchema = z.object({ fires: z.array(z.string()) });

/** `ensureScheduleWorkspace` 的返回：定时任务要绑定的工作区（默认「定时任务」工作区或自定义目录）。 */
export const scheduleWorkspaceSchema = z.object({
  workspace: z.object({ id: z.string(), title: z.string(), path: z.string() }),
});
