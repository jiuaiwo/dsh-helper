// @ts-check
/**
 * 定时任务引擎：按 cron 表达式把提示词交给一个**全新的** agent 会话执行。
 *
 * 从 dsh-expert 迁移过来（该功能已整体移出 T专家）：服务名、数据文件、错误码
 * 一律与 T专家 无关，两个插件同时安装也不会互相影响。
 *
 * 为什么自建而不是直接依赖 `@weibaohui/dsh-tasks`：用户明确要求两个插件可以同时安装、
 * 同时可用。所以这里与它**零共享**——
 *   · 数据不落它的 `dsh_tasks` 存储域，而是辅助补丁自己的数据根（`$DSH_HOME/integrations/dsh-helper/schedule.json`）；
 *   · 服务名 `helperPatchSchedule`、错误码前缀 `helperPatch/schedule-*` 全部独立，两个插件的任务互不可见、互不干扰。
 *     提交给会话的提示词用 `source.kind: "user"`（聊天右侧才渲染用户气泡；`plugin` 源会被收成 inject）。
 *
 * 三件事在这里闭环：
 *   1. 持久化：一个 JSON 文件，原子写（与名册数据同风格）；
 *   2. 调度：每个启用项一个 croner job，宿主启动时全量重建，卸载时全部 stop；
 *   3. 执行：新建 agent 会话 → 挂部署默认 preset（不挂就没有工具）→ 提交提示词。
 *
 * 开关语义（用户口径）：`setArmed(false)` = 定时事项功能整体停用——**停止全部定时触发**
 * 且拒绝手动执行；任务与执行记录完整保留，重新 armed 后自动恢复调度。
 */
import { randomUUID } from "node:crypto";
import { readFileSync, renameSync } from "node:fs";
import { mkdir, open, rename } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { Cron } from "croner";

/**
 * 原子写：先写同目录的临时文件、**fsync 落盘**、再 rename（同目录 rename 是原子的）。
 *
 * fsync 不是多余的一步：没有它，rename 可能先于文件内容到达磁盘，机器断电（注意是断电，
 * 不是进程崩溃 —— 进程崩溃时内核缓存仍然会写完）就会留下一个"名字对了、内容是空"的
 * schedule.json，与「解析失败按空列表继续」叠加起来等于全部任务凭空消失。
 * 原先借的是 T专家 的 catalog.js，迁移时内联过来。
 */
export async function writeFileAtomic(path, text) {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.tmp-${process.pid}-${Date.now()}`;
  const handle = await open(temp, "w");
  try {
    await handle.writeFile(text, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temp, path);
}

/** 定时事项服务名（remote 侧的服务访问器用它）。 */
export const SCHEDULE_SERVICE = "helperPatchSchedule";
/** 数据文件名（落在辅助补丁的数据根下）。 */
export const SCHEDULE_FILE_NAME = "schedule.json";
/** 每条事项保留的执行记录条数（最旧的先丢）。 */
export const MAX_RUNS = 20;
/** 事项条数上限（防止一次误操作把设置文件写成天文数字）。 */
export const MAX_ITEMS = 200;
/** 标题 / 提示词的字符上限。 */
export const MAX_TITLE_CHARS = 200;
export const MAX_PROMPT_CHARS = 20000;
/**
 * 连续失败多少次就自动停用这条事项。
 *
 * 为什么需要它：失败不消耗 maxRuns 配额（见 withRun），于是一个配了坏提示词的分钟级 cron
 * 会**无限**开新会话 —— 烧额度、会话列表被刷满，而用户可能几小时后才注意到。这里做止损：
 * 连续失败到阈值就自动停用（落盘），面板上看得见「已停用 + 最后一次错误」，手动改好后重新启用即可。
 * 成功一次就把连续计数清零，所以偶发失败（网络抖动、宿主刚启动）不会累计。
 */
export const MAX_FAIL_STREAK = 5;
/** 写进会话消息来源的插件名（与 dsh-tasks 区分开，两个插件的任务是两回事）。 */

/**
 * cron 表达式校验：构造一个 `paused` 的探测 job（只解析、不真的挂定时器），
 * 随即 stop 掉，保证探测本身不会让事件循环多活一秒。
 * @param {unknown} expression - 待校验的表达式。
 * @param {(key: string, params?: Record<string, unknown>) => string} t - host 侧文案函数。
 */
export function validateCron(expression, t) {
  const text = typeof expression === "string" ? expression.trim() : "";
  if (text === "") throw new Error(t("schedule.cronEmpty"));
  try {
    const probe = new Cron(text, { paused: true }, () => undefined);
    probe.stop();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(t("schedule.invalidCron", { detail }));
  }
  return text;
}

/** 该表达式接下来的若干次触发时间（ISO 串），供面板在保存前预览。 */
export function previewRuns(expression, t, count = 5) {
  const text = validateCron(expression, t);
  const probe = new Cron(text, { paused: true });
  try {
    return probe.nextRuns(count).map((date) => date.toISOString());
  } finally {
    probe.stop();
  }
}

/** 短本地时间戳（`MM-DD HH:mm`）：同一个事项的多次运行在侧栏里要能区分开。 */
export function runStamp(iso) {
  const date = new Date(iso);
  const pad = (value) => String(value).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * 追加一条执行记录（超过上限丢最旧的），并刷新最近一次执行摘要字段。
 *
 * 计数口径（2026-09-28 改）：**只有成功的运行才消耗 maxRuns 配额**。
 * 改之前失败也计数，于是一个 `maxRuns: 1` 的一次性任务失败一次就 `enabled=false` 永久停用 ——
 * 用户看到的状态是「没成功却已停」，而且不会有任何重试机会。
 * 失败改为累计 `failStreak`，达到 MAX_FAIL_STREAK 才自动停用（止损见该常量注释）。
 */
export function withRun(item, entry) {
  const runs = [...(Array.isArray(item.runs) ? item.runs : []), entry].slice(-MAX_RUNS);
  const next = { ...item, runs, lastRunAt: entry.at };
  if (entry.ok === true) {
    // 次数上限：累计**成功**执行次数，达标就把这条自动停用。
    // 停用要落盘（下面 persist 会写到 schedule.json），因为 croner 的 maxRuns 计数只活在进程内存里
    // ——重启后重新计数，"只跑一次"的任务会再跑一次。这里落盘后 apply 就不会再给它挂定时器。
    if (typeof item.maxRuns === "number" && item.maxRuns > 0) {
      const runCount = (typeof item.runCount === "number" ? item.runCount : 0) + 1;
      next.runCount = runCount;
      if (runCount >= item.maxRuns) next.enabled = false;
    }
    delete next.failStreak;
    // 成功时**删掉**失败字段而不是置 undefined：线上（remote 严格 schema）与 JSON 都不需要
    // 一个"值为 undefined 的键"，留着只会让序列化前后形状不一致。
    delete next.lastRunError;
  } else {
    const failStreak = (typeof item.failStreak === "number" ? item.failStreak : 0) + 1;
    next.failStreak = failStreak;
    next.lastRunError = entry.error || "failed";
    if (failStreak >= MAX_FAIL_STREAK) next.enabled = false;
  }
  return next;
}

/** 校验一条事项的入参（面板提交的形状）；返回规范化后的字段。 */
export function normalizeInput(input, t) {
  if (input === null || typeof input !== "object") throw new Error(t("schedule.inputInvalid"));
  const raw = /** @type {Record<string, unknown>} */ (input);
  const title = typeof raw.title === "string" ? raw.title.trim() : "";
  const prompt = typeof raw.prompt === "string" ? raw.prompt : "";
  if (title === "") throw new Error(t("schedule.titleEmpty"));
  if (title.length > MAX_TITLE_CHARS) throw new Error(t("schedule.titleTooLong", { limit: MAX_TITLE_CHARS }));
  if (prompt.trim() === "") throw new Error(t("schedule.promptEmpty"));
  if (prompt.length > MAX_PROMPT_CHARS) throw new Error(t("schedule.promptTooLong", { limit: MAX_PROMPT_CHARS }));
  const cron = validateCron(raw.cron, t);
  const enabled = raw.enabled !== false;
  const workspaceId = typeof raw.workspaceId === "string" && raw.workspaceId !== "" ? raw.workspaceId : undefined;
  const workspacePath = typeof raw.workspacePath === "string" && raw.workspacePath !== "" ? raw.workspacePath : undefined;
  /**
   * 次数上限：1 = 只跑一次（一次性任务），N = 跑 N 次后自动停，`null` = 不限次（老行为）。
   *
   * ⚠️ 这里**总是**返回 `maxRuns` 键（哪怕值是 null），为的是让 update 分得清
   * "没提这件事"（保持原样）与"显式改回不限次"（传 0 / null）—— 与 workspaceId 的
   * 显式删除同一个套路。真正落盘时 null 会被删掉。
   *
   * 为什么用"次数"而不是"时刻"表达一次性：cron 语法里没有年份位（croner 也只认 5/6 段，
   * 第六段是秒），写了"某年某月某日"也只能表达成"每年哪天"。配上 maxRuns: 1 之后，
   * 它在跑完第一次就停了，等价于只在那一天跑一次。
   */
  let maxRuns = null;
  const rawMaxRuns = raw.maxRuns;
  if (rawMaxRuns !== undefined && rawMaxRuns !== null && rawMaxRuns !== "" && rawMaxRuns !== 0) {
    const value = typeof rawMaxRuns === "number" ? rawMaxRuns : Number(rawMaxRuns);
    if (!Number.isInteger(value) || value < 1) throw new Error(t("schedule.maxRunsInvalid"));
    maxRuns = value;
  }
  return {
    title, prompt, cron, enabled, maxRuns,
    ...(workspaceId === undefined ? {} : { workspaceId }),
    ...(workspacePath === undefined ? {} : { workspacePath }),
  };
}

/**
 * 创建定时事项引擎。
 *
 * @param {object} options
 * @param {any} options.ctx - 插件上下文（用 `ctx.get(...)` 懒查可选服务）。
 * @param {string} options.file - 数据文件绝对路径。
 * @param {any} options.logger - cordis logger（可缺省）。
 * @param {(key: string, params?: Record<string, unknown>) => string} options.t - host 文案函数。
 * @param {string} options.defaultCwd - 不绑定工作区时的会话工作目录。
 * @param {boolean} [options.armed] - 初始是否启用调度（= 界面开关的当前值）。
 * @param {(path: string, title?: string) => Promise<{ id: string, title: string, path: string }>} [options.ensureWorkspace]
 *   - 准备定时任务的工作区（默认「定时任务」工作区，或面板里填的自定义目录）。缺省则面板该项不可用。
 *     调用它会**真的建**（mkdir + 注册表建条目），只在执行路径上用它。
 * @param {(path: string) => { workspaceId?: string, workspacePath?: string }} [options.resolveWorkspace]
 *   - **只读**解析目标工作区（不 mkdir、不在注册表建条目）。面板「新建任务」表单取默认值用它，
 *     于是"点开表单看一眼 / 填完又取消"不会留下工作区；返回的 `workspaceId` 缺省即表示
 *     "还不存在，等第一次执行时建"。缺省则面板该项不可用。
 * @param {(path: string) => string} [options.reviseWorkspacePath]
 *   - 工作区目录的改判（host 注入）：把历史遗留的默认目录（`<宿主 cwd>/tesk`，task 的错拼）
 *     换成当前默认目录 `~/定时任务`。load 与执行两处都过它。缺省则完全不改判
 *     （行为与加这个选项之前逐字节一致）。
 * @param {{ stranded?: { legacy: string, target: string, count: number }, merged?: { legacy: string, target: string, count: number } }} [options.migrationNotice]
 *   - 数据迁移诊断（由 host 的 `migrateScheduleFile` 产出）。
 *     · `stranded` = 旧文件仍有任务、目标非空，没法自动覆盖（用户后续编辑会丢），需用户处理；
 *     · `merged` = 旧文件已合并到空目标（典型场景：本插件先于迁移闸门启动过一次留下空表）。
 *     snapshot 会把 kind=…一起带给面板，决定用哪条文案。
 *     ⚠️ 这个字段是 0.10.0 加的，当时漏了写进 JSDoc —— typecheck 上线后立刻被它抓出来
 *     （TS2339）。这正是"标了 `// @ts-check` 却从没进过 tsconfig 的 include"的代价。
 *     ⚠️ 0.15.0 起：host 合并成功后会把 `migration.legacy` 写进 target 顶层；engine load 时
 *     把它读成 `migrationTag`，snapshot 据此判断"已经迁移过" → 透传 `migrationNotice` 时会过滤掉。
 *     这是"用户在面板里删完任务，提示还在"的根治。
 */
export function createScheduleEngine(options) {
  const { ctx, file, logger, t, defaultCwd } = options;
  /** 工作区准备（默认「定时任务」工作区 / 自定义目录），由 host 注入。 */
  const ensureWorkspace = typeof options.ensureWorkspace === "function" ? options.ensureWorkspace : undefined;
  /**
   * 工作区**只读**解析（不建目录、不建条目），由 host 注入。
   * 与 ensureWorkspace 成对：面板新建表单取默认值走它，执行时建走 ensureWorkspace。
   */
  const resolveWorkspaceOption = typeof options.resolveWorkspace === "function" ? options.resolveWorkspace : undefined;
  /**
   * 工作区目录的**改判**（host 注入，可缺省）：把历史遗留的默认目录（`<宿主 cwd>/tesk`）
   * 换成当前默认目录（`~/定时任务`）。load 与执行两处都过它 —— 旧机器上那些已经绑到
   * `/usr/local/bin/tesk` 之类目录的任务，靠这一步在宿主重启后自愈。
   */
  const reviseWorkspacePath = typeof options.reviseWorkspacePath === "function" ? options.reviseWorkspacePath : undefined;
  /**
   * 旧数据文件路径（默认 ~/.t-team/schedule.json，可由 host 通过 DSH_HELPER_PATCH_SCHEDULE_LEGACY 覆盖）。
   * 用于判断"target 顶层 migration.legacy 是不是这个文件"——迁移标记是 host 写的、引擎只读、
   * 两边用同一个路径才不会脱钩（host 改 env 后忘了同步 engine 是常见 bug）。
   */
  const legacyPath = process.env.DSH_HELPER_PATCH_SCHEDULE_LEGACY
    ?? join(homedir(), ".t-team", "schedule.json");
  /**
   * 数据迁移诊断（由 host 的 migrateScheduleFile 产出，见 lib/index.js）。
   * 日志在桌面/Web 里用户看不见，所以这条"旧文件还有 N 条任务但没迁过来"必须走面板。
   * 两种情况都透传：`stranded` = 仍搁浅需用户处理；`merged` = 已自动合并（顺带告知）。
   */
  const migrationNotice = (() => {
    const source = options.migrationNotice;
    if (source === undefined) return undefined;
    if (source.stranded !== undefined) return { ...source.stranded, kind: 'stranded' };
    if (source.merged !== undefined) return { ...source.merged, kind: 'merged' };
    return undefined;
  })();
  /** @type {Map<string, any>} id → 事项 */
  const items = new Map();
  /** @type {Map<string, any>} id → croner job */
  const jobs = new Map();
  /** 正在执行中的事项 id：同一事项不并发跑两次。 */
  const running = new Set();
  let armed = options.armed !== false;
  /**
   * 迁移标记（target 顶层的 `migration` 字段）：合并成功后由 host 写入，启动后由 load 读到这里。
   * snapshot 据此判断"已经迁移过那个旧文件" → 不再显示提示；persist 也必须保留它，否则下次启动
   * 又会按"未迁移"处理。这是"用户在面板里删完任务，提示还在"的根治 —— 删任务**不会**碰 migration 字段。
   *
   * 类型用 unknown：load 时已经按"是对象就用、不是就当 undefined"过滤了，下面用时再做窄化。
   */
  let migrationTag = /** @type {{ legacy?: unknown, at?: unknown } | undefined} */ (undefined);
  /** 写盘串行链：并发变更不能交错写同一个文件。 */
  let writeChain = Promise.resolve();

  /**
   * 诊断日志的安全出口：**绝不允许日志把主流程带崩**。
   *
   * load 跑在 apply 期（插件加载阶段），那里抛一个错 = 整个插件没挂上 —— 用户看到的是
   * "定时任务功能整体消失"，而报错还来自一句本该无关紧要的 warn。宿主的 logger 实现各异
   * （有的在日志管道断开时会抛），所以 apply 路径上的告警一律走这里。
   */
  function safeWarn(message) {
    try {
      logger?.warn?.(message);
    } catch {
      /* 日志本身炸了就放弃这条日志，主流程照走 */
    }
  }

  /** 读盘（同步，apply 期就要拿到数据）。读不动时**出声**并按空列表继续。 */
  function load() {
    let text;
    // 改判计数：声明在解析的 try **外面** —— 处理它的代码在 try/catch 之后（见函数末尾那段），
    // 声明在 try 里会变成块级作用域，外面根本看不见（写这段时踩过一次）。
    let revisedCount = 0;
    try {
      text = readFileSync(file, "utf8");
    } catch (error) {
      const code = /** @type {any} */ (error)?.code;
      if (code !== "ENOENT") {
        safeWarn(`[dsh-helper] 定时事项数据文件读取失败（按空列表继续）：${file}：${error instanceof Error ? error.message : String(error)}`);
      }
      return;
    }
    try {
      const parsed = JSON.parse(text);
      const list = Array.isArray(parsed?.items) ? parsed.items : [];
      // 顶层 migration 字段（合并成功的标记）：load 时读进来，persist 时再原样写回。
      // 容错形状：migration 必须是对象；不是就当 undefined，绝不让一个坏标记阻塞启动。
      if (parsed !== null && typeof parsed === "object") {
        const tag = (/** @type {any} */ (parsed)).migration;
        if (tag !== null && typeof tag === "object") {
          migrationTag = /** @type {{ legacy?: unknown, at?: unknown }} */ (tag);
        }
      }
      for (const entry of list) {
        if (entry === null || typeof entry !== "object") continue;
        if (typeof entry.id !== "string" || typeof entry.cron !== "string") continue;
        // 历史遗留的工作区目录（`<宿主 cwd>/tesk`）在**读盘这一步**就改判掉：面板显示、执行、
        // 调度三处都读内存里的同一份 items，改在这里它们才一致。
        const rawPath = typeof entry.workspacePath === "string" && entry.workspacePath !== "" ? entry.workspacePath : "";
        const finalPath = rawPath === "" || reviseWorkspacePath === undefined
          ? rawPath
          : (reviseWorkspacePath(rawPath) ?? rawPath);
        // "改判过"只认**语义上真的换了目录**（resolve 之后才比）：纯粹的大小写、尾斜杠、
        // `.`/`..` 归一化不该算数 —— 那会白丢一条健康的 workspaceId（执行时退化成"按路径重建"，
        // 多一次 create 调用），而 `~` 那种真需要展开的仍然会判为改判（resolve 不比配家目录）。
        const pathRevised = finalPath !== rawPath && resolve(rawPath) !== resolve(finalPath);
        if (pathRevised) revisedCount += 1;
        items.set(entry.id, {
          id: entry.id,
          title: typeof entry.title === "string" ? entry.title : "",
          prompt: typeof entry.prompt === "string" ? entry.prompt : "",
          cron: entry.cron,
          enabled: entry.enabled !== false,
          // 改判过的路径说明它原来绑的是坏工作区，workspaceId 必须一起丢掉 ——
          // 留着的话执行时 registry.get 又把它捞回来，改判等于没做。
          ...(!pathRevised && typeof entry.workspaceId === "string" && entry.workspaceId !== "" ? { workspaceId: entry.workspaceId } : {}),
          // 绑定时同步记下当时的工作区目录：工作区被删后用它「重建」回到原路径，避免要用户重填。
          ...(finalPath !== "" ? { workspacePath: finalPath } : {}),
          createdAt: typeof entry.createdAt === "string" ? entry.createdAt : new Date().toISOString(),
          updatedAt: typeof entry.updatedAt === "string" ? entry.updatedAt : new Date().toISOString(),
          ...(typeof entry.lastRunAt === "string" ? { lastRunAt: entry.lastRunAt } : {}),
          ...(typeof entry.lastRunError === "string" ? { lastRunError: entry.lastRunError } : {}),
          // 次数上限与已执行次数。⚠️ maxRuns 是"最多跑几次"，**不是**每条保留的执行记录数
          // ——那个字段叫 runs（数组）。runCount 由 withRun 累计，达标即自动停用。
          // 之所以要把"停用"落盘、而不是只靠 croner 的 maxRuns：那个计数活在进程内存里，
          // 宿主一重启就重新计数，"只跑一次"的任务会再跑一次。
          ...(Number.isInteger(entry.maxRuns) && entry.maxRuns > 0 ? { maxRuns: entry.maxRuns } : {}),
          ...(Number.isInteger(entry.runCount) && entry.runCount > 0 ? { runCount: entry.runCount } : {}),
          // 连续失败计数：重启后要接着数，否则「连续失败 N 次自动停用」能被重启无限重置。
          ...(Number.isInteger(entry.failStreak) && entry.failStreak > 0 ? { failStreak: entry.failStreak } : {}),
          runs: Array.isArray(entry.runs) ? entry.runs.slice(-MAX_RUNS) : [],
        });
      }
    } catch (error) {
      // 解析失败不能只是"按空列表继续"：下一次 persist 会用空表把这个文件覆盖掉，
      // 不留副本就等于用户的全部定时任务凭空消失且无从恢复。这里先把损坏文件改名留存。
      const backup = `${file}.corrupt-${Date.now()}`;
      let kept = "";
      try {
        renameSync(file, backup);
        kept = `原文件已留存为 ${backup}，`;
      } catch {
        kept = "原文件留存失败（保持原样），";
      }
      safeWarn(`[dsh-helper] 定时事项数据文件解析失败，按空列表继续：${file}：${error instanceof Error ? error.message : String(error)}。${kept}修好 JSON 后可改回原名恢复。`);
    }
    // 改判的告警与落盘放在**解析的 try 之外**：上面那个 catch 会把文件当成损坏、改名成
    // `.corrupt-*` 留存 —— 万一 persist / logger（与本函数无关的环节）同步抛错，就会把一个
    // 好文件误判成坏文件。两件事不该共用一条错误路径。
    if (revisedCount > 0) {
      try {
        safeWarn(`[dsh-helper] ${revisedCount} 条定时事项绑的是旧版默认目录（宿主进程 cwd 下的 tesk），`
          + `已改判到默认工作区目录（用户目录下的「定时任务」）；原目录里的文件没有搬运，`
          + `确认不要了可以自己去删。`);
        // load 是同步的（apply 期就要拿到数据），落盘交给 persist 的串行写链，不阻塞启动。
        void persist();
      } catch (error) {
        // 改判本身已经生效（内存里的 items 是改过的），落盘失败只影响"下次启动再改一遍"。
        safeWarn(`[dsh-helper] 旧版默认目录改判结果落盘失败（下次启动会再改一次）：`
          + `${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  /** 落盘：串行 + 原子写（临时文件 + rename），失败只告警不打断内存态。 */
  function persist() {
    // migration 字段：合并成功后由 host 写入，load 时读进来、persist 时原样保留。
    // 这是"用户在面板里删任务，提示还在"的根治 —— 删任务不会碰 migration，下一次启动
    // 看到 migration.legacy === 旧文件路径就跳过迁移 + 不再显示提示。
    // ⚠️ load 里 migrationTag 是 unknown，write 时再窄化：必须是对象才落盘，否则 persist 会写入 null。
    const payloadObj = { version: 1, items: [...items.values()] };
    if (migrationTag !== undefined && typeof migrationTag === "object" && migrationTag !== null) {
      payloadObj.migration = migrationTag;
    }
    const payload = `${JSON.stringify(payloadObj, null, 2)}\n`;
    writeChain = writeChain
      .then(() => writeFileAtomic(file, payload))
      .catch((error) => {
        logger?.warn?.(`[dsh-helper] 定时事项写盘失败：${file}：${error instanceof Error ? error.message : String(error)}`);
      });
    return writeChain;
  }

  /** 停掉一个 job（幂等）。 */
  function stopJob(id) {
    const job = jobs.get(id);
    if (job === undefined) return;
    try {
      job.stop();
    } catch {
      /* 已经停掉的 job 再 stop 无所谓 */
    }
    jobs.delete(id);
  }

  /** 按当前 armed 状态与 enabled 标记给一条事项挂/摘定时器。 */
  function scheduleOne(item) {
    stopJob(item.id);
    if (!armed || item.enabled !== true) return;
    // 次数已经用满的不再挂（withRun 达标时会把 enabled 一并置 false，这里防的是老数据与竞态）。
    const used = typeof item.runCount === "number" ? item.runCount : 0;
    const limited = typeof item.maxRuns === "number" && item.maxRuns > 0;
    if (limited && used >= item.maxRuns) return;
    try {
      // `unref: true`：不让定时器把宿主进程的事件循环钉住（进程想退出就能退出）。
      // 它是 croner 的**构造选项**，不是 job 上的方法（写成 job.unref() 会静默无效）。
      const job = new Cron(item.cron, {
        unref: true,
        // 进程内的额外保险：真正保证"只跑一次"的是 withRun 落盘的 enabled:false，
        // 这里让 croner 自己在跑满剩余次数后也停下，避免多触发一次空转。
        ...(limited ? { maxRuns: item.maxRuns - used } : {}),
      }, () => {
        void runScheduled(item.id);
      });
      jobs.set(item.id, job);
    } catch (error) {
      // 表达式在写入时已校验过，这里失败只可能是运行期异常（例如 croner 版本差异）：
      // 记一条 warn 并保持该事项不调度，别让一个坏 job 拖垮整张表。
      logger?.warn?.(`[dsh-helper] 定时事项「${item.title}」调度失败（该事项不会自动触发）：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** 全量重建调度表（启动、开关切换、批量变更后调用）。 */
  function rescheduleAll() {
    for (const id of [...jobs.keys()]) stopJob(id);
    if (!armed) return;
    for (const item of items.values()) scheduleOne(item);
  }

  /**
   * 把一次运行的结果合并回内存表，返回合并后的事项（已被删除则返回 undefined）。
   *
   * 为什么不能 `items.set(id, updated)` 了事：`updated` 是 `withRun(current, …)` 用
   * **执行开始时**那份 `current` 展开出来的，而 execute 内部有真实的 await 窗口
   * （agents.create 建会话 + followup 提交提示词，实测数百毫秒）。窗口里用户完全可能
   * 删掉或改过这条事项，整体写回会造成两种静默损坏：
   *   · 删除被撤销 —— 任务复活并落盘，宿主一重启 rescheduleAll() 就重新给它挂上定时器，
   *     用户以为删掉了，它第二天照常跑；
   *   · 修改被覆盖 —— 更隐蔽的是 update() 当时已按**新** cron 重挂了定时器，而 items 被
   *     写回旧值，于是面板显示的 cron 与实际触发的 cron 不一致，要到下次重启才对齐。
   * 所以这里只取运行记录字段，以 items 里的**当前值**为基底合并。
   *
   * `enabled` 单独处理：只接受"系统停用"（跑满 maxRuns / 连续失败到阈值 → false），
   * 不接受系统启用，其余一律以当前值为准 —— 用户在执行窗口里手动启停的意图必须保住。
   */
  function mergeRunResult(id, updated) {
    const latest = items.get(id);
    if (latest === undefined) return undefined; // 执行期间被删掉了：丢弃这次结果
    const merged = { ...latest };
    for (const key of ["runs", "runCount", "failStreak", "lastRunAt", "lastRunError"]) {
      // 用 in 而不是判 undefined：withRun 成功时会 delete 掉 failStreak/lastRunError，
      // 合并侧也必须把它们从当前值里删掉，否则上一次的失败信息会一直挂着。
      if (key in updated) merged[key] = updated[key];
      else delete merged[key];
    }
    merged.enabled = updated.enabled === false ? false : latest.enabled;
    items.set(id, merged);
    return merged;
  }

  /** 定时触发的入口：跑完更新记录并落盘。 */
  async function runScheduled(id) {
    const current = items.get(id);
    if (current === undefined || !armed) return;
    if (running.has(id)) return; // 上一轮还没跑完，这一轮跳过（不排队、不叠加）
    const updated = await execute(current);
    const merged = mergeRunResult(id, updated);
    if (merged === undefined) return; // 执行期间被用户删掉了，什么都不写
    await persist();
    // 跑满次数上限后这条会由 withRun 自动停用：顺手把进程内的定时器也摘掉。
    // croner 自己的 maxRuns 已经让它不再触发，但 jobs 表里留着一条不会再响的 job
    // 会让 scheduledIds 这类诊断信息说谎（"任务在、但没排定"正是它要盯的那类失效）。
    if (merged.enabled !== true) stopJob(id);
  }

  /**
   * 执行一条事项：新建会话 + 提交提示词，把结果记进 runs。
   * 失败**不抛**（定时路径没人接异常），而是把原因写进 `lastRunError`。
   */
  async function execute(item) {
    const startedAt = new Date().toISOString();
    running.add(item.id);
    try {
      const agents = ctx.get("agents");
      if (agents === undefined || typeof agents.create !== "function") {
        throw new Error(t("schedule.agentsMissing"));
      }
      // 工作区解析：绑过 → 查 registry；查不到 / 压根还没绑 → 按 task 记的路径 mkdir + create。
      // 这是"工作区目录没了就自动新建"的实现点，**也是"任务创建时不建、执行时才建"的落点**
      // —— host 侧 resolveScheduleWorkspace 故意只记路径不建工作区，所以第一次执行时
      // workspaceId 是空的，全靠这里把它建出来。recover 内部会把 workspaceId 写回 items。
      let workspace = item.workspaceId === undefined
        ? undefined
        : ctx.get("workspaceRegistry")?.get?.(item.workspaceId);
      // 已经绑着的工作区本身是旧版默认目录（`<宿主 cwd>/tesk`）→ 就地改判：丢掉这条绑定，
      // 让下面的恢复分支按新路径把 `~/定时任务` 建出来。load 那一步已经改过一轮，这里是兜底
      // （宿主的注册表里那个坏工作区还在、或数据文件被手工改回来的情形）。
      if (workspace !== undefined && reviseWorkspacePath !== undefined) {
        const before = resolve(String(workspace.path ?? ""));
        const after = reviseWorkspacePath(before);
        if (typeof after === "string" && after.trim() !== "" && resolve(after) !== before) {
          logger?.warn?.(`[dsh-helper] 定时事项「${item.title}」绑的是旧版默认目录（${before}），已改判到 ${after}。`);
          item.workspacePath = after;
          delete item.workspaceId;
          workspace = undefined;
        }
      }
      const hasPath = typeof item.workspacePath === "string" && item.workspacePath.trim() !== "";
      // 两种情形都要走恢复：
      //   · workspaceId 有值却查不到 —— 工作区被删了；
      //   · workspaceId 为空但记着路径 —— 建任务时**故意没建**（副作用推迟到这一刻）。
      // "两个字段都没有" = 这条任务本来就不绑定工作区，保持原样走 defaultCwd，不要误建。
      if (workspace === undefined && (item.workspaceId !== undefined || hasPath)) {
        const recovered = await tryAutoRecoverWorkspace(item);
        if (recovered === null || recovered === undefined) {
          if (item.workspaceId === undefined) {
            // 路径建不出来（宿主没给能力 / 目录不可写）：任务本身还是要跑，退化成不绑定，
            // 但要说一声 —— 否则用户只会发现"会话跑到默认目录去了"而没有任何线索。
            logger?.warn?.(`[dsh-helper] 定时事项「${item.title}」的工作区目录建不出来`
              + `（${item.workspacePath}），本次按默认目录执行。`);
          } else {
            // 明确绑过却没路径可恢复（老数据迁移后没记路径）：报错让面板呈现。
            const hint = hasPath
              ? t("schedule.workspaceMissingWithPath", { id: item.workspaceId, path: item.workspacePath })
              : t("schedule.workspaceMissing", { id: item.workspaceId });
            throw new Error(hint);
          }
        } else {
          workspace = recovered;
        }
      }
      const selection = ctx.get("agentDefaultModel")?.currentSelection?.() ?? {};
      const sessionId = `session-${randomUUID()}`;
      const handle = await agents.create({
        sessionId,
        meta: { cwd: workspace ? workspace.path : defaultCwd },
        ...(typeof selection.provider === "string" && typeof selection.model === "string"
          ? { agentOptions: { provider: selection.provider, model: selection.model } }
          : {}),
        // 没有 preset 挂载的新会话**没有任何工具**（模型只能空口回答），所以这里按 web 网关
        // 建会话的同款做法解析并挂上部署的默认 preset。
        setup: async (agentCtx) => {
          const presets = ctx.get("agentPresets");
          if (!presets || typeof presets.resolve !== "function" || typeof presets.mount !== "function") return;
          const resolved = await presets.resolve(undefined);
          if (resolved && resolved.id) await presets.mount(agentCtx, resolved.id);
        },
      });
      if (workspace !== undefined && typeof workspace.attachSession === "function") {
        await workspace.attachSession(sessionId);
      }
      // 标题钉成「事项标题 · 时间」：同一事项的多次运行在侧栏里能一一区分。
      // 以 `user` 来源直接写日志，避免自动标题生成把它覆盖掉（失败不致命）。
      try {
        handle.agent.session.append("session/title", {
          title: `${item.title} · ${runStamp(startedAt)}`,
          messageSeqs: [],
          source: { kind: "user" },
        });
      } catch {
        /* 标题没钉上也照样执行 */
      }
      // 提示词**原样提交**：定时任务开的新会话与手动会话挂同一份 system prompt，里面已经写着
      // 「看到 `@专家名` 就 summon_t_expert FIRST」。这里再做一次改写只会让同一个任务在定时任务
      // 里显示成一长段模板、在手动对话里却只是 `@名字`，两条入口观感不一致（用户实测反馈）。
      const promptText = item.prompt;
      // 必须用 source.kind: "user"：DSH 聊天把非 user 的 user/message 收成左侧
      // inject/context（plugin 源只显示插件名，正文不进右侧气泡）。定时任务的指令
      // 本身就是用户写的提示词，应当像手打那条一样出现在对话右侧。
      handle.agent.followup({
        id: randomUUID(),
        role: "user",
        content: [{ type: "text", text: promptText }],
        source: { kind: "user" },
      });
      return withRun(item, { at: startedAt, ok: true, sessionId, prompt: promptText });
    } catch (error) {
      return withRun(item, {
        at: startedAt,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        // 失败也把当次的提示词记下来：否则这条记录只剩一句报错，看不出当时让它干什么。
        prompt: typeof item.prompt === "string" ? item.prompt : "",
      });
    } finally {
      running.delete(item.id);
    }
  }

  load();
  // 读盘之后必须**立刻**按当前开关挂上定时器：少了这一句，插件每次启动都是"任务在、但永远不触发"，
  // 直到用户碰一下开关或增删一条才恢复 —— 那种"看着正常、其实没在跑"的失效最难发现，所以这里
  // 也有对应自检（verify [20c] 的「重启后 enabled 的任务自动进入调度」）。
  rescheduleAll();

  /** 面板要的全部数据：事项 + 开关状态 + 可选工作区（一次调用拿全，省一次往返）。 */
  function snapshot() {
    const registry = ctx.get("workspaceRegistry") ?? ctx.get("workspace");
    const list = typeof registry?.list === "function" ? registry.list() : [];
    // 幂等性：target 顶层的 migration.legacy 标记 === 旧文件路径 → 上次已经合并过，不再显示提示。
    // 这是"用户在面板里删完任务、却还看到那条迁移提示"的根治 —— 删任务不会碰 migration 字段，
    // 但内存里 migrationNotice 是 apply 时算一次就缓存的，所以这里必须按文件状态过滤。
    const alreadyMigrated = migrationTag !== undefined
      && typeof migrationTag === "object"
      && migrationTag !== null
      && /** @type {any} */ (migrationTag).legacy === legacyPath;
    return {
      items: [...items.values()],
      armed,
      file,
      running: [...running],
      // 迁移诊断存在 + 还没标记为已迁移 → 透传给面板（stranded=需处理，merged=已自动合并顺带告知）。
      ...(alreadyMigrated || migrationNotice === undefined ? {} : { migrationNotice }),
      capabilities: {
        agents: typeof ctx.get("agents")?.create === "function",
        presets: typeof ctx.get("agentPresets")?.mount === "function",
      },
      workspaces: list.map((workspace) => ({
        id: String(workspace.id ?? ""),
        title: String(workspace.title ?? workspace.path ?? ""),
        // 目录：面板把它显示在表单里，用户能看清这条任务落在哪个文件夹。
        path: typeof workspace.path === "string" ? workspace.path : "",
      })).filter((workspace) => workspace.id !== ""),
    };
  }

  /** 新建一条事项。 */
  async function create(input) {
    if (items.size >= MAX_ITEMS) throw new Error(t("schedule.tooManyItems", { limit: MAX_ITEMS }));
    const fields = normalizeInput(input, t);
    const now = new Date().toISOString();
    const item = {
      id: `item-${randomUUID()}`,
      ...fields,
      createdAt: now,
      updatedAt: now,
      runs: [],
    };
    // normalizeInput 总会给一个 maxRuns（null = 不限次）；不限次就不该把这个键落盘。
    if (item.maxRuns === null) delete item.maxRuns;
    items.set(item.id, item);
    scheduleOne(item);
    await persist();
    return item;
  }

  /** 改一条事项（只覆盖传进来的字段）。 */
  async function update(id, patch) {
    const current = items.get(id);
    if (current === undefined) throw new Error(t("schedule.itemMissing", { id }));
    const source = patch === null || typeof patch !== "object" ? {} : patch;
    const merged = {
      title: source.title === undefined ? current.title : source.title,
      prompt: source.prompt === undefined ? current.prompt : source.prompt,
      cron: source.cron === undefined ? current.cron : source.cron,
      enabled: source.enabled === undefined ? current.enabled : source.enabled,
      workspaceId: source.workspaceId === undefined ? current.workspaceId : source.workspaceId,
      // workspacePath 与 workspaceId 一同从表单过来；老数据没有也不补（创建时记的是绑定那一刻的目录）。
      workspacePath: source.workspacePath === undefined ? current.workspacePath : source.workspacePath,
      // ⚠️ maxRuns 必须像其它字段一样"没传就保持原值"。少了这一行，normalizeInput 会读到
      // undefined 并返回 null，紧接着下面那句 `delete next.maxRuns` 就把上限抹掉了 ——
      // 后果是**改个 cron 就能把一次性任务变回「每年跑」**（这个字段刚加时踩过）。
      maxRuns: source.maxRuns === undefined ? current.maxRuns : source.maxRuns,
    };
    const fields = normalizeInput(merged, t);
    const next = { ...current, ...fields, updatedAt: new Date().toISOString() };
    // 展开旧记录会把旧的 workspaceId 一起带过来：用户把绑定改回「不绑定」时
    // fields 里没有这个键，必须显式删掉，否则界面上看着解绑了、执行时还挂在旧工作区。
    if (fields.workspaceId === undefined) delete next.workspaceId;
    if (fields.workspacePath === undefined) delete next.workspacePath;
    // 同理：maxRuns 显式传 0 / null 表示"改回不限次"，要把旧上限删掉（不删就永远改不回来）。
    if (fields.maxRuns === null) delete next.maxRuns;
    items.set(id, next);
    scheduleOne(next);
    await persist();
    return next;
  }

  /** 删一条事项（顺带摘掉它的定时器）。 */
  async function remove(id) {
    if (!items.has(id)) throw new Error(t("schedule.itemMissing", { id }));
    stopJob(id);
    items.delete(id);
    await persist();
    return { removed: true };
  }

  /** 立即执行一条事项（面板上的「立即执行」）。 */
  async function runNow(id) {
    if (!armed) throw new Error(t("schedule.disabled"));
    const current = items.get(id);
    if (current === undefined) throw new Error(t("schedule.itemMissing", { id }));
    if (running.has(id)) return current; // 正在跑就原样返回，面板保持「执行中…」
    const updated = await execute(current);
    const merged = mergeRunResult(id, updated);
    // 执行窗口里被别的窗口删掉了：报与开头同一个错，让面板去刷新，
    // 而不是把一份已经不存在的事项快照当成成功结果返回。
    if (merged === undefined) throw new Error(t("schedule.itemMissing", { id }));
    await persist();
    // 与 runScheduled 同理：手动执行也可能把次数用满，达标即摘掉定时器。
    if (merged.enabled !== true) stopJob(id);
    return merged;
  }

  /**
   * 开关联动：关掉 = 停止全部定时触发并拒绝手动执行；打开 = 按 stored enabled 全量重建。
   * 只改运行态，不写数据文件（开关本身是界面偏好，存在宿主设置里）。
   */
  function setArmed(next) {
    const value = next !== false;
    if (value === armed) return { armed };
    armed = value;
    rescheduleAll();
    return { armed };
  }

  /**
   * 自动恢复：执行路径发现工作区不见了，但任务里记着目录 → 顺着把工作区建回来。
   * 这是用户口径"工作区目录没了就自动新建"的实现点：
   *   - execute 拿到 registry.get 拿不到的 workspace 时，先看 item.workspacePath：
   *     · 路径已记录：按这个路径 ensureWorkspace（**会顺带 mkdir 目录**，宿主 createCanonical 内部对同路径幂等复用）。
   *     · 没路径：只能抛错让用户去左侧手动建一次工作区（之后 schedule.json 里的 workspaceId 会被自动建回。
   *       老数据迁移后第一次失败就属于这种情况）。
   *   - 恢复成功后顺便把 workspaceId 刷回去（**mutate 传入的 item + items.set 同步**：
   *     execute 自身就是单飞序列，传入的 item 是 Map 里的那条引用；mutate 后 withRun 能
   *     拿到最新字段，items.set + persist 保证落盘，调度下次直接命中 registry）。
   *
   * @returns 恢复出来的 workspace（已经是 registry 里的实体）；返回 null 表示不可恢复。
   */
  async function tryAutoRecoverWorkspace(item) {
    const finalPath = resolveRebuildPath(item, undefined);
    if (finalPath === "") return null;
    try {
      const workspace = await ensureOrFail(finalPath);
      // 1) mutate 传入的 item：execute 后面的 withRun(item, ...) 直接看到新 workspaceId/Path。
      item.workspaceId = workspace.id;
      item.workspacePath = workspace.path;
      item.updatedAt = new Date().toISOString();
      delete item.lastRunError;
      // 2) items.set 触发 Map 引用更新（与 mutate 实际指向同一对象，但保持语义一致）；
      //    persist 把这条新字段落到磁盘。
      items.set(item.id, item);
      await persist();
      logger?.info?.(`[dsh-helper] 定时事项「${item.title}」绑定的工作区不存在，已按原路径 ${finalPath} 自动重建（id=${workspace.id}）。`);
      return workspace;
    } catch (error) {
      logger?.warn?.(`[dsh-helper] 定时事项「${item.title}」自动恢复工作区失败：${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  /** 抽取"用哪条 path"的判定：外部传入优先，否则用 task 记的。两边都没有就返回空串。 */
  function resolveRebuildPath(item, override) {
    if (typeof override === "string" && override.trim() !== "") return override.trim();
    const raw = typeof item?.workspacePath === "string" ? item.workspacePath.trim() : "";
    if (raw === "") return "";
    // 同一条改判规则（见 options.reviseWorkspacePath）：这里再兜一次 —— 数据文件是用户可编辑的，
    // "改了文件但宿主没重启"那种情形只有这条路径能救。
    const revised = reviseWorkspacePath === undefined ? raw : reviseWorkspacePath(raw);
    return typeof revised === "string" && revised.trim() !== "" ? revised.trim() : raw;
  }

  /**
   * 调宿主的工作区准备能力拿实体。宿主若未注入（理论上不会发生，scheduleEngine 必然随插件注入）
   * 就在这里抛错，调用方自己决定是抛还是降级。
   */
  function ensureOrFail(path) {
    if (ensureWorkspace === undefined) {
      return Promise.reject(new Error("宿主没有提供工作区准备能力（ensureWorkspace）。"));
    }
    return ensureWorkspace(path, undefined);
  }

  /** 卸载：停掉全部定时器（数据留着，下次启动重建）。 */
  function dispose() {
    for (const id of [...jobs.keys()]) stopJob(id);
  }

  return {
    file,
    snapshot,
    list: () => [...items.values()],
    create,
    update,
    remove,
    runNow,
    preview: (cron) => ({ fires: previewRuns(cron, t) }),
    /**
     * 给面板用：确保定时任务的默认工作区（或自定义目录）存在，返回精简 { id, title, path }。
     *
     * 注意：这里不直接转发 host 注入的 ensureWorkspace，因为后者现在透的是完整 entity
     * （含 attachSession 等方法引用），不能塞进 remote 的 zod 严格 schema；面板用不上那些方法，
     * 拿 id/title/path 就够了。
     */
    ensureWorkspace: async (path, title) => {
      if (ensureWorkspace === undefined) {
        throw new Error("宿主没有提供工作区准备能力（ensureWorkspace）。");
      }
      const entity = await ensureWorkspace(path, title);
      return { id: String(entity.id), title: String(entity.title ?? ""), path: String(entity.path ?? "") };
    },
    /**
     * **只读**解析"将来会绑哪个工作区"：不 mkdir、不在注册表里建条目。
     *
     * 面板的"新建任务"表单用它取默认值 —— 打开表单、甚至填完又取消，都不该留下工作区；
     * 建的动作推迟到任务第一次执行（tryAutoRecoverWorkspace）。返回的 workspaceId 可能缺省，
     * 那表示"工作区还不存在，执行时按 workspacePath 建"。
     */
    resolveWorkspace: (path) => {
      if (resolveWorkspaceOption === undefined) {
        throw new Error("宿主没有提供工作区解析能力（resolveWorkspace）。");
      }
      return resolveWorkspaceOption(path);
    },
    setArmed,
    isArmed: () => armed,
    /** 当前真正挂着定时器的事项 id（自检与诊断用：能看出"任务在、但没排定"这种失效）。 */
    scheduledIds: () => [...jobs.keys()],
    dispose,
    /** 开关变化后重建调度（settings 回调里用）。 */
    rescheduleAll,
  };
}
