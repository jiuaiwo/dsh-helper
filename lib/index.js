/**
 * dsh-helper —— 在任意 DSH 会话里把文件主动投递到 IM（微信）。
 *
 * 设计原则：**不修改 dsh-im 的源码**。
 *
 * dsh-im 对外的服务面 ctx.dshIm 只有 send / listTargets / listBots，既没有文件投递
 * 入口，也没有扩展点。所以本插件不指望它导出新能力，而是自己完成编排：
 *   1. 用 DSH 公共的 credentials 服务取微信机器人 token；
 *   2. 复用 dsh-im 已经写好的微信协议实现（weixin-api / state-store / config-store）；
 *   3. 自己串起「读文件 → 上传 → 发送」。
 *
 * 这样 dsh-im 可以照常升级：它的源码零改动，协议层修好了我们自动受益；万一它的
 * 内部模块路径或导出名变了，本插件会明确报错（见 loadWeixinModules 的提示），
 * 而不是静默失效。
 *
 * 为什么不从零复刻协议：weixin-api.mjs 有 948 行、weixin-bridge.mjs 有 1544 行，
 * 里面涉及 getuploadurl、AES-ECB 填充、CDN 上传、消息体构造。复刻一份等于给自己
 * 埋一个会跟着上游腐烂、而且烂得静默的副本。这里只做编排，协议一律复用上游。
 */
import { timingSafeEqual } from 'node:crypto';
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  currentProfileDir,
  deliverViaImConnect,
  resolveImConnectDir,
} from '../src/host/im-connect.js';
// 图片魔数嗅探与扩展名兜底集合抽到了 image-sniff.js：im-connect 后端也要用同一份
// 「验货」能力（发送前按内容纠正文件名后缀），放在本文件会形成循环依赖。
import { IMAGE_EXTENSIONS, sniffImageKind } from '../src/host/image-sniff.js';
import {
  detectedDebugger,
  detectedSupervisor,
  scheduleRestart,
  servingPort,
} from '../src/host/restart.js';
import { trustedLocalRequest, trustedRestartRequest } from '../src/host/http-trust.js';
import HelperPatchScheduleRemote from './schedule-remote.js';
import {
  MAX_PROMPT_CHARS,
  MAX_TITLE_CHARS,
  SCHEDULE_FILE_NAME,
  SCHEDULE_SERVICE,
  createScheduleEngine,
  // 配置文件与定时任务数据共用同一套原子写：两处都要求"崩了也不留半个 JSON"。
  writeFileAtomic,
} from './schedule.js';
import { t as scheduleText } from './schedule-copy.js';

export const name = 'dsh-helper';

const TOOL_NAME = 'send_file_to_im';

/** 设置面板读写开关用的 HTTP 路由（与 DSH Web 同源）。 */
const CONFIG_HTTP_PATH = '/api/dsh-helper/config';
/**
 * 投递用的 HTTP 路由。
 *
 * 工具（send_file_to_im）只对"建立时就加载了本插件"的会话可见；已经在跑的会话
 * 拿不到它。给一条同源 HTTP 路由，任何会话都能直接投递，不依赖工具表。
 */
const SEND_HTTP_PATH = '/api/dsh-helper/send-file';
const RESTART_HTTP_PATH = '/api/dsh-helper/restart';
const RESTART_STATUS_HTTP_PATH = '/api/dsh-helper/restart/status';
const MAX_BODY_BYTES = 64 * 1024;

/**
 * 投递文件的本地大小上限（200 MiB）。
 *
 * 上游 dsh-im 不预先限大小——超限要到 CDN 上传/prepare 阶段才以 413 回来
 * （artifact-too-large），那之前整个文件已经全量读进宿主内存了。这里在读取前
 * 先 stat 一道：超限直接拒，宿主进程不陪跑一次注定失败的上传。
 * 上限取 200 MiB 是刻意宽松的个人微信文件上限口径——真正能发多大的最终以
 * 上游回执为准，这里只拦"显然发不出去还会撑爆内存"的。
 */
const MAX_FILE_BYTES = 200 * 1024 * 1024;

/**
 * HTTP 投递的硬超时（5 分钟）。
 *
 * 取这么宽是因为上限就是 200 MiB、还要过一次微信 CDN 上传；但它必须是有限值 ——
 * 上游卡住而没有超时的话，这个响应会无限悬挂，连接一直占着，调用方（脚本/别的会话）
 * 也跟着挂死，而且从外部看不出是"还在传"还是"已经死了"。
 */
const SEND_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * 路径白名单的条目上限。
 *
 * 只是防手滑/防滥用（比如把整个 `/` 填进来一百遍），不是安全边界 ——
 * 真正的边界是"每一条都必须是用户自己填的目录"。取 20 是够用又不至于让设置页失控。
 */
const MAX_ALLOW_ROOTS = 20;

/**
 * deliverFile 的返回结构，同时也是工具 output.schema 的唯一来源。
 *
 * 必须与 deliverFile 的 return 保持一致：schema 声明了 additionalProperties: false，
 * 返回对象里多出一个没声明的键，DSH 就会以 "returned invalid output" 拒绝整个调用 ——
 * 哪怕文件其实已经发出去了。（0.1.2 修的就是这个：返回里多了 toUserId / botId / hadContextToken。）
 */
const DELIVERY_RESULT_SCHEMA = {
  sent: 'boolean',
  fileName: 'string',
  bytes: 'number',
  toUserId: 'string',
  botId: 'string',
  hadContextToken: 'boolean',
  via: 'string',
};

/**
 * via → 回执里的中文说法。
 *
 * 两个后端的取值集合不同：dsh-im 只分 image / file（由我们嗅魔数决定），
 * im-connect 的通道还会把视频单独走一路（按文件名后缀决定），所以这里是三档。
 */
const DELIVERY_VIA_TEXT = { image: '图片消息', video: '视频消息', file: '文件' };

function json(response, status, value) {
  if (response.destroyed || response.writableEnded) return;
  const body = JSON.stringify(value);
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(body)),
  });
  response.end(body);
}

async function readJsonBody(request) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.length;
    if (length > MAX_BODY_BYTES) throw new Error('payload-too-large');
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks, length).toString('utf8') || '{}');
}

function dshHome() {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh');
}

// ---------------------------------------------------------------- 运行时数据目录与改名迁移

/** 本插件的运行时数据目录名：`$DSH_HOME/integrations/<这个名字>/`。 */
const DATA_DIR_NAME = 'dsh-helper';
/** 改名前的目录名（2026-10-06 起包名由 dsh-helper-patch 改为 dsh-helper）。 */
const LEGACY_DATA_DIR_NAME = 'dsh-helper-patch';

/**
 * 把运行时数据从**旧包名目录**搬到新包名目录（2026-10-06 改名：dsh-helper-patch → dsh-helper）。
 *
 * 数据是按包名落盘的（`$DSH_HOME/integrations/<包名>/`），改名等于换门牌号 —— 少了这一步，
 * 老用户升级后配置与定时任务会「凭空消失」，而文件其实还躺在旧目录里。上个名字 dsh-imsend
 * 就是这么遗留至今的：`~/.dsh/integrations/dsh-imsend/` 至今还占着地方，没人清理。
 *
 * 规则与 migrateScheduleFile 一致：**目标已存在就什么都不做**（迁过了，或本来就是全新安装）。
 * 搬运优先用 rename（同一文件系统上是原子的）；跨设备（EXDEV）或权限不允许时退回复制 + 删源。
 * 任何异常都吞掉、只记一条 warn —— 迁移失败不该让插件起不来。
 */
export function ensureDataDirMigrated(logger) {
  const base = join(dshHome(), 'integrations');
  const from = join(base, LEGACY_DATA_DIR_NAME);
  const to = join(base, DATA_DIR_NAME);
  try {
    if (existsSync(to) || !existsSync(from)) return;
    try {
      renameSync(from, to);
    } catch {
      cpSync(from, to, { recursive: true });
      rmSync(from, { recursive: true, force: true });
    }
    logger?.info?.(`[dsh-helper] 运行时数据已迁移：integrations/${LEGACY_DATA_DIR_NAME}/ → integrations/${DATA_DIR_NAME}/`);
  } catch (error) {
    logger?.warn?.(`[dsh-helper] 旧数据目录迁移失败（将从新目录重新开始，旧文件仍在 ${from}）：${error?.message ?? error}`);
  }
}

/** 本插件的配置文件位置：$DSH_HOME/integrations/dsh-helper/config.json */
function configFile() {
  return join(dshHome(), 'integrations', DATA_DIR_NAME, 'config.json');
}

/** 旧后端（dsh-im）的微信集成数据目录（配置与账号状态都在这）。 */
function weixinDir() {
  return join(dshHome(), 'integrations', 'dsh-weixin');
}

// ---------------------------------------------------------------- 定时任务

/**
 * 数据迁移闸门。
 *
 * 定时任务原先住在 dsh-expert，数据在 `~/.t-team/schedule.json`。迁移期间两个插件
 * 都会按自己的数据文件调度，一旦复制过来同一条任务会被两边各触发一次 —— 所以闸门在
 * 「T专家 那边还在调度」时必须保持 false。
 *
 * 2026-09-25：T专家 已彻底移除该功能（commit 24400ac），闸门打开。
 * 迁移只在**目标文件不存在**时发生，所以这是一次性的：之后重启不会再覆盖本插件的数据。
 */
const SCHEDULE_MIGRATION_ENABLED = true;

/** 定时任务的数据文件：$DSH_HOME/integrations/dsh-helper/schedule.json */
export function scheduleFile() {
  return join(dshHome(), 'integrations', DATA_DIR_NAME, SCHEDULE_FILE_NAME);
}

/** 数一个 schedule.json 里的任务条数（读不动 / 不是那个形状一律按 0，诊断不该把启动搞崩）。 */
function countScheduleItems(file) {
  try {
    const items = JSON.parse(readFileSync(file, 'utf8'))?.items;
    return Array.isArray(items) ? items.length : 0;
  } catch {
    return 0;
  }
}

/**
 * 读 target 顶层的 migration 字段（合并后我们会在那里写 `legacy` + `at`，用作"已迁移过"标记）。
 * 文件不存在 / 解析失败 / 形状不对一律按"未迁移"处理 —— 容错优先，绝不让一个坏标记阻塞启动。
 */
function readMigrationTag(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    if (parsed === null || typeof parsed !== 'object') return null;
    const tag = parsed.migration;
    if (tag === null || typeof tag !== 'object') return null;
    return tag;
  } catch {
    return null;
  }
}

/**
 * 在 target 顶层写 migration 标记（合并成功后调用）。
 *
 * 这个标记是**幂等性的关键**：下次启动看到 `migration.legacy === 当前旧文件路径` 就跳过迁移，
 * 不会再触发一次合并 + 不再报 `merged` 诊断。这是"用户在面板里删掉那 2 条任务后，提示还在"的根治：
 * 删完之后用户对那条提示的期待是"它应该消失"，而合并是写入 target 顶层字段，不删文件、不动 items，
 * 每次 persist 也会原样保留 —— 启动后立刻看到标记、不再打扰。
 *
 * 直接 readFileSync/writeFileSync 而不是迁移函数用的原子写（写临时文件再 rename）：
 * 这个函数只在 host 启动期调一次（合并成功的副作用），失败就当没标记，下次启动会重试，
 * 不会留下半截数据；这里偷一点简洁。
 */
function writeMigrationTag(file, legacy) {
  let body;
  try {
    body = JSON.parse(readFileSync(file, 'utf8'));
    if (body === null || typeof body !== 'object') body = {};
  } catch {
    body = {};
  }
  body.migration = { legacy, at: new Date().toISOString() };
  writeFileSync(file, `${JSON.stringify(body, null, 2)}\n`);
}

/**
 * 一次性数据迁移：定时任务原先住在 dsh-expert（数据在 `~/.t-team/schedule.json`）。
 *
 * 迁到本插件后数据根变了，但**用户已经建好的任务不能丢**：目标文件还不存在、旧文件又在时，
 * 复制一份过来。**只复制、不删除** —— 旧文件留在原地当备份，想退回旧版本也还有数据。
 * 迁移失败只记日志、不阻断启动（最坏是空列表，用户能看见、能重建）。
 *
 * 「目标已存在就跳过」这条分支原先是**静默 return**，这是最难查的一种失效：
 * 如果本插件在迁移闸门打开之前先启动过一次（那次启动会把一张空表写进目标文件），
 * 之后旧文件里的任务就永远迁不过来 —— 面板是空的、任务不再触发，而任何地方都不说一句话。
 *
 * 修这一道：**目标文件存在但为空** = 插件只写过一次空表、还没有任何用户数据，可以安全地把旧文件
 * 的内容复制进来（= 合并到目标文件）。这种情况现在自动合并，回一条 `merged` 诊断让面板告诉用户
 * 「已帮你迁了 N 条」。**目标文件已有任务** 时保持不覆盖 —— 用户已经在新数据根里建过东西，
 * 旧任务必须由用户亲自决定（stranded 诊断 + 日志 + 两条恢复办法，跟之前一样）。
 *
 * **幂等性**（0.15.0 加）：合并成功后给 target 顶层写一个 `migration.legacy` 字段，下次启动看到
 * 这个标记就跳过整段逻辑 —— 不再二次合并、不再二次报提示。这是"用户在面板里删了任务，提示还在"
 * 的根治：删完之后 target 仍有 `migration.legacy`，所以**不会**再合并一次（也就不会再报 merged 提示）。
 *
 * @param target - 本插件的数据文件路径。
 * @param logger - 宿主 logger（可选）。
 * @returns {{
 *   stranded?: { legacy: string, target: string, count: number },
 *   merged?: { legacy: string, target: string, count: number },
 * }}
 *   迁移诊断。`merged` = 旧文件已自动合并到空目标；`stranded` = 旧文件仍有任务且目标非空，
 *   没法自动覆盖，需用户处理。两者都不会同时出现。
 */
export function migrateScheduleFile(target, logger) {
  const legacy = process.env.DSH_HELPER_PATCH_SCHEDULE_LEGACY ?? join(homedir(), '.t-team', SCHEDULE_FILE_NAME);
  if (!existsSync(legacy)) return {};
  if (existsSync(target)) {
    // 幂等性检查：target 顶层 migration.legacy === 当前旧文件路径 → 上次已经合并过，不再做任何事。
    const tag = readMigrationTag(target);
    if (tag !== null && typeof tag.legacy === 'string' && tag.legacy === legacy) return {};
    const legacyCount = countScheduleItems(legacy);
    if (legacyCount === 0) return {};
    const targetCount = countScheduleItems(target);
    if (targetCount === 0) {
      // 目标存在但是空的：典型场景是插件首次启动创建了空表，旧任务没迁过来。
      // 这种情况下没有用户数据可破坏，把旧文件内容复制进去即可 —— 同时回 merged 诊断让面板知会用户。
      try {
        mkdirSync(dirname(target), { recursive: true });
        copyFileSync(legacy, target);
        // 写迁移标记（幂等性的依据）：下次启动看到这个就跳过，不会再次合并。
        writeMigrationTag(target, legacy);
        logger?.info?.(`[dsh-helper] 定时任务数据已合并（目标文件原本是空的）：`
          + `${legacy} → ${target}（${legacyCount} 条；旧文件保留作备份）`);
        return { merged: { legacy, target, count: legacyCount } };
      } catch (error) {
        const stranded = { legacy, target, count: legacyCount };
        logger?.warn?.(`[dsh-helper] 旧定时任务文件 ${legacy} 合并到 ${target} 失败，`
          + `仍按 stranded 处理（${legacyCount} 条任务未自动迁过来）：`
          + `${error instanceof Error ? error.message : String(error)}`);
        return { stranded };
      }
    }
    // 目标非空 = 用户已经在新数据根里建过任务：绝不能动，否则后续编辑会被覆盖。
    const stranded = { legacy, target, count: legacyCount };
    logger?.warn?.(`[dsh-helper] 旧定时任务文件 ${legacy} 里还有 ${legacyCount} 条任务，`
      + `而 ${target} 不是空的 —— 迁移不会覆盖用户当前数据，所以它们没有被复制过来，也不会被调度。`
      + `恢复办法：在面板里照旧文件重建，或关掉定时任务总开关、把 ${target} 移走后重启宿主让它自动合并。`);
    return { stranded };
  }
  // 目标不存在（首次安装本插件）→ 复制 + 写迁移标记。
  try {
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(legacy, target);
    writeMigrationTag(target, legacy);
    logger?.info?.(`[dsh-helper] 定时任务数据已迁移：${legacy} → ${target}（旧文件保留作备份）`);
  } catch (error) {
    logger?.warn?.(`[dsh-helper] 定时任务数据迁移失败（按空列表启动）：${error instanceof Error ? error.message : String(error)}`);
  }
  return {};
}

/** 定时任务默认绑定的工作区：标题固定「定时任务」，目录固定**用户目录**下的「定时任务」。 */
const SCHEDULE_WORKSPACE_TITLE = '定时任务';

/**
 * 旧版默认目录的目录名（`<宿主进程 cwd>/tesk`，`task` 的错拼）。
 * 这个值只可能由本插件生成（0.15.11 及以前），所以按名字就能认出历史遗留。
 */
const LEGACY_DEFAULT_DIR_NAME = 'tesk';

/**
 * 定时任务默认的工作区目录：**用户目录**下的「定时任务」。
 *
 * 历史（2026-09-29 修）：这里原先是 `join(process.cwd(), 'tesk')`，而宿主进程的 cwd 与
 * 「用户目录」毫无关系 —— 桌面端 App 从 Finder 启动时 cwd 是 `/`，命令行从哪个目录起来就是
 * 哪个目录。于是同一句"默认目录"在不同机器上解析成 `/tesk`、`/usr/local/bin/tesk`、`~/tesk`。
 * 旧机器之所以看着正常，是因为侧栏里已经有一个标题「定时任务」的工作区（path=~/定时任务），
 * `findScheduleWorkspace` 直接复用了它 —— cwd 那条分支从来没被执行过，直到换新电脑才暴露。
 */
export function scheduleDefaultDir() {
  return join(homedir(), SCHEDULE_WORKSPACE_TITLE);
}

/**
 * 归一化"这条任务该用哪个目录"：
 *   · 先展开开头的 `~`。设置页写着「可用 ~ 表示家目录」，host 就必须真认它 ——
 *     否则 `resolve("~/定时任务")` 会得到 `<cwd>/~/定时任务`，`mkdir -p` 真会建出一个
 *     名叫 `~` 的目录（同一个坑在投递白名单那边踩过，见 expandTilde 的注释）。
 *   · 相对路径以**家目录**为基准，不再以宿主进程的 cwd 为基准（同一条理由：cwd 不稳定）。
 */
export function normalizeScheduleDir(value) {
  const expanded = expandTilde(String(value).trim());
  return isAbsolute(expanded) ? resolve(expanded) : resolve(homedir(), expanded);
}

/** 路径是否指向旧版默认目录（`<任意目录>/tesk`）—— 只按目录名判定，因为这是本插件独有的错拼。 */
function isLegacyDefaultDir(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (text === '') return false;
  return basename(resolve(expandTilde(text))) === LEGACY_DEFAULT_DIR_NAME;
}

/**
 * 把一条记着的工作区目录改判成"现在该用的目录"（host 与调度引擎共用同一条规则）：
 *   · 旧默认目录 `…/tesk` → 当前默认目录 `~/定时任务`（**不搬运**旧目录里的文件，也不删它：
 *     只换绑定，之前跑出来的东西原地不动，用户想留就留）；
 *   · 其余照常归一化。
 * 返回空串 = 调用方按"未指定"处理。
 */
export function reviseScheduleDir(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (text === '') return '';
  if (isLegacyDefaultDir(text)) return scheduleDefaultDir();
  return normalizeScheduleDir(text);
}

/**
 * 在宿主的工作区注册表里找"定时任务的默认工作区"：**先按目录，再按标题**。
 *
 * 先按目录是为了接住改判：旧机器上那个标题「定时任务」、路径却是 `…/tesk` 的工作区还在注册表
 * 里，只按标题找会把它翻出来复用 —— 改判就白做了。按路径找不到才退回按标题找，并且**丢掉**
 * 路径是旧默认目录的那些（它们是坏的，不能复用，否则侧栏里会冒出两个同名「定时任务」）。
 *
 * 找不到 / 宿主没提供 list 就返回 undefined。
 */
function findScheduleWorkspace(registry) {
  if (typeof registry?.list !== 'function') return undefined;
  const target = resolve(scheduleDefaultDir());
  try {
    const list = registry.list();
    const byPath = list.find((entity) => typeof entity?.path === 'string' && entity.path !== ''
      && resolve(entity.path) === target);
    if (byPath !== undefined) return byPath;
    return list.find((entity) => entity?.title === SCHEDULE_WORKSPACE_TITLE && !isLegacyDefaultDir(entity?.path));
  } catch {
    // list 不可用（宿主版本差异）不致命：退回"按路径 create"，最多是没享受到复用。
    return undefined;
  }
}

/**
 * 确保一个工作区存在并返回其实体（定时任务的执行路径要用 entity.attachSession 把新会话挂回工作区）。
 *
 * 顺序：目录不存在先 mkdir（宿主的工作区 create **只接受已存在的目录**）→ registry.create
 * （它内部对同路径是幂等复用）。默认工作区这条路径上先按目录、再按标题找一遍（见
 * findScheduleWorkspace）：只要默认目录变过一次，就会各自建出一个同名「定时任务」，
 * 侧栏里出现两个同名工作区 —— 按目录/标题复用把"共用一个"变成硬保证。
 *
 * @param ctx - 宿主上下文（用来取 workspaceRegistry）。
 * @param path - 自定义目录（空 = 用默认目录 `~/定时任务`；旧版默认目录 `…/tesk` 也按空处理）。
 * @param title - 工作区标题（空 = 默认标题 / 自定义目录取目录名）。
 */
async function ensureScheduleWorkspace(ctx, path, title) {
  const registry = ctx.get('workspaceRegistry') ?? ctx.get('workspace');
  if (registry === undefined || typeof registry.create !== 'function') {
    throw new Error(scheduleText('schedule.workspaceMissing', { id: 'workspaceRegistry' }));
  }
  // 旧默认目录（`<cwd>/tesk`）不算"用户指定"：它只可能是插件的遗留产物，按未指定处理。
  const custom = typeof path === 'string' && path.trim() !== '' && !isLegacyDefaultDir(path);
  if (!custom) {
    const existing = findScheduleWorkspace(registry);
    if (existing !== undefined) return existing;
  }
  const raw = custom ? normalizeScheduleDir(path) : scheduleDefaultDir();
  const target = resolve(raw);
  await mkdir(target, { recursive: true });
  const label = title !== undefined && title !== ''
    ? title
    : (custom ? basename(target) : SCHEDULE_WORKSPACE_TITLE);
  return registry.create(target, label);
}

/**
 * 解析任务该绑哪个工作区 —— **只读**：不 mkdir、不在注册表里建任何东西。
 *
 * 为什么把"建"推迟到执行时（用户 2026-09-28 口径：「为什么任务还没执行，都已经把工作区建立了？
 * 他执行的时候应该会自动建立工作区」）：
 *   · 建任务时就建 = 用户还没让它跑过第一次，磁盘上先多一个空目录、侧栏里先多一个工作区；
 *     而这条任务可能永远不执行（建完忘了、cron 排在很久以后、建错了随手删掉）。
 *   · 引擎本来就有"执行时按 workspacePath 把工作区建回来"的能力（schedule.js 的
 *     tryAutoRecoverWorkspace），所以推迟不会丢功能 —— 只是把副作用挪到真正需要的那一刻。
 *
 * 三个分支：
 *   · 显式给了目录 → 只记路径（执行时按它建）；
 *   · 默认、且已经有同名「定时任务」工作区 → 直接复用（这一步是只读查询）；
 *   · 默认、但还没有 → 只记下将来要用的路径，不建。
 *
 * ⚠️ 返回的对象里 workspaceId 可能缺失，那是**有意的**：执行路径据此判断"该建工作区"，
 * 见 schedule.js 里 wantsWorkspace 那段。
 *
 * @param ctx - host 上下文（用来只读地取 workspaceRegistry）。
 * @param explicitPath - 用户/模型显式指定的目录；空 = 用默认「定时任务」工作区。
 * @returns {{ workspaceId?: string, workspacePath?: string }}
 */
function resolveScheduleWorkspace(ctx, explicitPath) {
  const raw = typeof explicitPath === 'string' ? explicitPath.trim() : '';
  // 旧默认目录（`<cwd>/tesk`）不算"用户指定"：按未指定处理，回到默认工作区分支 ——
  // 于是它会被改判到 `~/定时任务`（存在就复用、不存在就记下路径等执行时建）。
  const custom = raw !== '' && !isLegacyDefaultDir(raw);
  if (custom) return { workspacePath: normalizeScheduleDir(raw) };
  const registry = ctx.get('workspaceRegistry') ?? ctx.get('workspace');
  const existing = registry === undefined ? undefined : findScheduleWorkspace(registry);
  if (existing !== undefined) {
    return { workspaceId: String(existing.id), workspacePath: String(existing.path) };
  }
  // 还没有默认工作区：只记路径。真正的 mkdir + create 交给执行时（tryAutoRecoverWorkspace）。
  return { workspacePath: scheduleDefaultDir() };
}

async function readConfig() {
  try {
    const value = JSON.parse(await readFile(configFile(), 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch (error) {
    if (error?.code === 'ENOENT') return {};
    throw error;
  }
}

async function saveConfig(patch) {
  const file = configFile();
  const next = { ...(await readConfig()), ...patch };
  // 原子写（与 schedule.json 同一套实现）：直接 writeFile 的话，写一半崩溃会留下半个 JSON，
  // readConfig 解析失败后 catch 回默认值 —— 表现是"用户的设置无声丢失"，而且查不出原因。
  await writeFileAtomic(file, `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

/** 首次加载时补上默认开关，之后一切以配置文件为准。 */
async function ensureConfig() {
  const current = await readConfig();
  const patch = {};
  if (typeof current.enabled !== 'boolean') patch.enabled = true;
  if (typeof current.imageAsPicture !== 'boolean') patch.imageAsPicture = true;
  if (typeof current.restartEnabled !== 'boolean') patch.restartEnabled = true;
  if (typeof current.scheduleEnabled !== 'boolean') patch.scheduleEnabled = true;
  if (Object.keys(patch).length === 0) return current;
  return saveConfig(patch);
}

/**
 * 同步读「定时任务总开关」，给 apply 建引擎时用。
 *
 * apply 是同步阶段（宿主与冒烟都不保证 await 它），读不了异步 config——和调度引擎
 * 自己 load() 读 schedule.json 一个风格：同步读、读不动按默认（开）继续。
 */
function readInitialArmed() {
  try {
    const value = JSON.parse(readFileSync(configFile(), 'utf8'));
    return value?.scheduleEnabled !== false;
  } catch {
    return true;
  }
}

/**
 * GET 读开关，POST 写开关。只碰这几个字段，不动配置文件里的其他字段。
 *
 * `engine` 参数是调度引擎（可缺省，只用于开关变化时对齐运行态）：
 * scheduleEnabled 改了就立即 setArmed，不必等下次重启。
 * `toolGate` 用于同步那 4 个定时任务工具的可见性（可缺省）——关掉功能后模型不该再看到它们，
 * 也就不会去建任务，更不会在「用哪种定时任务」上弹窗让用户选一个已经下线的选项。
 */
async function handleConfigRequest(request, response, engine, toolGate) {
  // 同 /send-file：挡掉跨站 Origin 的 POST（篡改默认收件人/关掉功能），
  // 无 Origin 的本机脚本放行。
  if (!trustedLocalRequest(request)) {
    json(response, 403, { error: 'untrusted-origin' });
    return;
  }
  try {
    if (request.method === 'GET') {
      const settings = await ensureConfig();
      json(response, 200, {
        enabled: settings.enabled !== false,
        imageAsPicture: settings.imageAsPicture !== false,
        restartEnabled: settings.restartEnabled !== false,
        scheduleEnabled: settings.scheduleEnabled !== false,
        botId: typeof settings.botId === 'string' ? settings.botId : '',
        toUserId: typeof settings.toUserId === 'string' ? settings.toUserId : '',
        // 口令**不回明文**：这个 GET 与 /send-file 一样属于"无 Origin 的本机请求也放行"的路由，
        // 回明文等于任何同机进程都能读到口令 —— 那这道闸门就形同虚设。
        // 设置页只需要知道"设没设"；改口令走 POST（留空 = 不修改，见下）。
        sendTokenSet: typeof settings.sendToken === 'string' && settings.sendToken !== '',
        sendAllowRoots: Array.isArray(settings.sendAllowRoots) ? settings.sendAllowRoots : [],
        // 只读的探测结果：面板据此说明"现在走哪个后端"（空串 = 两个 IM 插件都没找到）。
        backend: detectDeliveryBackend(settings),
      });
      return;
    }
    if (request.method === 'POST') {
      const payload = await readJsonBody(request);
      const patch = {};
      if (typeof payload?.enabled === 'boolean') patch.enabled = payload.enabled;
      if (typeof payload?.imageAsPicture === 'boolean') patch.imageAsPicture = payload.imageAsPicture;
      if (typeof payload?.restartEnabled === 'boolean') patch.restartEnabled = payload.restartEnabled;
      if (typeof payload?.scheduleEnabled === 'boolean') patch.scheduleEnabled = payload.scheduleEnabled;
      if (typeof payload?.botId === 'string') patch.botId = payload.botId.trim();
      if (typeof payload?.toUserId === 'string') patch.toUserId = payload.toUserId.trim();
      // 投递口令：**不传这个键 = 不修改**，传空串 = 清除，传非空 = 设置。
      // 三段式而不是"空串即不改"：设置页要能显式清除口令，而 GET 又不回明文，
      // 所以只能靠"键在不在"区分「用户没碰这一项」与「用户要清掉它」。
      // 口令**不 trim** —— 首尾空格是口令的一部分，替用户"纠正"只会让他登不上。
      if (typeof payload?.sendToken === 'string') patch.sendToken = payload.sendToken;
      if (Array.isArray(payload?.sendAllowRoots)) {
        patch.sendAllowRoots = payload.sendAllowRoots
          .filter((root) => typeof root === 'string' && root.trim() !== '')
          .map((root) => root.trim())
          .slice(0, MAX_ALLOW_ROOTS);
      }
      if (Object.keys(patch).length === 0) {
        json(response, 400, { error: '没有可保存的字段' });
        return;
      }
      const saved = await saveConfig(patch);
      // 总开关变化立即生效：停 = 全部 cron 摘表 + 拒绝手动执行；开 = 按各条 enabled 重建。
      // 数据文件不因此改动（setArmed 只管运行态，偏好持久化在 config.json 里）。
      if (typeof payload?.scheduleEnabled === 'boolean' && typeof engine?.setArmed === 'function') {
        engine.setArmed(saved.scheduleEnabled !== false);
        // 工具可见性跟着总开关走：关掉功能就把那 4 个工具摘掉，模型看不到自然不会用。
        toolGate?.sync?.();
      }
      json(response, 200, {
        enabled: saved.enabled !== false,
        imageAsPicture: saved.imageAsPicture !== false,
        restartEnabled: saved.restartEnabled !== false,
        scheduleEnabled: saved.scheduleEnabled !== false,
        // 同样只回"设没设"，不回明文（见 GET 那边的说明）：保存完设置页要能立刻
        // 把「清除口令」按钮显示出来，不必重新 GET 一次。
        sendTokenSet: typeof saved.sendToken === 'string' && saved.sendToken !== '',
        sendAllowRoots: Array.isArray(saved.sendAllowRoots) ? saved.sendAllowRoots : [],
      });
      return;
    }
    json(response, 405, { error: 'method-not-allowed' });
  } catch (error) {
    json(response, error?.message === 'payload-too-large' ? 413 : 500, {
      error: error?.message ?? 'config-failed',
    });
  }
}

/**
 * POST 投递一个文件：body 为 { path, toUserId?, workspace? }。
 * 与工具 send_file_to_im 共用 deliverFile，只是入口不同。
 */
async function handleSendRequest(request, response, ctx) {
  if (request.method !== 'POST') {
    json(response, 405, { error: 'method-not-allowed' });
    return;
  }
  // 这个路由是"读任意本机文件并发走微信"的原语，比重启更危险（重启只是把自己重启了）。
  // 浏览器跨站 POST 必带 Origin → 在这里被拒；无 Origin 的本机 curl/脚本放行。
  if (!trustedLocalRequest(request)) {
    json(response, 403, { error: 'untrusted-origin' });
    return;
  }
  // 取消与超时：原先这条路径不传 signal，上游一挂起响应就无限悬挂（连接一直占着，
  // 而工具路径本来就传了 exec.signal —— 两个入口的行为不该不一致）。
  // 两个触发源：硬超时，以及客户端自己走了（关页面 / curl ^C）。
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('send-timeout')), SEND_TIMEOUT_MS);
  // 'close' 在正常结束后也会触发，所以要判 writableEnded：别把成功的请求反过来取消掉。
  const onGone = () => {
    if (!response.writableEnded) controller.abort(new Error('client-gone'));
  };
  request.once('close', onGone);
  try {
    const payload = await readJsonBody(request);
    const settings = await ensureConfig();
    if (settings.enabled === false) {
      json(response, 403, { error: 'dsh-helper 已关闭（enabled: false）' });
      return;
    }
    // 可选口令（默认关）：设了口令之后，不带口令的本机请求一律 401。
    // 这是给"不信任同机其它进程"的环境用的 —— 跨站请求本来就被 Origin 校验挡掉了。
    const expectedToken = typeof settings.sendToken === 'string' ? settings.sendToken : '';
    if (!tokenMatches(expectedToken, pickSendToken(request, payload))) {
      json(response, 401, {
        error: '缺少或错误的投递口令：请在请求头 x-dsh-helper-token（或 body 的 token 字段）里带上它。',
        code: 'send-token-required',
      });
      return;
    }
    const requested = typeof payload?.toUserId === 'string' && payload.toUserId.trim()
      ? payload.toUserId.trim()
      : settings.toUserId;
    const result = await deliverFile({
      credentials: ctx.credentials,
      settings: { ...settings, toUserId: requested },
      filePath: payload?.path,
      workspace: typeof payload?.workspace === 'string' && payload.workspace
        ? payload.workspace
        : undefined,
      signal: controller.signal,
      logger: ctx.logger,
    });
    json(response, 200, result);
  } catch (error) {
    // 客户端已经走了：连接那头没人接，写响应只会再抛一次。
    if (error?.message === 'client-gone' || response.destroyed) return;
    // deliverFile 已把上游错误翻译成人话，这里只把机器可判断的字段一并带出去。
    const timedOut = error?.message === 'send-timeout' || error?.name === 'TimeoutError';
    json(response, error?.message === 'payload-too-large' ? 413 : timedOut ? 504 : 500, {
      error: timedOut
        ? `投递超时（超过 ${Math.round(SEND_TIMEOUT_MS / 60000)} 分钟未完成），已取消。文件较大或上游无响应时可重试。`
        : error?.message ?? 'send-failed',
      ...(timedOut ? { code: 'send-timeout' } : {}),
      ...(typeof error?.code === 'string' ? { code: error.code } : {}),
      ...(error?.providerCode != null ? { providerCode: String(error.providerCode) } : {}),
    });
  } finally {
    clearTimeout(timer);
    request.off('close', onGone);
  }
}

/**
 * GET /api/dsh-helper/restart/status
 * 返回按钮渲染所需的状态：能否点 + 不可点的原因。
 */
async function handleRestartStatusRequest(request, response) {
  if (request.method !== 'GET') {
    json(response, 405, { error: 'method-not-allowed' });
    return;
  }
  // 状态本身不含机密，但也统一过来源闸：跨站页面不该探测宿主进程状态。
  if (!trustedLocalRequest(request)) {
    json(response, 403, { error: 'untrusted-origin' });
    return;
  }
  const settings = await ensureConfig();
  const restartEnabled = settings.restartEnabled !== false;
  const supervisor = detectedSupervisor();
  const debuggerAttached = detectedDebugger();
  let reason = null;
  if (!restartEnabled) reason = 'disabled-in-config';
  else if (debuggerAttached !== null) reason = 'debugger';
  else if (supervisor !== null) reason = 'supervisor';
  json(response, 200, {
    allowed: reason === null,
    reason,
    supervisor,
    debugger: debuggerAttached,
    restartEnabled,
  });
}

/**
 * POST /api/dsh-helper/restart
 * 过四道闸：restartEnabled / trustedRestartRequest / detectedDebugger / detectedSupervisor
 * 通过则 scheduleRestart(port)，本进程 500ms 后自杀。
 */
async function handleRestartRequest(request, response) {
  if (request.method !== 'POST') {
    json(response, 405, { error: 'method-not-allowed' });
    return;
  }
  try {
    const settings = await ensureConfig();
    if (settings.restartEnabled === false) {
      json(response, 403, { error: 'disabled-in-config', reason: 'disabled-in-config' });
      return;
    }
    if (!trustedRestartRequest(request)) {
      json(response, 403, { error: 'untrusted', reason: 'untrusted' });
      return;
    }
    if (detectedDebugger() !== null) {
      json(response, 403, { error: 'debugger', reason: 'debugger' });
      return;
    }
    if (detectedSupervisor() !== null) {
      json(response, 403, { error: 'supervisor', reason: 'supervisor' });
      return;
    }
    const port = servingPort(request);
    const result = scheduleRestart(port);
    json(response, 202, result);
  } catch (cause) {
    json(response, 500, { error: cause?.message ?? 'restart-failed' });
  }
}

/**
 * 找到旧后端 dsh-im 的安装目录。
 *
 * 与 im-connect 那套对称：显式配置 → **当前 profile** → 其它 profile（web / desktop 在前）。
 * 优先本 profile，是为了不让宿主跑去用另一个 profile 装的那份副本（版本可能与运行时不一致）。
 * 用户可以显式配置 dshImDir 覆盖。
 *
 * @param configured - config.json 里的 dshImDir（可空）。
 * @param home - DSH 数据根（测试用）。
 * @param profileDir - 当前 profile 目录（不传就自己从 argv 猜）。
 */
function resolveDshImDir(
  configured,
  home = dshHome(),
  profileDir = currentProfileDir(process.argv, home),
) {
  const pkgPath = ['@xmanrui', 'dsh-im'];
  const list = [configured];
  if (typeof profileDir === 'string' && profileDir.trim() !== '') {
    list.push(join(profileDir, 'node_modules', ...pkgPath));
  }
  let names = [];
  try {
    names = readdirSync(join(home, 'profiles'));
  } catch {
    names = [];
  }
  const rank = (name) => (name === 'web' ? 0 : name === 'desktop' ? 1 : 2);
  for (const name of [...names].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))) {
    list.push(join(home, 'profiles', name, 'node_modules', ...pkgPath));
  }
  const seen = new Set();
  const candidates = list.filter((value) => {
    if (typeof value !== 'string' || value.trim() === '') return false;
    const key = resolve(value);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  for (const dir of candidates) {
    if (existsSync(join(dir, 'src', 'channels', 'weixin', 'weixin-api.mjs'))) return dir;
  }

  throw new Error(
    '找不到 dsh-im 的位置。请确认 dsh-im 已装进 DSH profile，'
    + '或在 dsh-helper 的 config.json 里设置 dshImDir 指向它的目录。'
    + `（找过：${candidates.join('、') || '无候选'}）`,
  );
}

/**
 * 加载 dsh-im 的微信模块。
 *
 * 只读地 import 它已有的源码模块，不写、不改、不覆盖它的任何文件。
 * 它换模块路径或改导出名时这里会抛错，提示很明确。
 */
async function loadWeixinModules(dshImDir) {
  const dir = join(dshImDir, 'src', 'channels', 'weixin');
  const load = (file) => import(new URL(file, pathToFileURL(`${dir}/`)).href);
  try {
    const [api, state, config] = await Promise.all([
      load('weixin-api.mjs'),
      load('state-store.mjs'),
      load('config-store.mjs'),
    ]);
    return { api, state, config };
  } catch (error) {
    throw new Error(
      `加载 dsh-im 的微信模块失败（${join(dir, '*.mjs')}）：${error?.message ?? error}。`
      + 'dsh-im 可能改了内部结构，请更新 dsh-helper。',
    );
  }
}

/** 凭据服务返回 { value } 或裸字符串，这里统一成字符串。 */
function credentialValue(credential) {
  if (typeof credential === 'string') return credential;
  if (credential && typeof credential.value === 'string') return credential.value;
  return null;
}

// re-export 保持冒烟测试与既有 import 的路径不变（sniffImageKind 本体在 image-sniff.js）。
export { sniffImageKind };

/**
 * 判断这份字节内容该不该按「图片消息」发。
 *
 * 魔数优先、扩展名兜底：魔数命中就是图片；魔数认不出时，才回退看扩展名。
 *
 * 已知取舍：把文本文件命名为 .jpg 会被判成图片，然后被上游拒绝。这里选择顺从用户
 * 的命名意图（他大概就是想当图片发），而不是要求文件名与内容严格一致——真要规避，
 * 把文件改成正确的扩展名即可。
 */
export function isImagePayload(bytes, filePath) {
  if (sniffImageKind(bytes)) return true;
  const dot = typeof filePath === 'string' ? filePath.lastIndexOf('.') : -1;
  if (dot < 0) return false;
  return IMAGE_EXTENSIONS.has(filePath.slice(dot).toLowerCase());
}

/**
 * 决定这次投递走哪条通道。
 *
 * 抽成纯函数是为了让「固定行为」可被完整测到——它只有三个输入，分支全在这里：
 * 开关、内容是不是图片、上游有没有 sendImage。deliverFile 只负责执行结果。
 *
 * 两个降级都返回 file：开关关掉时用户明确要旧行为；上游缺 sendImage 时宁可少一个
 * 特性，也不要让投递直接失败。degraded 只用于日志提示。
 */
export function chooseDeliveryMethod({ bytes, filePath, imageAsPicture, hasSendImage }) {
  if (imageAsPicture === false) return { via: 'file', method: 'sendFile' };
  if (!isImagePayload(bytes, filePath)) return { via: 'file', method: 'sendFile' };
  if (!hasSendImage) return { via: 'file', method: 'sendFile', degraded: true };
  return { via: 'image', method: 'sendImage' };
}

/** 把文件路径解析成绝对路径：绝对路径原样，相对路径按会话工作目录展开。 */
function resolveFilePath(filePath, workspace) {
  const trimmed = typeof filePath === 'string' ? filePath.trim() : '';
  if (!trimmed) throw new Error('path 不能为空。');
  if (isAbsolute(trimmed)) return trimmed;
  const base = typeof workspace === 'string' && workspace ? workspace : process.cwd();
  return resolve(base, trimmed);
}

// ------------------------------------------------------- 投递加固（可选，默认全关）
//
// 这个路由的原语是「读本机任意文件并发到微信」。跨站请求已经被 trustedLocalRequest 挡掉
// （浏览器跨站 POST 必带 Origin），剩下的是**同机进程不带 Origin** 的那一类 —— 本机 curl/脚本
// 正是靠这个才能用，所以默认不能关。
//
// 于是给两道**可选**闸门，都默认关闭（2026-09-28 用户口径：「可选 token + 可选路径白名单，
// 默认都关」）：不开就与加固前逐字节同行为，既有 curl 用法一个字都不用改；
// 在多用户机器或不信任本机其它进程的环境里，用户可以把它们打开。

/**
 * 展开开头的 `~`。
 *
 * 设置页的说明里明确写了「可用 ~ 表示家目录」，host 就必须真的认它 ——
 * 否则 `resolve("~/Downloads")` 会变成 `<cwd>/~/Downloads`，一条永远匹配不上的白名单，
 * 而用户看到的是「我明明填了目录，怎么什么都发不出去」。
 * 只认 `~` 与 `~/...`：`~user/...` 那种 shell 展开不实现（要读 /etc/passwd，跨平台还不一致）。
 */
export function expandTilde(value) {
  if (value === '~') return homedir();
  return value.startsWith(`~${sep}`) ? join(homedir(), value.slice(2)) : value;
}

/**
 * 归一化白名单目录：展开成绝对路径，并尽力 realpath。
 *
 * realpath 是必需的，不是洁癖：只比字符串前缀的话，在白名单目录里放一个指向
 * `/etc/passwd` 的符号链接就绕过去了。两侧都做 realpath 才能对上 ——
 * macOS 上白名单本身常写成 `/tmp/...` 而真实路径是 `/private/tmp/...`，只 realpath
 * 一侧会导致合法路径被误拒。
 *
 * 用的是 realpathDeepest 而不是 realpathSync：目录还没建 / 外接盘没挂时，它会退到最近的
 * 一层存在的祖先去做 realpath，剩下的部分原样拼回 —— 既不因为一个还没挂上的盘就把整条
 * 功能关掉，也保持了与待投递路径**同一套**归一化规则（规则不一致就是上面那个误拒）。
 */
export function normalizeAllowRoots(roots) {
  if (!Array.isArray(roots)) return [];
  return roots
    .filter((root) => typeof root === 'string' && root.trim() !== '')
    // 与待投递路径用同一个 realpathDeepest：两侧规则必须一致，否则就是上面那个误拒。
    .map((root) => realpathDeepest(resolve(expandTilde(root.trim()))));
}

/**
 * 尽力 realpath 一个路径；路径本身不存在时，往上找**最近的一层存在的祖先**做 realpath，
 * 再把剩下的相对部分拼回去。
 *
 * 这一步不是锦上添花，少了它就会误拒：macOS 上 `tmpdir()` 给的是 `/var/folders/...`，
 * 而它的真实路径是 `/private/var/folders/...`。白名单目录存在 → realpath 成了 `/private/var/...`，
 * 而要投递的文件还不存在 → realpath 失败退回 `/var/...`，两侧前缀对不上，
 * 合法路径被判成"不在白名单里"（实测踩过：冒烟里 `join(tmpdir(), 'allowed', 'ghost.txt')` 被拒）。
 *
 * 找不到任何存在的祖先（整条路径都是空的）就原样返回，让后面的 stat 报「文件不存在」。
 */
export function realpathDeepest(absolutePath) {
  /** @type {string[]} 尚未拼回的尾部片段（自下往上收集）。 */
  const tail = [];
  let current = absolutePath;
  for (;;) {
    try {
      const real = realpathSync(current);
      return tail.length === 0 ? real : join(real, ...tail.reverse());
    } catch {
      const parent = dirname(current);
      if (parent === current) return absolutePath; // 到根了仍不存在
      tail.push(basename(current));
      current = parent;
    }
  }
}

/**
 * 路径是否在白名单之内。纯函数（两侧都必须已是规范化绝对路径），导出供冒烟测试。
 *
 * `roots` 为空 = 未启用白名单 = 一律放行：这是「默认关」的语义所在，
 * 绝不能写成"空列表 = 全拒"，否则用户一打开设置就会发现自己什么都发不出去。
 */
export function pathWithinRoots(absolutePath, roots) {
  if (!Array.isArray(roots) || roots.length === 0) return true;
  if (typeof absolutePath !== 'string' || absolutePath === '') return false;
  return roots.some((root) => absolutePath === root
    || absolutePath.startsWith(root.endsWith(sep) ? root : root + sep));
}

/** 把「不在白名单里」翻译成一句能自查的错（要列出允许的目录，否则用户不知道该填什么）。 */
export function describePathDenial(absolutePath, roots) {
  return `路径不在允许投递的目录之内：${absolutePath}。`
    + `当前只允许：${roots.join('、')}。`
    + '到「插件列表 → 辅助补丁」的设置卡片里把它的上级目录加进去，或清空该列表以取消限制。';
}

/**
 * 口令比较：定长时序安全比较。
 *
 * 用 timingSafeEqual 而不是 `===`：普通比较会在第一个不同字节处返回，
 * 响应时间差能被本机进程用来逐字节猜口令（同机攻击者正好是本功能要防的对象）。
 * 长度不同时 timingSafeEqual 会抛，所以先比长度 —— 长度本身不是秘密。
 */
export function tokenMatches(expected, provided) {
  if (typeof expected !== 'string' || expected === '') return true; // 没设口令 = 不启用（默认关）
  if (typeof provided !== 'string' || provided === '') return false;
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(provided, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** 从请求里取口令：优先专用 header，其次 body 的 `token`（curl 用户两种都顺手）。 */
export function pickSendToken(request, payload) {
  const header = request?.headers?.['x-dsh-helper-token'];
  const fromHeader = Array.isArray(header) ? header[0] : header;
  if (typeof fromHeader === 'string' && fromHeader !== '') return fromHeader;
  return typeof payload?.token === 'string' ? payload.token : '';
}

/**
 * 读 contextToken 的「年龄」—— 微信只在机器人收到入站消息时刷新它。
 *
 * 读不到就返回 null：dsh-im 的 state 结构万一变了，也只影响提示文案，不影响发送。
 */
async function contextTokenAgeMinutes(dir, botId, toUserId) {
  try {
    const raw = JSON.parse(await readFile(join(dir, 'accounts', botId, 'state.json'), 'utf8'));
    const receivedAt = Number(raw?.contextTokens?.users?.[toUserId]?.receivedAt);
    if (!Number.isFinite(receivedAt)) return null;
    return Math.max(0, Math.round((Date.now() - receivedAt) / 60000));
  } catch {
    return null;
  }
}

/**
 * 把 dsh-im 抛出的上游错误翻译成可操作的中文。
 *
 * 为什么需要：dsh-im 的文案（"微信拒绝了文件消息。"）既不区分原因、也不提示下一步，
 * 看到它只能猜。实测同一个 providerCode（-2）下**文本和文件都会被拒**，所以它跟
 * "文件格式/大小/文件名"无关。
 *
 * -2（iLink 的 `prepare failed`）的判断依据：腾讯官方协议里只明确定义了 -14
 * （bot token 失效）而**没有定义 -2**，所以下面按社区实测结论措辞，不写死原因。
 *   1. openclaw/openclaw#111952、#117163：主动投递（cron announce）失败于
 *      `sendMessage ret=-2 errmsg=prepare failed`，归因为「缺少用户上下文绑定」；
 *      同一个账号在实时回复路径正常 —— 说明 token 本身有效，不是凭据失效。
 *   2. NousResearch/hermes-agent#80125：指出把 -2 报成 "rate limited" 是误报，
 *      真实原因是缺 context_token，所以本插件不把它写成「频率限制」。
 *   3. 协议文档：https://github.com/Tencent/openclaw-weixin/blob/main/docs/protocol.md
 *
 * 认得出的一律换成带动作的提示；认不出（含本插件自己的报错）原样抛出。
 */
export function describeDeliveryFailure(error, { tokenAgeMinutes } = {}) {
  const code = typeof error?.code === 'string' ? error.code : '';
  const providerCode = error?.providerCode == null ? '' : String(error.providerCode);
  const suffix = providerCode ? `（上游错误码 ${providerCode}）` : '';
  const age = Number.isFinite(tokenAgeMinutes)
    ? `最近一次收到入站消息是 ${tokenAgeMinutes} 分钟前。`
    : '';

  let message = null;
  if (providerCode === '-2' || code === 'artifact-provider-rejected') {
    message = `微信拒绝了这条消息${suffix}（iLink「prepare failed」）：这个错误不区分原因，`
      + '可能是会话上下文过期、发送额度用尽，或消息内容被拒。'
      + `${age}其中最可能是上下文过期 —— 微信只在机器人「收到消息」时才刷新它。`
      + '请先在微信里给机器人发一条任意消息，然后立刻重试；若仍然失败，再考虑额度或内容。';
  } else if (code === 'artifact-permission-required') {
    message = `微信拒绝了发送权限${suffix}：机器人可能已被解绑或授权失效，请到「设置 → IM机器人」重新接入。`;
  } else if (code === 'artifact-too-large') {
    message = `文件超出微信的大小限制${suffix}：换一个更小的文件再试。`;
  } else if (code === 'artifact-rate-limited') {
    message = `微信对发送做了限流${suffix}：短时间内发得太多，等一会儿再试。`;
  } else if (code === 'artifact-upload-timeout') {
    message = `上传到微信 CDN 超时${suffix}：网络不稳或文件偏大，直接重试一次。`;
  } else if (code === 'artifact-delivery-uncertain') {
    message = `投递结果不确定${suffix}：微信没有给出明确回执。请先在微信里确认是否已收到，不要盲目重发。`;
  }

  if (!message) return error;

  const wrapped = new Error(message, { cause: error });
  if (code) wrapped.code = code;
  if (providerCode) wrapped.providerCode = providerCode;
  return wrapped;
}

/**
 * dsh-im 后端：把文件投递到微信。
 *
 * 全程只用 dsh-im 的原生接口（sendFile 在 weixin-api.mjs:777），本插件不复制协议。
 * 文件已由 deliverFile 读完并校验过大小时才进来。
 */
async function deliverViaDshIm({
  credentials, settings, absolutePath, bytes, signal, logger,
}) {
  const dshImDir = resolveDshImDir(settings.dshImDir);
  const { api, state, config } = await loadWeixinModules(dshImDir);

  const dir = weixinDir();
  const accountStore = await new config.WeixinConfigStore(join(dir, 'config.json')).load();
  const wantedBotId = typeof settings.botId === 'string' ? settings.botId.trim() : '';
  const account = (wantedBotId ? accountStore.get(wantedBotId) : null) ?? accountStore.list()[0];

  if (!account?.botId) {
    throw new Error('没有可用的微信机器人账号，请先在「设置 → IM机器人」里接入微信。');
  }
  if (!account.baseUrl) throw new Error('微信机器人缺少 baseUrl，请重新接入。');

  const token = credentialValue(await credentials.resolve(account.tokenRef));
  if (!token) {
    throw new Error('微信机器人凭据缺失，请在「设置 → IM机器人」里移除后重新接入。');
  }

  const toUserId = (typeof settings.toUserId === 'string' && settings.toUserId.trim())
    || account.ownerUserId;
  if (!toUserId) throw new Error('没有可用的收件人（账号里缺少 ownerUserId），请在配置里指定 toUserId。');

  // 只读 contextToken：它在机器人收到入站消息时刷新。
  // 注意不要调 bindContextTokens()，那个方法在凭据哈希不匹配时会清空 users 表。
  const stateStore = await new state.WeixinStateStore(
    join(dir, 'accounts', account.botId, 'state.json'),
  ).load();
  const contextToken = stateStore.contextTokenFor(toUserId) ?? null;

  signal?.throwIfAborted();

  const weixinApi = api.createWeixinApi();

  // 图片自动改走图片消息（media_type=1 / image_item），微信端直接渲染成图片，
  // 而不是一张需要点开的「文件」卡片。非图片路径与改动前完全一致。
  const { via, method, degraded } = chooseDeliveryMethod({
    bytes,
    filePath: absolutePath,
    imageAsPicture: settings.imageAsPicture,
    hasSendImage: typeof weixinApi.sendImage === 'function',
  });

  if (degraded) {
    logger?.warn?.('[dsh-helper] 上游 dsh-im 没有 sendImage，已降级为文件方式发送。');
  }

  try {
    await weixinApi[method]({
      baseUrl: account.baseUrl,
      token,
      toUserId,
      // sendImage 内部不用 fileName，但 sendArtifact 的入参校验要求它存在，所以照传。
      file: { fileName: basename(absolutePath), bytes },
      contextToken,
      signal,
    });
  } catch (error) {
    // 失败时顺带查一下 token 有多旧：它通常就是被拒的原因。
    const tokenAgeMinutes = await contextTokenAgeMinutes(dir, account.botId, toUserId);
    throw describeDeliveryFailure(error, { tokenAgeMinutes });
  }

  // 字段必须与 DELIVERY_RESULT_SCHEMA 一致（工具返回值要过 DSH 校验）。
  return {
    sent: true,
    fileName: basename(absolutePath),
    bytes: bytes.byteLength,
    toUserId,
    botId: account.botId,
    hadContextToken: Boolean(contextToken),
    via,
  };
}

/**
 * 读文件并做本地上限校验。
 *
 * 两个后端共用这一步：先 stat 再读 —— 超上限的文件注定到不了微信（上游会以 413 回绝），
 * 不值得先全量读进内存陪跑一次注定失败的上传。上限取 200 MiB 是刻意宽松的个人微信文件
 * 口径（真正能发多大的最终以上游回执为准；im-connect 自己的媒体上限是 50 MiB）。
 *
 * 白名单校验也放在这里（而不是只放在 HTTP 入口）：它是"读本机文件"的唯一收口点，
 * 工具路径与 HTTP 路径都经过它，一处生效两处 —— 只在 HTTP 侧挡的话，
 * 模型调用那条路就成了绕过白名单的后门。校验在 stat **之前**：被拒的路径连存在性都不该探测。
 *
 * @param allowRoots - 已归一化的允许目录（空数组 = 未启用白名单 = 不限制）。
 */
async function readDeliveryFile(filePath, workspace, allowRoots) {
  const absolutePath = resolveFilePath(filePath, workspace);
  if (!pathWithinRoots(realpathDeepest(absolutePath), allowRoots)) {
    throw new Error(describePathDenial(absolutePath, allowRoots));
  }
  let size;
  try {
    size = (await stat(absolutePath)).size;
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error(`文件不存在：${absolutePath}`);
    if (error?.code === 'EISDIR') throw new Error(`这是一个目录而不是文件：${absolutePath}`);
    throw error;
  }
  if (size > MAX_FILE_BYTES) {
    throw new Error(`文件太大（${(size / 1048576).toFixed(1)} MB），超出 ${MAX_FILE_BYTES / 1048576} MB 的投递上限：请拆分或压缩后再试。`);
  }
  try {
    return { absolutePath, bytes: await readFile(absolutePath) };
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error(`文件不存在：${absolutePath}`);
    if (error?.code === 'EISDIR') throw new Error(`这是一个目录而不是文件：${absolutePath}`);
    throw error;
  }
}

/**
 * 选投递后端。
 *
 * auto（默认）：装了 @michengai/dsh-im-connect 就用它，否则退回 @xmanrui/dsh-im —— 本插件被
 * 多个 profile 共用、它们装的 IM 插件不一定相同，所以按实际安装情况探测（候选顺序里**当前
 * profile 优先**，两个后端都没有才用别的 profile 的副本），而不是写死一个。
 * 显式指定时**不做静默退回**：用户说用哪个后端，找不到就该报错，而不是换条路把文件发出去。
 */
function resolveDeliveryBackend(settings) {
  const wanted = settings.backend === 'im-connect' || settings.backend === 'dsh-im'
    ? settings.backend
    : 'auto';
  if (wanted !== 'dsh-im') {
    try {
      return { id: 'im-connect', dir: resolveImConnectDir(settings.imConnectDir) };
    } catch (error) {
      if (wanted === 'im-connect') throw error;
    }
  }
  return { id: 'dsh-im', dir: resolveDshImDir(settings.dshImDir) };
}

/** 只探测、不抛错：给设置面板显示「当前用哪个后端」。 */
export function detectDeliveryBackend(settings = {}) {
  try {
    return resolveDeliveryBackend(settings).id;
  } catch {
    return '';
  }
}

/** 核心：把文件投递到 IM。后端选好后各自投递，本函数只负责「读文件 + 分派」。 */
async function deliverFile({
  credentials, settings, filePath, workspace, signal, logger,
}) {
  // 白名单在这里归一化（一次 realpath），再交给唯一的读文件收口点。
  const { absolutePath, bytes } = await readDeliveryFile(
    filePath, workspace, normalizeAllowRoots(settings?.sendAllowRoots),
  );
  signal?.throwIfAborted();
  const backend = resolveDeliveryBackend(settings);
  if (backend.id === 'im-connect') {
    return deliverViaImConnect({
      credentials, settings, absolutePath, bytes, signal, logger,
    });
  }
  return deliverViaDshIm({
    credentials, settings, absolutePath, bytes, signal, logger,
  });
}

/**
 * 注册 4 个定时任务工具，返回聚合 disposer。
 *
 * 为什么让 agent 也能建任务：用户更自然的说法是「帮我每天 9 点半获取每日热点新闻 10 条」，
 * 而不是先打开面板填一遍表单。工具是这条路里**唯一**能让 agent 够到引擎的通道 ——
 * remote 那套是给前端面板用的（Typert Gateway，走 WebSocket），agent 调不到。
 *
 * 与官方 dsh-schedule 的 schedule_create 的分工（两套可以同时装着）：
 *   · 本插件的任务：到点**新开一个会话**执行提示词，不依赖任何已有会话，可绑工作区；
 *   · 官方那条是**会话内提醒**：到点往当前会话投递一条提示。
 * 两个工具同时在表里时「该用哪个」由模型按 systemPrompt 的引导去问用户，而不是替用户决定。
 *
 * @param toolCtx - 拿到 tools 服务的注入上下文。
 * @param engine - 定时任务引擎（create/update/remove/list/preview/ensureWorkspace）。
 * @param hostCtx - 插件自己的 ctx。**不能拿 toolCtx 代劳**：toolCtx 是 `ctx.inject([...])`
 *   给的子上下文，只保证有 tools 那几个服务，读 workspaceRegistry 得用插件 ctx
 *   （自检里的假 ctx 就没有 get，用错会直接抛 "ctx.get is not a function"）。
 * @returns 注销这 4 个工具的函数。
 */
function registerScheduleTools(toolCtx, engine, hostCtx) {
  const disposers = [];
  const register = (definition) => {
    const dispose = toolCtx.tools.register(definition);
    // 宿主的 register 返回 disposer；万一某个版本不返回，也不该连累其余三个工具。
    if (typeof dispose === 'function') disposers.push(dispose);
  };

  /** 关掉总开关后工具本该已被注销；这里再挡一道，防的是"注销与调用撞在一起"的窗口。 */
  const assertSwitchOn = async () => {
    const settings = await ensureConfig();
    if (settings.scheduleEnabled === false) {
      throw new Error('定时任务功能当前已关闭（config.json 的 scheduleEnabled: false）。'
        + '需要在「插件列表 → 辅助补丁」的设置卡片里打开「启用定时任务」才能管理定时任务。');
    }
  };

  /** 下次触发时间（只在总开关开着且该条启用时才算，否则面板/模型看到的时间是假的）。 */
  const nextRunsOf = (cron, enabled, armed) => {
    if (armed === false || enabled !== true) return [];
    try {
      return engine.preview(cron).fires.slice(0, 3);
    } catch {
      // 表达式写进盘时已校验过；这里读不出来只可能是引擎版本差异，不该让整个工具调用失败。
      return [];
    }
  };

  register({
    name: 'create_schedule_task',
    description: '创建一个**独立的定时任务**：到点会**新建一个 agent 会话**执行给定提示词，'
      + '不依赖当前对话、也不依赖这个会话是否还在。cron 为「分 时 日 月 周」五段表达式，'
      + '秒不为 0 时写六段（如 "0 9 * * *" = 每天 9:00，"30 9 * * *" = 每天 9:30）。'
      + '**要建一次性任务**（例如"今年 9 月 28 日上午 9 点跑一次"）：cron 写成那一天'
      + '（cron 语法里没有年份位，只能表达成"每年这天"，所以写 "0 9 28 9 *"），'
      + '**并传 maxRuns: 1** —— 它跑完第一次就自动停用，等价于只在那一天跑一次。'
      + '若用户只是想在**当前会话**里到点收到一条提醒，请改用官方的 schedule_create，不要用本工具。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        title: {
          type: 'string',
          description: `任务名，最多 ${MAX_TITLE_CHARS} 个字符，显示在定时任务面板的列表里。`,
        },
        prompt: {
          type: 'string',
          description: `到点让 agent 做什么，最多 ${MAX_PROMPT_CHARS} 个字符。会被**原样**提交给新开的会话（与用户手打一条消息等价）。`,
        },
        cron: {
          type: 'string',
          description: '执行时间，cron 表达式：分 时 日 月 周；首位可加秒（秒不为 0 时写六段）。',
        },
        maxRuns: {
          type: 'number',
          description: '可选：最多执行几次。1 = 只跑一次（一次性任务，跑完自动停用）；省略 = 不限次数。'
            + '配合"某年某月某日"这种一次性时间时必填 1。',
        },
        enabled: {
          type: 'boolean',
          description: '是否启用，默认 true。停用后保留数据但不再触发。',
        },
        workspacePath: {
          type: 'string',
          description: '**通常必须省略**。省略时任务用默认的「定时任务」工作区，执行产生的会话会归在侧栏的「定时任务」下。'
            + '只有当用户**明确说了**某个目录（例如"放到 ~/work/report 里跑"）时才填它。'
            + '**不要按任务主题自己挑目录** —— 那样任务会在「定时任务」之外另建工作区，'
            + '执行出来的会话散落在那儿，用户在侧栏的「定时任务」里找不到它们（2026-09-28 实测踩过）。',
        },
      },
      required: ['title', 'prompt', 'cron'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          prompt: { type: 'string' },
          cron: { type: 'string' },
          enabled: { type: 'boolean' },
          workspacePath: { type: 'string' },
          maxRuns: { type: 'number' },
          runCount: { type: 'number' },
          nextRuns: { type: 'array', items: { type: 'string' } },
        },
        required: ['id', 'title', 'cron', 'enabled'],
      },
      render: (_args, value) => [{
        type: 'text',
        text: `已创建定时任务「${value.title}」（cron：${value.cron}）${value.enabled ? '' : '，当前为停用状态'}。`
          + (value.maxRuns ? `最多执行 ${value.maxRuns} 次${value.maxRuns === 1 ? '（跑完自动停用）' : ''}。` : '')
          + (value.workspacePath ? `工作目录：${value.workspacePath}。` : '')
          + (value.nextRuns?.length ? `下次触发：${value.nextRuns.join('、')}。` : '')
          // id 必须露出来：后续 update_schedule_task / delete_schedule_task 都按 id 定位，
          // 模型拿不到就只能在下一轮去 list 里找（甚至拿标题当 id 去试，直接报"找不到"）。
          + `任务 id：${value.id}。`
          + '可在「插件列表 → 辅助补丁」的定时任务面板里查看和管理。',
      }],
    },
    async execute(args) {
      await assertSwitchOn();
      const input = {
        title: args?.title,
        prompt: args?.prompt,
        cron: args?.cron,
        enabled: args?.enabled !== false,
      };
      // 次数上限（1 = 一次性任务）。引擎会把 null 当作"不限次"并拒绝落盘这个键。
      if (args?.maxRuns !== undefined && args?.maxRuns !== null) input.maxRuns = args.maxRuns;
      // 工作区：**只解析、不创建**（用户口径：「任务还没执行就把工作区建了？不用这样，
      // 执行的时候应该会自动建立」）。建目录与建工作区的动作全部推迟到第一次真正执行 ——
      // 引擎的 tryAutoRecoverWorkspace 会在那时按 workspacePath 建回来。
      //
      // 于是这里可能只拿到 workspacePath、拿不到 workspaceId（默认工作区还不存在时就是
      // 这种情形）：任务照建，执行时再建。别再退回"调 ensureWorkspace 建一下"——
      // 那正是这次要消掉的过早副作用，而它留下的空目录 + 侧栏多出来的工作区，
      // 在任务永远不执行时就是纯垃圾。
      const resolved = resolveScheduleWorkspace(hostCtx, args?.workspacePath);
      if (resolved.workspaceId !== undefined) input.workspaceId = resolved.workspaceId;
      if (resolved.workspacePath !== undefined) input.workspacePath = resolved.workspacePath;
      const item = await engine.create(input);
      const snapshot = engine.snapshot();
      return {
        id: item.id,
        title: item.title,
        prompt: item.prompt,
        cron: item.cron,
        enabled: item.enabled !== false,
        workspacePath: item.workspacePath ?? '',
        // 0 = 不限次数（严格 schema 下不能给 undefined）。
        maxRuns: item.maxRuns ?? 0,
        runCount: item.runCount ?? 0,
        nextRuns: nextRunsOf(item.cron, item.enabled, snapshot.armed),
      };
    },
  });

  register({
    name: 'list_schedule_tasks',
    description: '列出本插件（辅助补丁）当前所有的**独立定时任务**：标题、cron、启用状态、上次执行与下次触发。'
      + '回答「我有哪些定时任务」以及 update/delete 之前定位目标时用它。'
      + '注意官方的会话内提醒不在这个列表里（那套由 schedule_list 管）。',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          armed: { type: 'boolean' },
          total: { type: 'number' },
          items: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string' },
                title: { type: 'string' },
                cron: { type: 'string' },
                enabled: { type: 'boolean' },
                lastRunAt: { type: 'string' },
                lastRunError: { type: 'string' },
                maxRuns: { type: 'number' },
                runCount: { type: 'number' },
                nextRuns: { type: 'array', items: { type: 'string' } },
              },
              required: ['id', 'title', 'cron', 'enabled'],
            },
          },
        },
        required: ['armed', 'total', 'items'],
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.total === 0
          ? '当前没有任何定时任务。'
          : value.items.map((item) => `· ${item.title}（${item.cron}）`
            + `${item.enabled ? '' : ' [已停用]'}`
            + `${item.maxRuns ? ` 限 ${item.maxRuns} 次（已跑 ${item.runCount}）` : ''}`
            + `${item.nextRuns?.[0] ? ` 下次 ${item.nextRuns[0]}` : ''}`
            + `${item.lastRunError ? ` 上次失败：${item.lastRunError}` : ''}`
            // id 放在行尾：工具说明写着"update/delete 之前定位目标时用它"，而 update/delete
            // 都按 id 定位。原先这里不渲染 id，模型就只能拿标题去猜，delete 直接报"找不到"。
            + ` [id=${item.id}]`).join('\n'),
      }],
    },
    async execute() {
      await assertSwitchOn();
      const snapshot = engine.snapshot();
      const items = snapshot.items.map((item) => ({
        id: item.id,
        title: item.title,
        cron: item.cron,
        enabled: item.enabled !== false,
        lastRunAt: item.lastRunAt ?? '',
        lastRunError: item.lastRunError ?? '',
        maxRuns: item.maxRuns ?? 0,
        runCount: item.runCount ?? 0,
        nextRuns: nextRunsOf(item.cron, item.enabled, snapshot.armed),
      }));
      return { armed: snapshot.armed !== false, total: items.length, items };
    },
  });

  register({
    name: 'update_schedule_task',
    description: '修改一条已存在的定时任务（按 id）。只传要改的字段，没传的保持原样。'
      + '**先调用 list_schedule_tasks 拿到 id**，并把要改的任务标题回显给用户确认后再改。'
      + '改 cron 等于改执行时间；改 prompt 等于改到点让 agent 做什么；把 maxRuns 传 0 表示改回不限次数。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'string', description: '任务 id（由 create 返回，或用 list_schedule_tasks 查）。' },
        title: { type: 'string', description: `新的任务名（最多 ${MAX_TITLE_CHARS} 字符）。` },
        prompt: { type: 'string', description: `新的提示词（最多 ${MAX_PROMPT_CHARS} 字符）。` },
        cron: { type: 'string', description: '新的 cron 表达式。' },
        maxRuns: {
          type: 'number',
          description: '新的执行次数上限（1 = 跑完一次就自动停用）；传 0 表示改回不限次数。',
        },
        enabled: { type: 'boolean', description: '启用或停用这一条。' },
      },
      required: ['id'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          cron: { type: 'string' },
          enabled: { type: 'boolean' },
          maxRuns: { type: 'number' },
          runCount: { type: 'number' },
          nextRuns: { type: 'array', items: { type: 'string' } },
        },
        required: ['id', 'title', 'cron', 'enabled'],
      },
      render: (_args, value) => [{
        type: 'text',
        text: `已更新定时任务「${value.title}」：cron ${value.cron}${value.enabled ? '' : '（已停用）'}`
          + `${value.maxRuns ? `，限 ${value.maxRuns} 次（已跑 ${value.runCount}）` : ''}。`
          + (value.nextRuns?.length ? `下次触发：${value.nextRuns.join('、')}。` : ''),
      }],
    },
    async execute(args) {
      await assertSwitchOn();
      const patch = {};
      if (typeof args?.title === 'string') patch.title = args.title;
      if (typeof args?.prompt === 'string') patch.prompt = args.prompt;
      if (typeof args?.cron === 'string') patch.cron = args.cron;
      // 0 = 显式改回不限次数（引擎收到 null 会把旧上限删掉）。
      if (typeof args?.maxRuns === 'number') patch.maxRuns = args.maxRuns;
      if (typeof args?.enabled === 'boolean') patch.enabled = args.enabled;
      if (Object.keys(patch).length === 0) {
        throw new Error('没有给出要修改的字段（title / prompt / cron / maxRuns / enabled 至少给一个）。');
      }
      const item = await engine.update(args.id, patch);
      const snapshot = engine.snapshot();
      return {
        id: item.id,
        title: item.title,
        cron: item.cron,
        enabled: item.enabled !== false,
        maxRuns: item.maxRuns ?? 0,
        runCount: item.runCount ?? 0,
        nextRuns: nextRunsOf(item.cron, item.enabled, snapshot.armed),
      };
    },
  });

  register({
    name: 'delete_schedule_task',
    description: '删除一条定时任务（按 id）。**先调用 list_schedule_tasks 拿到 id**，'
      + '并把要删的任务标题与 cron 原文回显给用户、得到确认后再删；删除不可撤销。'
      + '若只是想让它别再触发，改用 update_schedule_task 把 enabled 设为 false 更稳妥。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'string', description: '任务 id（由 create 返回，或用 list_schedule_tasks 查）。' },
      },
      required: ['id'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          removed: { type: 'boolean' },
          id: { type: 'string' },
          title: { type: 'string' },
        },
        required: ['removed', 'id'],
      },
      render: (_args, value) => [{
        type: 'text',
        text: `已删除定时任务${value.title ? `「${value.title}」` : ''}（${value.id}）。`,
      }],
    },
    async execute(args) {
      await assertSwitchOn();
      // 先取出标题：删完就查不到了，而回执里带上标题用户才能确认删对了。
      const existing = engine.list().find((item) => item.id === args?.id);
      await engine.remove(args?.id);
      return { removed: true, id: String(args?.id ?? ''), title: existing?.title ?? '' };
    },
  });

  return () => {
    for (const dispose of disposers.splice(0)) dispose();
  };
}

/**
 * 当前这次 section 渲染是不是在给**子会话**（subagent）写 system prompt。
 *
 * 判据与 T专家 的 `t-team:experts` 小节完全一致：宿主传进来的 context 里，
 * 子会话的 `agent.session.header.parentSession` 有值。
 *
 * 为什么本插件这两段引导都要对子会话闭嘴：
 *   · 「该不该把文件发到用户微信」「该不该建一个每天自动跑的任务」都是**用户级**决定，
 *     要由主会话和用户商量着来。子会话拿到这两段只是白占 token，更糟的是可能被诱导
 *     自作主张把中间产物直接发进用户微信、或建一个用户从没要过的定时任务 ——
 *     两者都是有持久副作用的动作，不是"多写一句"那么便宜。
 *   · 子会话真要发文件也发得了：工具本身仍在它的工具表里，这里省掉的只是"怎么选用"的引导。
 */
function isChildSession(context) {
  return context?.agent?.session?.header?.parentSession !== undefined;
}

export function apply(ctx) {
  // 改名迁移必须排在任何读盘之前：configFile() / scheduleFile() 都按新目录名拼路径，
  // 先把旧目录搬过来，老用户的数据才接得上。
  ensureDataDirMigrated(ctx.logger);

  // ---- 定时任务：调度引擎 + 数据文件 ----
  // 数据落在本插件自己的数据根（$DSH_HOME/integrations/dsh-helper/schedule.json）：
  // 不碰宿主的任何存储域，也不碰别的插件的文件。首次启动若发现旧位置（T专家 时代）的数据，
  // 会复制一份过来（见 migrateScheduleFile）。
  const scheduleDataFile = scheduleFile();
  // 迁移闸门：**T专家 那一侧彻底下线之前必须保持 false**。两边各自按自己的数据文件调度，
  // 此刻把任务复制过来，同一个任务会被两个插件各触发一次（用户会看到重复执行）。
  // 等 T专家 的定时任务代码删掉之后，把它改成 true（或手工跑一次迁移）即可。
  /** 迁移诊断（有搁浅的旧任务时非空），透传给引擎 → snapshot → 面板。 */
  let migrationNotice;
  if (SCHEDULE_MIGRATION_ENABLED) {
    migrationNotice = migrateScheduleFile(scheduleDataFile, ctx.logger);
  } else if (!existsSync(scheduleDataFile)) {
    const legacy = join(homedir(), '.t-team', SCHEDULE_FILE_NAME);
    if (existsSync(legacy)) {
      ctx.logger?.warn?.(`[dsh-helper] 检测到旧位置仍有定时任务数据（${legacy}）：`
        + `迁移闸门（SCHEDULE_MIGRATION_ENABLED）当前是关闭的，没有复制过来 —— `
        + `这是为了避免同一个任务被两个插件各跑一次。`);
    }
  }
  const scheduleEngine = createScheduleEngine({
    ctx,
    file: scheduleDataFile,
    logger: ctx.logger,
    // 文案现取：错误消息会出现在面板上。
    t: (key, params) => scheduleText(key, params),
    defaultCwd: homedir(),
    // 旧文件里有任务却没迁过来时，让面板说出来（日志在桌面/Web 里用户看不见）。
    migrationNotice,
    // 提示词**原样提交**给新会话：定时任务开的会话与手动会话挂同一份 system prompt，
    // 里面已经写着「看到 `@专家名` 就 summon_t_expert FIRST」，这里再做改写只会让
    // 同一条任务在两个入口显示成两种样子。
    ensureWorkspace: (path, title) => ensureScheduleWorkspace(ctx, path, title),
    // 只读的那一半：面板「新建任务」表单取默认工作区用它 ——
    // 用户点开新建、甚至填完又取消，都不该先留下一个工作区/空目录。
    resolveWorkspace: (path) => resolveScheduleWorkspace(ctx, path),
    // 工作区目录的历史遗留改判（`<宿主 cwd>/tesk` → `~/定时任务`）：引擎只管问"该用哪条路径"，
    // 规则留在 host 这一份，load 与执行两处都过它 —— 否则旧机器上那条已经绑到坏工作区的任务
    // 会一直跑在 `/usr/local/bin/tesk` 里，用户换台电脑也等不到它自愈。
    reviseWorkspacePath: (path) => reviseScheduleDir(path),
    // 总开关与设置页那颗「启用定时任务」是同一份数据（config.json 的 scheduleEnabled）：
    // 这里同步读盘拿初始值，之后配置变更由 handleConfigRequest 的 setArmed 对齐。
    armed: readInitialArmed(),
  });
  ctx.effect(() => () => scheduleEngine.dispose(), 'dsh-helper: schedule jobs');

  /**
   * 定时任务工具的可见性**跟着总开关走**：关掉功能就把这 4 个工具注销掉，
   * 而不是留着在 execute 里报错 —— 模型看不到它们，就不会去建任务，
   * 也不会在「用哪种定时任务」上弹窗让用户选一个已经下线的选项。
   *
   * 放在 apply 作用域是因为它要被两个不同的注入回调共用：注册在 tools 回调里、
   * 开关变更在 webServer 的 config 路由里。
   */
  const scheduleToolGate = {
    /** tools 服务的注入上下文（拿到后存这里）。 */
    toolCtx: undefined,
    /** 4 个工具的聚合 disposer。 */
    dispose: undefined,
    /** 按 config.json 的 scheduleEnabled 对齐注册状态；幂等，可反复调用。 */
    sync() {
      if (this.toolCtx === undefined || typeof this.toolCtx?.tools?.register !== 'function') return;
      const want = readInitialArmed();
      if (want === (this.dispose !== undefined)) return;
      if (!want) {
        this.dispose?.();
        this.dispose = undefined;
        return;
      }
      this.dispose = registerScheduleTools(this.toolCtx, scheduleEngine, ctx);
    },
  };
  // remote 服务**由插件自己挂**，不走包的 cordis.patch.yml。
  // 原因是实测出来的：profile 以 `link:` 安装时，包内那份 patch 不会被合并进
  // ~/.dsh/profiles/web/cordis.patch.yml（那是**安装时**生成的），所以只改包内 patch
  // 不重装的话，宿主根本不会加载这个服务 —— 表现成面板报
  // 「定时任务服务暂时不可用：Cannot read properties of undefined (reading 'getSchedule')」。
  // 自注册没有这个前置条件：插件被加载，服务就在。类里的 static inject 会让 cordis
  // 等 settings / typert 就绪再实例化。
  if (typeof ctx.plugin === 'function') {
    ctx.plugin(HelperPatchScheduleRemote);
    ctx.logger?.info?.('[dsh-helper] 定时任务：调度引擎就绪，remote 服务已提交注册（wire 名 helperPatch）。');
  } else {
    ctx.logger?.warn?.('[dsh-helper] ctx.plugin 不可用，定时任务的 remote 服务无法注册（面板将拿不到数据）。');
  }
  // remote 服务（lib/schedule-remote.js）从根服务表里取它；宿主太老没有 reflect 时降级：
  // 面板会收到 helperPatch/schedule-unavailable，而不是静默失效。
  ctx.reflect?.provide?.(SCHEDULE_SERVICE, scheduleEngine);
  if (typeof ctx?.inject !== 'function') {
    ctx.logger?.warn?.('[dsh-helper] ctx.inject 不可用，插件未激活。');
    return;
  }

  // 设置面板：客户端在这个同源路由上读写开关。
  // 投递端点也需要 credentials 才能取到机器人 token，所以一起注入。
  ctx.inject(['webServer', 'credentials'], (httpCtx) => {
    if (typeof httpCtx?.webServer?.register !== 'function'
      || typeof httpCtx?.effect !== 'function') {
      httpCtx.logger?.warn?.('[dsh-helper] webServer 不可用，设置面板与投递端点都拿不到。');
      return;
    }
    httpCtx.effect(
      () => httpCtx.webServer.register({
        kind: 'exact',
        path: CONFIG_HTTP_PATH,
        // 带上引擎：scheduleEnabled 变化时立即 setArmed，不用等重启。
        handler: (request, response) => handleConfigRequest(request, response, scheduleEngine, scheduleToolGate),
      }),
      `dsh-helper: ${CONFIG_HTTP_PATH}`,
    );
    httpCtx.effect(
      () => httpCtx.webServer.register({
        kind: 'exact',
        path: SEND_HTTP_PATH,
        handler: (request, response) => handleSendRequest(request, response, httpCtx),
      }),
      `dsh-helper: ${SEND_HTTP_PATH}`,
    );
    httpCtx.effect(
      () => httpCtx.webServer.register({
        kind: 'exact',
        path: RESTART_STATUS_HTTP_PATH,
        handler: handleRestartStatusRequest,
      }),
      `dsh-helper: ${RESTART_STATUS_HTTP_PATH}`,
    );
    httpCtx.effect(
      () => httpCtx.webServer.register({
        kind: 'exact',
        path: RESTART_HTTP_PATH,
        handler: handleRestartRequest,
      }),
      `dsh-helper: ${RESTART_HTTP_PATH}`,
    );
  });

  // tools / systemPrompt 必须通过注入拿到：在 cordis 里直接读 ctx.tools 会得到
  // undefined，工具就会静默注册失败。
  ctx.inject(['credentials', 'tools', 'systemPrompt'], (imCtx) => {
    if (typeof imCtx?.tools?.register !== 'function') {
      imCtx.logger?.warn?.('[dsh-helper] tools 服务不可用，工具未注册。');
      return;
    }

    imCtx.tools.register({
      name: TOOL_NAME,
      description: '把一个本机文件通过 IM（微信）主动发送给指定私聊目标。图片/视频自动走图片/视频消息（对方在微信里可直接预览），其他文件以文件形式发送。它在调用内真正完成上传与发送，不依赖当前会话是否绑定 IM，因此从 DSH 对话框发起的会话也能用。成功只代表平台已受理。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: {
            type: 'string',
            description: '文件的绝对路径，或相对于当前工作区的路径。',
          },
          toUserId: {
            type: 'string',
            description: '可选：收件人 id。省略时用配置里的默认收件人，再退回该账号绑定的用户。',
          },
        },
        required: ['path'],
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: Object.fromEntries(
            Object.entries(DELIVERY_RESULT_SCHEMA).map(([key, type]) => [key, { type }]),
          ),
          required: ['sent', 'fileName', 'bytes'],
        },
        render: (_args, value) => [{
          type: 'text',
          text: value.sent
            ? `已投递 ${value.fileName}（${value.bytes} 字节）到 IM（${DELIVERY_VIA_TEXT[value.via] ?? '文件'}，平台已受理）。`
            : `投递 ${value.fileName} 失败，请查看 DSH 日志里的原因。`,
        }],
      },
      async execute(args, exec) {
        const settings = await ensureConfig();
        if (settings.enabled === false) {
          throw new Error('文件投递当前是关闭状态（config.json 的 enabled: false）：'
            + '在「插件列表 → 辅助补丁」的设置卡片里打开「允许把文件投递到 IM」即可恢复。');
        }

        const requested = typeof args?.toUserId === 'string' && args.toUserId.trim()
          ? args.toUserId.trim()
          : settings.toUserId;

        const workspace = exec?.agent?.session?.header?.cwd;
        return deliverFile({
          credentials: imCtx.credentials,
          // 后端目录（dshImDir / imConnectDir）已经随 ...settings 展开（来自 config.json），
          // 不需要再从 apply 的第二参数里拼一次——那个参数以前根本没被 DSH 传进来。
          settings: { ...settings, toUserId: requested },
          filePath: args?.path,
          workspace: typeof workspace === 'string' && workspace ? workspace : undefined,
          signal: exec?.signal,
          logger: imCtx.logger,
        });
      },
    });

    // 定时任务那 4 个工具交给 gate 按总开关动态挂/摘：关掉功能后模型不该再看到它们。
    scheduleToolGate.toolCtx = imCtx;
    scheduleToolGate.sync();
    ctx.effect(() => () => {
      scheduleToolGate.toolCtx = undefined;
      scheduleToolGate.dispose?.();
      scheduleToolGate.dispose = undefined;
    }, 'dsh-helper: schedule tools');

    if (typeof imCtx?.systemPrompt?.section === 'function') {
      imCtx.systemPrompt.section({
        name: 'dsh-helper:send-file',
        order: 116,
        // 子会话不给这段（见 isChildSession）：text 因此从静态字符串改成函数形式。
        text: (context) => (isChildSession(context) ? '' : `当用户要求把某个文件"发到我微信 / 发到 IM / 发给我"时，按当前会话的来源分两种走法：

· 会话**由 IM 消息触发**（消息来自微信等渠道）→ 直接用 present 交付该文件，**不要再调 ${TOOL_NAME}**：IM 插件会在回合结束时自己把它回传，再调工具等于同一个文件发两遍；
· 其他会话（从 DSH 对话框、CLI、定时任务新开的会话）→ 调用 ${TOOL_NAME} 并给出文件路径（绝对路径，或相对当前工作区的路径），它在调用内真正完成上传与发送，不依赖当前会话是否绑定 IM。

调用要点：
· 一次一个文件：要发多个就逐个调用；文件不存在、是目录、或超过 200 MiB 会在读取前直接报错，不需要你提前检查存在性或大小；
· 收件人默认是该微信账号绑定的用户本人，用户明确指定了别人时才传 toUserId；
· 图片/视频会按内容自动走图片/视频消息（文件名不对也会被纠正），不需要你操心格式或改名。

回执与失败：
· sent: true 只代表**平台已受理**，不等于对方已读——回复用户时说"已投递 / 平台已受理"，不要说"已送达"；
· 失败时错误信息自带可操作建议（如上下文过期会提示"先在微信里给机器人发一条消息再重试"）：把它转述给用户即可，**不要立刻原样重试**——需要用户先在微信侧动作的错误，重试只会再失败一次。

两个禁止：
· 不要用 dsh_im_return_file 一类的"登记待取"工具代替：那种工具只在会话由 IM 消息触发时才有消费者，从对话框发起时会静默丢失；
· 若用户只是想在当前对话里拿到文件（不是发微信），用对话内交付方式（例如 present）即可。`),
      });
      // 定时任务：这里**只写判断规则**，能力本身由工具表决定。
      // 四态（哪个开着）模型看自己的工具列表就知道，不需要我们探测、也不该写死。
      imCtx.systemPrompt.section({
        name: 'dsh-helper:schedule-tasks',
        order: 117,
        // 同 send-file：子会话不给（建定时任务是用户级决定，见 isChildSession）。
        text: (context) => (isChildSession(context) ? '' : `用户在对话里要求「建一个定时任务 / 定时提醒 / 每天自动做某事」时，先看你自己的工具表里有哪几种定时任务能力，再按下面走：

· 同时有 create_schedule_task 与官方的 schedule_create → **必须先调用 ask_user_question**，用下面两段固定文案让用户选一种，选定后再调对应工具；**不要替用户默认**。
  · 「独立定时任务」：到点会新开一个会话执行提示词，不依赖当前对话；在「插件列表 → 辅助补丁」的定时任务面板里管理。关掉这个对话也照跑。适合每天自动整理、生成、抓取这类长期任务。
  · 「会话内提醒」：到点往当前对话里发一条提醒，只在本会话生效。适合"到点提醒我看一眼"，不适合长期自动跑的任务。
  选项文案与顺序固定，把「独立定时任务」标为推荐项。
· 只有 create_schedule_task → 直接用它，不要再问。
· 只有 schedule_create → 直接用它，不要再问。
· 两个都没有 → 直接告诉用户当前没有可用的定时任务功能，不要编造。

时间必须问清楚：用户没说到点时间（例如只说"帮我建个定时任务"）时，先问清几点、多久一次，再换算成 cron（分 时 日 月 周，秒不为 0 时写六段）。**不要自己假定一个时间。**

工作目录一律**不要指定**：建任务时省略 workspacePath，任务就会用默认的「定时任务」工作区，执行出来的会话在侧栏「定时任务」下看得见。按任务主题自己挑一个目录（比如给"每日热点"配个 ~/Temp/news-daily）会让任务在「定时任务」之外另建工作区，会话散落在那边，用户在「定时任务」里找不到 —— 用户明确说了某个目录时才填。

用 create_schedule_task 建成后，回复里要说明任务已加入「插件列表 → 辅助补丁」的定时任务面板，并给出下次触发时间。
update_schedule_task / delete_schedule_task 都要先用 list_schedule_tasks 拿到 id（列表里每行末尾的 [id=…] 就是它），并把目标任务的标题与 cron 回显给用户、得到确认后再动手。`),
      });
    }
  });
}
