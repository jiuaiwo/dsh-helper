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
import { cpSync, existsSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  currentProfileDir,
  deliverViaImConnect,
  imConnectStateDir,
  listImConnectTargets,
  readChannelsStore,
  resolveImConnectDir,
} from '../src/host/im-connect.js';
// 图片魔数嗅探与扩展名兜底集合抽到了 image-sniff.js：im-connect 后端也要用同一份
// 「验货」能力（发送前按内容纠正文件名后缀），放在本文件会形成循环依赖。
import { IMAGE_EXTENSIONS, sniffImageKind } from '../src/host/image-sniff.js';
import {
  detectedDebugger,
  detectedDesktopHost,
  detectedSupervisor,
  scheduleRestart,
  servingPort,
} from '../src/host/restart.js';
import { trustedLocalRequest, trustedRestartRequest } from '../src/host/http-trust.js';
// 配置文件的原子写（写临时文件 → fsync → rename）：直接 writeFile 的话，写一半崩溃会留下
// 半个 JSON，readConfig 解析失败后回默认值 —— 表现是"用户的设置无声丢失"，且查不出原因。
import { writeFileAtomic } from '../src/host/atomic-write.js';

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
  // 绝对路径：会话里的「已投递」文件卡片按它定位（客户端点击卡片时要用真实路径预览/打开）。
  absolutePath: 'string',
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
  const text = Buffer.concat(chunks, length).toString('utf8') || '{}';
  try {
    return JSON.parse(text);
  } catch (error) {
    // 打一个可识别的标：400 只该给"请求体不是合法 JSON"，不能把宿主自己的故障也归成 400。
    const wrapped = new Error(error?.message ?? 'invalid-json');
    wrapped.code = 'invalid-json';
    throw wrapped;
  }
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
 * 老用户升级后配置会「凭空消失」，而文件其实还躺在旧目录里。上个名字 dsh-imsend
 * 就是这么遗留至今的：`~/.dsh/integrations/dsh-imsend/` 至今还占着地方，没人清理。
 *
 * 规则：**目标已存在就什么都不做**（迁过了，或本来就是全新安装）。
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

async function readConfig() {
  try {
    const value = JSON.parse(await readFile(configFile(), 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch (error) {
    if (error?.code === 'ENOENT') return {};
    if (error instanceof SyntaxError) {
      // 配置文件坏了（手改错、写盘中断）：**必须能自救**。原样抛出去的话，saveConfig 也要先
      // readConfig，于是 POST /config 永远失败，设置页再也改不回来 —— 用户只能去磁盘上找文件。
      // 做法：留一份备份（用户可能想抢救），然后按空配置继续（下次保存会写出新文件）。
      const file = configFile();
      try {
        renameSync(file, `${file}.corrupt-${Date.now()}`);
      } catch {
        /* 备份失败不阻断：最坏是这份坏文件被下一次保存覆盖 */
      }
      return {};
    }
    throw error;
  }
}

/**
 * 配置写队列：`saveConfig` 是「读 → 合并 → 写」，并发两次会互相覆盖（后写赢），
 * 表现为用户快速连点两个开关时其中一个改动凭空消失。串行化读-改-写把这条窗口关掉。
 *
 * 与 `writeFileAtomic` 的分工：那边保证"不会写出半个文件"（临时文件 + rename），
 * 这边保证"不会丢掉另一次修改"。两者都要，缺一条都还能出问题。
 */
let configWriteQueue = Promise.resolve();

async function saveConfig(patch) {
  const run = configWriteQueue.then(async () => {
    const file = configFile();
    const next = { ...(await readConfig()), ...patch };
    // 原子写（见 src/host/atomic-write.js）：直接 writeFile 的话，写一半崩溃会留下半个 JSON，
    // readConfig 解析失败后 catch 回默认值 —— 表现是"用户的设置无声丢失"，而且查不出原因。
    await writeFileAtomic(file, `${JSON.stringify(next, null, 2)}\n`);
    return next;
  });
  // 队列自身不能因为某次失败而卡死：失败只影响这一次调用（错误照常抛给调用方）。
  configWriteQueue = run.then(() => {}, () => {});
  return run;
}

/** 首次加载时补上默认开关，之后一切以配置文件为准。 */
async function ensureConfig() {
  const current = await readConfig();
  const patch = {};
  if (typeof current.enabled !== 'boolean') patch.enabled = true;
  if (typeof current.imageAsPicture !== 'boolean') patch.imageAsPicture = true;
  if (typeof current.restartEnabled !== 'boolean') patch.restartEnabled = true;
  if (Object.keys(patch).length === 0) return current;
  return saveConfig(patch);
}

/**
 * GET 读开关，POST 写开关。只碰这几个字段，不动配置文件里的其他字段。
 */
async function handleConfigRequest(request, response) {
  // 同 /send-file：挡掉跨站 Origin 的 POST（篡改默认收件人/关掉功能），
  // 无 Origin 的本机脚本放行。
  if (!trustedLocalRequest(request)) {
    json(response, 403, { error: 'untrusted-origin' });
    return;
  }
  try {
    if (request.method === 'GET') {
      // 只读请求不该落盘：ensureConfig 会补默认值并写文件，一次 GET 就把 config.json 造出来。
      const settings = await readConfig();
      json(response, 200, {
        enabled: settings.enabled !== false,
        imageAsPicture: settings.imageAsPicture !== false,
        restartEnabled: settings.restartEnabled !== false,
        botId: typeof settings.botId === 'string' ? settings.botId : '',
        toUserId: typeof settings.toUserId === 'string' ? settings.toUserId : '',
        // 口令**不回明文**：这个 GET 与 /send-file 一样属于"无 Origin 的本机请求也放行"的路由，
        // 回明文等于任何同机进程都能读到口令 —— 那这道闸门就形同虚设。
        // 设置页只需要知道"设没设"；改口令走 POST（留空 = 不修改，见下）。
        // 非字符串也算"设过"：界面据此显示「清除口令」，用户才修得回来（比较逻辑那边是 fail-closed）。
        sendTokenSet: settings.sendToken !== undefined && settings.sendToken !== null && settings.sendToken !== '',
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
      json(response, 200, {
        enabled: saved.enabled !== false,
        imageAsPicture: saved.imageAsPicture !== false,
        restartEnabled: saved.restartEnabled !== false,
        // 同样只回"设没设"，不回明文（见 GET 那边的说明）：保存完设置页要能立刻
        // 把「清除口令」按钮显示出来，不必重新 GET 一次。
        sendTokenSet: saved.sendToken !== undefined && saved.sendToken !== null && saved.sendToken !== '',
        sendAllowRoots: Array.isArray(saved.sendAllowRoots) ? saved.sendAllowRoots : [],
      });
      return;
    }
    json(response, 405, { error: 'method-not-allowed' });
  } catch (error) {
    // 状态码要分清"客户端发错了"和"服务端出错了"：JSON 解析失败是前者（400），
    // 否则脚本会把它当成宿主故障去重试一个永远不可能成功的请求。
    const status = error?.message === 'payload-too-large'
      ? 413
      : (error?.code === 'invalid-json' ? 400 : 500);
    json(response, status, { error: error?.message ?? 'config-failed' });
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
  // ⚠️ 取消源必须挂在 **response** 上，不能挂 request：Node 的 `request 'close'` 在
  // 「请求体读完」时就会触发（不是"客户端断开"），于是投递还没开始就被自己 abort 成
  // client-gone —— 表现是任何能读到文件的请求**永远拿不到响应**（2026-11-11 实测复现：
  // 文件不存在时正常回 500，文件存在时 4 秒无响应）。响应写完后的 close 由上面那个判断挡掉。
  // 兼容非标准 response（测试桩、某些代理层）：没有事件接口就退化成"只在超时/断开时结束"。
  if (typeof response.once === 'function') response.once('close', onGone);
  try {
    const payload = await readJsonBody(request);
    const settings = await ensureConfig();
    if (settings.enabled === false) {
      json(response, 403, { error: 'dsh-helper 已关闭（enabled: false）' });
      return;
    }
    // 可选口令（默认关）：设了口令之后，不带口令的本机请求一律 401。
    // 这是给"不信任同机其它进程"的环境用的 —— 跨站请求本来就被 Origin 校验挡掉了。
    // 不要把非字符串归一成 ''：那等于把"配置写坏了"洗成"没设口令"，fail-open。
    // 原样交给 tokenMatches —— 它对非字符串是 fail-closed 的。
    const expectedToken = settings.sendToken;
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
    const status = error?.message === 'payload-too-large'
      ? 413
      : timedOut
        ? 504
        : (error?.code === 'invalid-json' ? 400 : 500);
    json(response, status, {
      error: timedOut
        ? `投递超时（超过 ${Math.round(SEND_TIMEOUT_MS / 60000)} 分钟未完成），已取消。文件较大或上游无响应时可重试。`
        : error?.message ?? 'send-failed',
      ...(timedOut ? { code: 'send-timeout' } : {}),
      ...(typeof error?.code === 'string' ? { code: error.code } : {}),
      ...(error?.providerCode != null ? { providerCode: String(error.providerCode) } : {}),
    });
  } finally {
    clearTimeout(timer);
    if (typeof response.off === 'function') response.off('close', onGone);
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
  let settings;
  try {
    // 只读路由不写盘，且必须自己兜底：读配置抛错会变成 unhandledRejection，连接一直挂着。
    settings = await readConfig();
  } catch (error) {
    json(response, 500, { error: error?.message ?? 'config-unreadable' });
    return;
  }
  const restartEnabled = settings.restartEnabled !== false;
  const supervisor = detectedSupervisor();
  const debuggerAttached = detectedDebugger();
  const desktopHost = detectedDesktopHost();
  let reason = null;
  // 桌面端排在 debugger / supervisor 之前：它是"这一档从根本上不该点"，
  // 而调试器/监督器是"这台机器上的偶然状态"。桌面端打开宿主调试端口时两者会同时命中，
  // 那时该告诉用户的是前者。
  if (!restartEnabled) reason = 'disabled-in-config';
  else if (desktopHost !== null) reason = 'desktop';
  else if (debuggerAttached !== null) reason = 'debugger';
  else if (supervisor !== null) reason = 'supervisor';
  json(response, 200, {
    allowed: reason === null,
    reason,
    supervisor,
    debugger: debuggerAttached,
    desktopHost,
    restartEnabled,
  });
}

/**
 * POST /api/dsh-helper/restart
 * 过五道闸：restartEnabled / detectedDesktopHost / trustedRestartRequest /
 * detectedDebugger / detectedSupervisor，通过则 scheduleRestart(port)，本进程 500ms 后自杀。
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
    // 桌面端必须排在 trustedRestartRequest **之前**：Electron 的 forwardWebRequest 转发时
    // 会剥掉 Origin，这一档在桌面端永远过不了来源闸，先判桌面端才能给出说得通的理由
    // （否则用户看到的是没头没尾的 untrusted，而按钮又是亮的）。
    if (detectedDesktopHost() !== null) {
      json(response, 403, { error: 'desktop', reason: 'desktop' });
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
  // Windows 上 `~\Downloads` 与 `~/Downloads` 都有人写：两种分隔符都认，
  // 否则整条白名单配置永远匹配不上（表现为"什么都被拒"）。
  const rest = value.slice(1);
  if (rest.startsWith('/') || rest.startsWith('\\') || rest.startsWith(sep)) {
    return join(homedir(), rest.replace(/^[\\/]+/u, ''));
  }
  return value;
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
  if (expected === undefined || expected === null || expected === '') return true; // 没设口令 = 不启用（默认关）
  // 配置里存在但不是字符串（手改成数字/布尔/数组）：这不是"没设口令"，而是"设坏了"。
  // 原来这里和 undefined 一起返回 true，等于静默 fail-open —— 改坏一个字段就把闸门拆了。
  if (typeof expected !== 'string') return false;
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
 * 从当前会话最近的入站消息里推断「该用哪个机器人、发给谁」。
 *
 * 入站消息带一段由 IM 层注入的 `<dsh_im_source>{"senderId":"…"}</dsh_im_source>`，
 * 其中的 senderId 就是这次对话的主人。拿它去 match 账号表的 ownerUserId，就能反查出
 * 该用哪个机器人回他——**不需要用户在插件配置里再抄一遍 botId / toUserId**。
 *
 * 推断失败（不是 IM 会话、或账号表里没有这个人）返回 null，调用方按老逻辑回落。
 */
function inferImTargetFromSession(session, accounts) {
  let events;
  try {
    events = typeof session?.snapshotEvents === 'function'
      ? session.snapshotEvents()
      : session?.events;
  } catch {
    return null;
  }
  if (!Array.isArray(events) || events.length === 0) return null;

  for (let i = events.length - 1; i >= 0; i -= 1) {
    const ev = events[i];
    if (ev?.type !== 'user/message') continue;
    const content = ev?.data?.content ?? ev?.data?.message?.content;
    const text = Array.isArray(content)
      ? content.map((part) => (part?.type === 'text' && typeof part.text === 'string' ? part.text : '')).join('')
      : '';
    if (!text || !text.includes('dsh_im_source')) continue;

    const matched = /<dsh_im_source>\s*(\{[\s\S]*?\})\s*<\/dsh_im_source>/.exec(text);
    if (!matched) continue;
    let senderId;
    try {
      senderId = JSON.parse(matched[1])?.senderId;
    } catch {
      continue;
    }
    if (typeof senderId !== 'string' || !senderId.trim()) continue;
    const owner = accounts.find((a) => a?.ownerUserId === senderId.trim());
    if (owner?.botId) return { botId: owner.botId, toUserId: senderId.trim() };
  }
  return null;
}

/**
 * 从 dsh-im 的账号表里挑一个：显式指定找不到就报错，配置默认值找不到则回退第一个。
 *
 * 优先级：显式参数 → 会话推断 → 配置默认值 → 第一个账号。
 * 会话推断出来的 botId 一定来自账号表本身，所以它不会"落空"，也就不需要额外的回退分支。
 *
 * 为什么要区分"显式"与"配置"：`botId` 这一个字段被两个后端共用，而两套 id 体系不同
 * （im-connect 用 channels 的 key，dsh-im 用 `wx_…`）。配置里填的默认值很可能属于另一个后端，
 * 那种情况下静默拿它发 = 发错人；直接抛错又会让原本能用的投递整个失效 ——
 * 所以只有**明确点名**的账号才报错。
 *
 * @param {Array<{botId?: string}>} accounts - dsh-im 的账号表。
 * @param {{explicitBotId?: string, inferredBotId?: string, configuredBotId?: string}} wanted - 三层来源。
 * @param {any} [logger] - 宿主 logger（回退时记一条 warn）。
 * @returns {{botId?: string}} 选中的账号。
 */
export function pickDshImAccount(accounts, { explicitBotId = '', inferredBotId = '', configuredBotId = '' } = {}, logger) {
  const list = Array.isArray(accounts) ? accounts : [];
  const byBotId = (id) => (id ? list.find((account) => account?.botId === id) : undefined);
  if (explicitBotId !== '') {
    const chosen = byBotId(explicitBotId);
    // 模型按用户要求点名的账号不存在：绝不静默退回第一个（那正是"发错人"的来源）。
    if (chosen === undefined) {
      throw new Error(`dsh-im 里没有名为 ${explicitBotId} 的微信账号：先调 list_im_targets 确认真实账号，再显式传 botId。`);
    }
    return chosen;
  }
  const inferred = byBotId(inferredBotId);
  if (inferred !== undefined) return inferred;
  if (configuredBotId !== '') {
    const configured = byBotId(configuredBotId);
    if (configured !== undefined) return configured;
    logger?.warn?.(`[dsh-helper/dsh-im] 配置里的 botId（${configuredBotId}）不在 dsh-im 的账号里`
      + '（它可能属于另一个 IM 后端），已改用第一个账号。');
  }
  return list[0];
}

/**
 * 挑 dsh-im 后端的收件人。
 *
 * 优先级：显式参数 → 会话推断（同一账号时）→ 配置默认值 → 账号主人。
 *
 * ⚠️ 配置里的 `toUserId` **只属于配置里那个账号**：一旦模型按用户要求换了账号
 * （显式 botId 指向另一个 bot），还拿配置里的收件人去发，就会发到"上一个人"的微信上。
 * 这是多账号场景最阴的一类错：不报错、对方也收得到，只是收错了人。
 *
 * @param {{botId?: string, ownerUserId?: string}} account - 已选中的账号。
 * @param {{explicitToUserId?: string, inferredToUserId?: string, inferredBotId?: string, configuredBotId?: string, configuredToUserId?: string}} wanted
 * @returns {string} 收件人（空串 = 没有可用收件人）。
 */
export function pickDshImRecipient(account, {
  explicitToUserId = '', inferredToUserId = '', inferredBotId = '', configuredBotId = '', configuredToUserId = '',
} = {}) {
  const sameAsConfigured = configuredBotId === '' || account?.botId === configuredBotId;
  return explicitToUserId
    || (inferredToUserId !== '' && inferredBotId === account?.botId ? inferredToUserId : '')
    || (sameAsConfigured ? configuredToUserId : '')
    || (typeof account?.ownerUserId === 'string' ? account.ownerUserId : '')
    || '';
}

/**
 * dsh-im 后端：把文件投递到微信。
 *
 * 全程只用 dsh-im 的原生接口（sendFile 在 weixin-api.mjs:777），本插件不复制协议。
 * 文件已由 deliverFile 读完并校验过大小时才进来。
 */
async function deliverViaDshIm({
  credentials, settings, absolutePath, bytes, signal, logger, session,
}) {
  const dshImDir = resolveDshImDir(settings.dshImDir);
  const { api, state, config } = await loadWeixinModules(dshImDir);

  const dir = weixinDir();
  const accountStore = await new config.WeixinConfigStore(join(dir, 'config.json')).load();
  // 优先级：显式参数 → 当前会话推断 → 配置默认值 → 第一个账号。
  // 会话推断排在配置之前，是因为「谁在跟我说话」比「设置里填过谁」更精确：
  // 在有 IM 来源的会话里，默认就该回给那个发消息的人。
  const inferred = inferImTargetFromSession(session, accountStore.list());
  const account = pickDshImAccount(accountStore.list(), {
    explicitBotId: typeof settings.explicitBotId === 'string' ? settings.explicitBotId.trim() : '',
    inferredBotId: typeof inferred?.botId === 'string' ? inferred.botId : '',
    configuredBotId: typeof settings.botId === 'string' ? settings.botId.trim() : '',
  }, logger);

  if (!account?.botId) {
    throw new Error('没有可用的微信机器人账号，请先在「设置 → IM机器人」里接入微信。');
  }
  if (!account.baseUrl) throw new Error('微信机器人缺少 baseUrl，请重新接入。');

  const token = credentialValue(await credentials.resolve(account.tokenRef));
  if (!token) {
    throw new Error('微信机器人凭据缺失，请在「设置 → IM机器人」里移除后重新接入。');
  }

  const toUserId = pickDshImRecipient(account, {
    explicitToUserId: typeof settings.explicitToUserId === 'string' ? settings.explicitToUserId.trim() : '',
    inferredToUserId: typeof inferred?.toUserId === 'string' ? inferred.toUserId : '',
    inferredBotId: typeof inferred?.botId === 'string' ? inferred.botId : '',
    configuredBotId: typeof settings.botId === 'string' ? settings.botId.trim() : '',
    configuredToUserId: typeof settings.toUserId === 'string' ? settings.toUserId.trim() : '',
  });
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

/**
 * dsh-im 的账号清单（只读）。
 *
 * 返回 `{ accounts, reason }`：**读不动要能说出原因**（文件坏了 vs 没接入），
 * 否则用户看到的永远是"没有已接入的微信账号"，然后跑去重连一遍微信——而真正坏的是配置文件。
 */
function readDshImAccounts() {
  const file = join(weixinDir(), 'config.json');
  try {
    const body = JSON.parse(readFileSync(file, 'utf8'));
    const accounts = Array.isArray(body?.accounts) ? body.accounts : [];
    return {
      accounts: accounts
        .filter((account) => typeof account?.botId === 'string' && account.botId !== '')
        .map((account) => ({
          backend: 'dsh-im',
          botId: account.botId,
          name: typeof account.name === 'string' ? account.name : '',
          ownerUserId: typeof account.ownerUserId === 'string' ? account.ownerUserId : '',
          enabled: true,
        })),
      reason: '',
    };
  } catch (error) {
    if (error?.code === 'ENOENT') return { accounts: [], reason: '' };
    return { accounts: [], reason: `账号配置读不了（${file}）：${error?.message ?? error}` };
  }
}

/**
 * 列出本机所有可用的投递目标（后端 × 账号）。
 *
 * 为什么需要它：一台机器可能同时装着两个 IM 插件、各自又接了多个机器人账号，而
 * `botId`/`toUserId` 只有一套默认值。用户说"发我微信"时，模型必须先看清有哪些账号，
 * 才能决定是直接用、还是问一句、还是明确报错——靠猜必然发错人。
 *
 * 全程只读：两个后端都是明文 JSON，不需要凭据、不发起任何网络请求。
 *
 * `isConfigured` 只对**同后端**的账号有意义：两套 id 体系不同（im-connect 用 channels 的 key，
 * dsh-im 用 `wx_…`），配置里的 botId 在另一个后端里通常根本不存在。
 *
 * @param {object} [settings] - 本插件 config.json（用来标出"当前默认"）。
 * @returns {{backend: string, targets: Array<object>, notices: Array<{backend: string, reason: string}>}}
 */
export function listImTargets(settings = {}) {
  const targets = [];
  const notices = [];
  try {
    // resolveImConnectDir 只确认包在不在；账号数据在 im-connect 自己的状态目录里。
    resolveImConnectDir(settings.imConnectDir);
    // 直接读 store（而不是调 listImConnectTargets）是为了拿到**真实的失败原因**：
    // channels.json 坏掉时上层不该报成"没有已接入的微信账号"。
    // 先探一次可读性：channels.json 坏掉时会在这里抛出带路径与原因的错，进 notices，
    // 而不是让上层笼统地报"没有已接入的微信账号"。
    readChannelsStore(imConnectStateDir());
    const list = listImConnectTargets();
    if (list.length === 0) notices.push({ backend: 'im-connect', reason: '没有已接入的微信账号' });
    targets.push(...list);
  } catch (error) {
    notices.push({ backend: 'im-connect', reason: error?.message ?? String(error) });
  }
  const dshIm = readDshImAccounts();
  if (dshIm.accounts.length === 0) {
    notices.push({ backend: 'dsh-im', reason: dshIm.reason || '没有已接入的微信账号' });
  }
  targets.push(...dshIm.accounts);

  const configuredBotId = typeof settings.botId === 'string' ? settings.botId.trim() : '';
  const configuredToUserId = typeof settings.toUserId === 'string' ? settings.toUserId.trim() : '';
  const short = (value) => (value.length > 12 ? `${value.slice(0, 10)}…` : value);
  return {
    backend: detectDeliveryBackend(settings),
    targets: targets.map((target) => ({
      backend: target.backend,
      botId: target.botId,
      ownerUserId: target.ownerUserId,
      enabled: target.enabled !== false,
      label: [
        target.backend,
        target.name || short(target.botId),
        target.ownerUserId ? `主人 ${short(target.ownerUserId)}` : '',
      ].filter((part) => part !== '').join(' · '),
      isConfigured: target.botId === configuredBotId
        || (configuredToUserId !== '' && target.ownerUserId === configuredToUserId),
    })),
    notices,
  };
}

/**
 * 多账号歧义防线：同一个后端里有多个可用账号、而调用方与配置都没点名时，直接拒绝。
 *
 * 放在 deliverFile（而不是只有工具入口）是必须的：`POST /send-file` 是"老会话拿不到工具时"
 * 的兜底入口，只守工具那条路等于把最容易脚本化、也最容易发错人的入口漏掉。
 *
 * @param {object} settings - 本插件配置（含 explicitBotId / explicitToUserId）。
 */
function assertUnambiguousTarget(settings) {
  const explicitBotId = typeof settings?.explicitBotId === 'string' ? settings.explicitBotId.trim() : '';
  const explicitToUserId = typeof settings?.explicitToUserId === 'string' ? settings.explicitToUserId.trim() : '';
  const configuredBotId = typeof settings?.botId === 'string' ? settings.botId.trim() : '';
  const configuredToUserId = typeof settings?.toUserId === 'string' ? settings.toUserId.trim() : '';
  // 只有真正"说了算"的默认值才算数：配置里写了 botId 或 toUserId 就放行（老用户行为不变）。
  if (explicitBotId !== '' || explicitToUserId !== '' || configuredBotId !== '' || configuredToUserId !== '') return;
  const probe = listImTargets(settings);
  // 只按"**同一个后端**里账号数 > 1"判定：两个后端各一个账号不算歧义（auto 只会选其中一个）。
  const counts = new Map();
  for (const target of probe.targets) {
    if (target.enabled === false) continue;
    if (probe.backend !== '' && target.backend !== probe.backend) continue;
    counts.set(target.backend, (counts.get(target.backend) ?? 0) + 1);
  }
  const ambiguous = [...counts.values()].some((count) => count > 1);
  if (!ambiguous) return;
  const usable = probe.targets.filter((target) => target.enabled !== false
    && (probe.backend === '' || target.backend === probe.backend));
  throw new Error(`本机有 ${usable.length} 个可用的微信账号（${usable.map((target) => target.label).join('；')}），`
    + '但配置里没有默认收件人：先调 list_im_targets 让用户选一个，再把该账号的 botId 一并传进来。');
}

/** 核心：把文件投递到 IM。后端选好后各自投递，本函数只负责「读文件 + 分派」。 */
async function deliverFile({
  credentials, settings, filePath, workspace, signal, logger, session,
}) {
  // 白名单在这里归一化（一次 realpath），再交给唯一的读文件收口点。
  const { absolutePath, bytes } = await readDeliveryFile(
    filePath, workspace, normalizeAllowRoots(settings?.sendAllowRoots),
  );
  signal?.throwIfAborted();
  // 读文件之后再判歧义：文件不存在/超限这类错误更具体，不该被"多账号"盖掉。
  assertUnambiguousTarget(settings);
  const backend = resolveDeliveryBackend(settings);
  const result = backend.id === 'im-connect'
    ? await deliverViaImConnect({ credentials, settings, absolutePath, bytes, signal, logger })
    : await deliverViaDshIm({ credentials, settings, absolutePath, bytes, signal, logger, session });
  // 两个后端都只回投递结果；绝对路径由这里补上（工具回执与交付卡片都要它）。
  return { ...result, absolutePath };
}

/**
 * 在会话里登记一次「已投递」的交付物。
 *
 * 复用**官方交付物事件**（`deliverables/presented`，与 `present` 工具同一个）：
 * 客户端 `@deepseek-ai/dsh-client-ui-deliverables` 会把它渲染成回合末尾的文件卡片，
 * 卡片上带文件名与一句说明，点开能在右侧预览、也能用默认应用打开。
 *
 * 为什么要这一步：投递成功以前只在工具行里留一行文字，用户回头翻对话时看不到
 * "到底发了哪几个文件"；WS 那侧（微信）已经收到，对话里却没有可点的凭证。
 *
 * 三个前提缺一不可，缺了就地放弃（卡片是锦上添花，不能影响投递本身）：
 *   · 有会话（HTTP `/send-file` 入口没有会话，理应不产卡片）；
 *   · 拿得到 `agents.turnBoundaryOf(session).lastTurn`（客户端要求 turn >= 1 才会渲染）；
 *   · 回执里带 absolutePath。
 *
 * 事件数据形状必须满足客户端 `isPresentedData`：`{ turn: int>=1, callId: 非空串, files: array }`。
 *
 * @param {object} options
 * @param {any} options.session - 会话对象（`exec.agent.session`）。
 * @param {string} [options.callId] - 本次工具调用 id（客户端按它去重/定位）。
 * @param {any} options.agents - 拿到 agents 服务的注入上下文（可选）。
 * @param {any} options.result - deliverFile 的回执。
 * @param {string} [options.recipient] - 收件人描述，写进卡片说明。
 * @param {number} [options.turn] - 调用方在 execute 时就取好的轮次（首选；与官方 present 同步取数）。
 * @returns {boolean} 是否真的登记了卡片。
 */
export function appendDeliveryCard({ session, callId, agents, result, recipient, turn: turnHint }) {
  try {
    if (session === undefined || typeof session?.append !== 'function') return false;
    if (typeof callId !== 'string' || callId === '') return false;
    const path = typeof result?.absolutePath === 'string' ? result.absolutePath : '';
    if (path === '' || result?.sent !== true) return false;
    // turn 优先用 execute 时取好的那个：官方 present 也是在 execute 里取、在 tools/result 里写，
    // 这样两个时刻即使跨了轮边界（理论上不会），写的也是**发起调用的那一轮**。
    const turn = Number.isSafeInteger(turnHint) && turnHint >= 1
      ? turnHint
      : agents?.turnBoundaryOf?.(session)?.lastTurn;
    if (!Number.isSafeInteger(turn) || turn < 1) return false;
    const viaText = DELIVERY_VIA_TEXT[result.via] ?? '文件';
    const who = typeof recipient === 'string' && recipient !== '' ? recipient : result.toUserId;
    const description = who
      ? `已投递到微信（${who}，${viaText}，平台已受理）`
      : `已投递到微信（${viaText}，平台已受理）`;
    session.append('deliverables/presented', {
      turn,
      callId,
      files: [{ path, description }],
    });
    return true;
  } catch (error) {
    // 登记失败只记一条日志：投递此时已经成功，不能因为卡片把结果翻成失败。
    console.warn('[dsh-helper] 已投递文件卡片登记失败（投递本身已成功）：', error?.message ?? error);
    return false;
  }
}

/**
 * 当前这次 section 渲染是不是在给**子会话**（subagent）写 system prompt。
 *
 * 判据与 T专家 的 `t-team:experts` 小节完全一致：宿主传进来的 context 里，
 * 子会话的 `agent.session.header.parentSession` 有值。
 *
 * 为什么这段引导要对子会话闭嘴：
 *   · 「该不该把文件发到用户微信」是**用户级**决定，要由主会话和用户商量着来。
 *     子会话拿到这段只是白占 token，更糟的是可能被诱导自作主张把中间产物直接发进用户微信 ——
 *     那是有持久副作用的动作，不是"多写一句"那么便宜。
 *   · 子会话真要发文件也发得了：工具本身仍在它的工具表里，这里省掉的只是"怎么选用"的引导。
 */
function isChildSession(context) {
  return context?.agent?.session?.header?.parentSession !== undefined;
}

export function apply(ctx) {
  // 改名迁移必须排在任何读盘之前：configFile() 按新目录名拼路径，
  // 先把旧目录搬过来，老用户的数据才接得上。
  ensureDataDirMigrated(ctx.logger);

  if (typeof ctx?.inject !== 'function') {
    ctx.logger?.warn?.('[dsh-helper] ctx.inject 不可用，插件未激活。');
    return;
  }

  /**
   * agents 服务的**可选**取用：会话交付卡片要拿 `turnBoundaryOf(session).lastTurn`。
   *
   * 不写进下面 tools 注入的依赖列表是有意的 —— 那会让"宿主没有 agents 服务"升级成
   * "整个工具都注册不上"。拿不到就只是不出卡片，投递照常。
   */
  const agentServices = { current: undefined };
  ctx.inject(['agents'], (agentCtx) => { agentServices.current = agentCtx; });

  /**
   * 待登记的交付卡片：按工具执行上下文索引，等这一批调用落定后再写会话事件。
   *
   * 为什么要等：官方 `present` 工具同样在 `tools/result` 观察器里 append，而不是在 execute
   * 里就写。一是拿到 `result.isError`（失败/中断不该留"已投递"卡片），二是让事件顺序与官方
   * 一致（客户端投影按顺序累积，交付事件排在 tool/result 之后才不会被当成同一调用的中间态）。
   */
  const pendingCards = new WeakMap();
  if (typeof ctx.on === 'function') {
    ctx.on('tools/result', (exec, eventResult) => {
      const delivery = exec !== undefined && typeof exec === 'object' ? pendingCards.get(exec) : undefined;
      if (delivery !== undefined) pendingCards.delete(exec);
      if (delivery === undefined || eventResult?.isError === true) return;
      appendDeliveryCard({ ...delivery, agents: agentServices.current?.agents });
    });
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
        handler: (request, response) => handleConfigRequest(request, response),
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
      description: '把一个本机文件通过 IM（微信）主动发送给指定私聊目标。图片/视频自动走图片/视频消息（对方在微信里可直接预览），其他文件以文件形式发送。它在调用内真正完成上传与发送，不依赖当前会话是否绑定 IM，因此从 DSH 对话框发起的会话也能用。成功只代表平台已受理。投递成功后会在本轮对话末尾为该文件生成一张交付卡片（可点开预览或打开），因此回执里也要把结果说清楚。收件人不确定时（本机可能有多个微信账号）先调 list_im_targets，别靠猜。',
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
          botId: {
            type: 'string',
            description: '可选：用哪个微信机器人账号发送（如 wx_97dda58120f44f44ffa50e8e）。'
              + '省略时用 config.json 里的 botId，再退回第一个账号。'
              + '**要投递给另一个微信绑定（另一个机器人账号的用户）时必须指定**——'
              + '否则会从第一个机器人发出，跨机器人投递会被平台静默丢弃。',
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
            ? `已投递 ${value.fileName}（${value.bytes} 字节）到微信${value.toUserId ? `（${value.toUserId}）` : ''}：`
              + `${DELIVERY_VIA_TEXT[value.via] ?? '文件'}消息，平台已受理。`
            : `投递 ${value.fileName} 失败，请查看 DSH 日志里的原因。`,
        }],
      },
      async execute(args, exec) {
        const settings = await ensureConfig();
        if (settings.enabled === false) {
          throw new Error('文件投递当前是关闭状态（config.json 的 enabled: false）：'
            + '在「插件列表 → 辅助补丁」的设置卡片里打开「允许把文件投递到 IM」即可恢复。');
        }

        // 显式参数单独带下去：它必须压过「会话推断」和「配置默认值」。
        const explicitToUserId = typeof args?.toUserId === 'string' ? args.toUserId.trim() : '';
        const explicitBotId = typeof args?.botId === 'string' ? args.botId.trim() : '';

        const workspace = exec?.agent?.session?.header?.cwd;
        const result = await deliverFile({
          credentials: imCtx.credentials,
          // 后端目录（dshImDir / imConnectDir）已经随 ...settings 展开（来自 config.json），
          // 不需要再从 apply 的第二参数里拼一次——那个参数以前根本没被 DSH 传进来。
          settings: { ...settings, explicitToUserId, explicitBotId },
          filePath: args?.path,
          workspace: typeof workspace === 'string' && workspace ? workspace : undefined,
          signal: exec?.signal,
          logger: imCtx.logger,
          session: exec?.agent?.session,
        });
        // 投递成功后，把文件作为**交付物**登记进会话：客户端据此在回合末尾渲染文件卡片
        // （与 present 同一个事件），用户回头能看到"这次到底发了哪个文件、发到哪个微信"。
        //
        // 登记**推迟到 tools/result 之后**（见 apply 里那个观察器）：官方 present 工具也是这个
        // 时序 —— 在 execute 里直接 append 会让交付事件排在 tool/result 之前，而客户端的轮次
        // 投影是按事件顺序累积的。失败与中断由观察器那一侧跳过。
        if (exec !== undefined && typeof exec === 'object') {
          const session = exec?.agent?.session;
          let turn;
          try {
            turn = agentServices.current?.agents?.turnBoundaryOf?.(session)?.lastTurn;
          } catch {
            // 取不到 turn 就不出卡片（投递已经成功，卡片只是锦上添花）。
            turn = undefined;
          }
          pendingCards.set(exec, { session, callId: exec?.callId, result, recipient: result.toUserId, turn });
        }
        return result;
      },
    });

    // ---- 只读的投递目标清单 ----
    // 一台机器可能装两个 IM 插件、各自多个机器人账号，而 botId/toUserId 只有一套默认值。
    // 模型不先看清有哪些账号，就只能靠猜——猜错不会报错，只会发到另一个人微信上。
    imCtx.tools.register({
      name: 'list_im_targets',
      description: '列出本机可用的微信投递目标（后端 × 账号 × 主人），只读，不发任何消息。'
        + '当用户说「发我微信」「发到微信」而本机可能接了多个机器人账号时先调它：'
        + '只有 1 个可用账号就直接用；多个就把 label 给用户选一次（可用 ask_user_question），'
        + '选定后把该账号的 botId 传给 send_file_to_im。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {},
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            backend: { type: 'string' },
            targets: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  backend: { type: 'string' },
                  botId: { type: 'string' },
                  ownerUserId: { type: 'string' },
                  enabled: { type: 'boolean' },
                  label: { type: 'string' },
                  isConfigured: { type: 'boolean' },
                },
                required: ['backend', 'botId', 'label'],
              },
            },
            notices: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  backend: { type: 'string' },
                  reason: { type: 'string' },
                },
                required: ['backend', 'reason'],
              },
            },
          },
          required: ['backend', 'targets'],
        },
        render: (_args, value) => [{
          type: 'text',
          text: value.targets.length === 0
            ? '没有检测到可用的微信账号：先在 IM 插件里接入微信。'
            : `可用投递目标（当前后端：${value.backend || '未探测到'}）：\n`
              + value.targets.map((target) => `· ${target.label}`
                + `${target.isConfigured ? '（当前默认）' : ''}`
                + `${target.enabled === false ? '（已停用）' : ''}`
                + ` — botId: ${target.botId}`).join('\n'),
        }],
      },
      async execute() {
        // 只读工具不该产生副作用：这里用 readConfig（不补默认值、不写盘），
        // 且配置读坏了也照样能列出账号 —— 用户正需要这份清单去修。
        const settings = await readConfig().catch(() => ({}));
        return listImTargets(settings);
      },
    });

    if (typeof imCtx?.systemPrompt?.section === 'function') {
      imCtx.systemPrompt.section({
        name: 'dsh-helper:send-file',
        order: 116,
        // 子会话不给这段（见 isChildSession）：text 因此从静态字符串改成函数形式。
        text: (context) => (isChildSession(context) ? '' : `当用户要求把某个文件"发到我微信 / 发到 IM / 发给我"时，按当前会话的来源分两种走法：

· 会话**由 IM 消息触发**（消息来自微信等渠道）→ 直接用 present 交付该文件，**不要再调 ${TOOL_NAME}**：IM 插件会在回合结束时自己把它回传，再调工具等于同一个文件发两遍；
· 其他会话（从 DSH 对话框、CLI 发起的会话）→ 调用 ${TOOL_NAME} 并给出文件路径（绝对路径，或相对当前工作区的路径），它在调用内真正完成上传与发送，不依赖当前会话是否绑定 IM。

调用要点：
· 一次一个文件：要发多个就逐个调用；文件不存在、是目录、或超过 200 MiB 会在读取前直接报错，不需要你提前检查存在性或大小；
· 收件人默认是该微信账号绑定的用户本人，用户明确指定了别人时才传 toUserId；
· 图片/视频会按内容自动走图片/视频消息（文件名不对也会被纠正），不需要你操心格式或改名。

回执与失败（**必须在正文里写出来，不能调完工具一句话都不说**）：
· 成功：用一句话说明「哪个文件、发到哪个微信、走的图片/文件消息、平台已受理」，例如「已把 report.pdf 发到你的微信（文件消息，平台已受理），对话末尾也有可点开的文件卡片」。sent: true 只代表**平台已受理**，不等于对方已读，不要说"已送达"；
· 失败：把错误信息里给出的下一步转述给用户（例如"先在微信里给机器人发一条消息再重试"），**不要立刻原样重试**——需要用户先在微信侧动作的错误，重试只会再失败一次；
· 一次调用一个文件：发多个就逐个调用、逐个说明，不要合并成一句含糊的"已发送"。

收件人不确定时先查再问（本机可能接了多个机器人账号，botId/toUserId 只有一套默认值）：
· 用户说「发我微信」「发到微信」这类没点明具体账号的话时，先调 list_im_targets 看清单；
· 清单里只有 1 个可用账号 → 直接用，不要再问；
· 有多个账号 → 用 ask_user_question 让用户选一次（options 用清单里的 label，标着「当前默认」的那个放第一个并注明），选定后把它的 botId 传给 send_file_to_im；**不要自己猜、也不要默认拿第一个发**——发错人不会报错，只会悄悄发到另一个人微信上；
· 用户已经点名了（例如「发屠夫哥哥微信」）而清单里对不上号 → 先用 ask_user_question 确认是哪一个，别把名字硬套到某个账号上。

两个禁止：
· 不要用 dsh_im_return_file 一类的"登记待取"工具代替：那种工具只在会话由 IM 消息触发时才有消费者，从对话框发起时会静默丢失；
· 若用户只是想在当前对话里拿到文件（不是发微信），用对话内交付方式（例如 present）即可。`),
      });
    }
  });
}