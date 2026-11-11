/**
 * im-connect 后端：只读复用 @michengai/dsh-im-connect 的微信通道，把文件主动投递到 IM。
 *
 * 为什么会有第二套后端：辅助补丁原先读的是 @xmanrui/dsh-im 的 `src/channels/weixin/*.mjs`，
 * 由我们自己串「读文件 → 上传 → 发送」。用户换成 @michengai/dsh-im-connect 之后那条路径整体
 * 消失，但上游把整条链路封成了一个工厂 —— `lib/channels/weixin.js` 的
 * `createWeixinChannel(config, log, stateDir)` 返回的通道自带 `sendFile(chatId, { name, data })`，
 * 内部完成「按扩展名分图片/视频/文件 → CDN AES 加密上传 → 带 context_token 发送」。
 *
 * 设计原则与旧后端一致：**不改上游一行源码，只读 import 它的模块**。这里只做两件事：
 * 找到账号与凭据，造一个「只发不收」的通道实例。
 *
 * 关键约束：**绝不调 channel.start()**。start() 会起一个长轮询，而宿主里已经有一个真正在跑的
 * 通道（im-connect 的 ChannelManager），两个 poller 抢同一个微信账号会互相顶掉上下文。
 * 出站路径需要的东西（botToken、stateDir 下的 wechat-state.json）构造时就已读好，与轮询无关。
 *
 * 上游改内部结构时这里会明确报错（见 loadImConnectModules），而不是静默失效。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  correctOutgoingImageName,
  extensionOf,
  IMAGE_EXTENSIONS,
} from './image-sniff.js';

/** 上游包名：探测目录与错误提示都用它。 */
export const IM_CONNECT_PACKAGE = '@michengai/dsh-im-connect';

/** 相对包根的模块位置（探测与加载共用一处，改了只改这里）。 */
const WEIXIN_MODULE = 'lib/channels/weixin.js';
const CREDENTIALS_MODULE = 'lib/engine/credentials.js';

function dshHome() {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh');
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

/** im-connect 的数据根：账号配置（channels.json）与各账号登录态都在这。 */
export function imConnectStateDir(home = dshHome()) {
  return join(home, 'dsh-im-connect');
}

/**
 * 账号状态目录。
 *
 * 规则取自上游 `ChannelManager.accountStateDir`：账号 id 恰好等于渠道名时用
 * `stateDir/<渠道>`（老配置的账号 id 就是 'weixin'），否则用 `stateDir/accounts/<账号 id>`。
 * 复刻这一行是因为我们在构造通道时要把同一个目录传给它 —— 传错了它就读不到 context_token。
 */
export function imConnectAccountDir(stateDir, accountId, platform) {
  return accountId === platform ? join(stateDir, platform) : join(stateDir, 'accounts', accountId);
}

/**
 * 当前宿主用的是哪个 profile 目录。
 *
 * 宿主命令行形如 `<node> <dsh-host>/lib/index.js <dsh> <profileDir> <runtime…>`，profile 路径就在
 * argv 里。拿它是为了**优先复用本 profile 装的那份 IM 插件**：同一台机器上两个 profile 各装一个
 * IM 插件（或装同一插件的不同版本）时，跨 profile 复用会拿到与宿主运行时不一致的副本。
 * 猜不出来就返回 undefined，调用方退回「扫所有 profile」。
 */
export function currentProfileDir(argv = process.argv, home = dshHome()) {
  const prefix = `${join(home, 'profiles')}/`;
  for (const arg of argv) {
    if (typeof arg !== 'string') continue;
    const value = arg.replace(/\/+$/, '');
    if (value.startsWith(prefix) && !value.slice(prefix.length).includes('/')) return value;
  }
  return undefined;
}

/**
 * 候选安装目录，按优先级：显式配置 → **当前 profile** → 其它 profile（web / desktop 排前面，
 * 因为同一份插件被多个 profile 装时这两个才是真实在跑的）。
 *
 * profile 名是用户自定的，所以除了已知的两个之外一律扫目录，而不是写死。
 */
export function imConnectCandidates(
  configured,
  home = dshHome(),
  profileDir = currentProfileDir(process.argv, home),
) {
  const pkgPath = IM_CONNECT_PACKAGE.split('/');
  const list = [configured];
  if (typeof profileDir === 'string' && profileDir.trim() !== '') {
    list.push(join(profileDir, 'node_modules', ...pkgPath));
  }
  const profiles = join(home, 'profiles');
  let names = [];
  try {
    names = readdirSync(profiles);
  } catch {
    names = [];
  }
  const rank = (name) => (name === 'web' ? 0 : name === 'desktop' ? 1 : 2);
  for (const name of [...names].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))) {
    list.push(join(profiles, name, 'node_modules', ...pkgPath));
  }
  const seen = new Set();
  return list.filter((value) => {
    if (typeof value !== 'string' || value.trim() === '') return false;
    const key = resolve(value);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * 找到 im-connect 的安装目录（必须真含微信通道模块，否则只算一个同名目录）。
 *
 * @param configured - config.json 里的 imConnectDir（可空）。
 * @param home - DSH 数据根（测试用）。
 * @param profileDir - 当前 profile 目录（不传就自己从 argv 猜）。
 */
export function resolveImConnectDir(
  configured,
  home = dshHome(),
  profileDir = currentProfileDir(process.argv, home),
) {
  const candidates = imConnectCandidates(configured, home, profileDir);
  for (const dir of candidates) {
    if (existsSync(join(dir, WEIXIN_MODULE))) return dir;
  }
  throw new Error(
    `找不到 ${IM_CONNECT_PACKAGE} 的位置。请确认它已装进 DSH profile，`
    + '或在 dsh-helper 的 config.json 里设置 imConnectDir 指向它的目录。'
    + `（找过：${candidates.join('、') || '无候选'}）`,
  );
}

/** 按文件路径 import 一个上游模块；用绝对路径，绕开包 exports 对子路径的限制。 */
function loadModule(baseDir, file) {
  return import(new URL(file, pathToFileURL(`${baseDir}/`)).href);
}

/**
 * 加载 im-connect 的微信通道与凭据模块。只读 import，不写、不改它的任何文件。
 * 它换模块路径或改导出名时这里抛错，提示很明确。
 */
export async function loadImConnectModules(dir) {
  let weixin;
  let credentials;
  try {
    [weixin, credentials] = await Promise.all([
      loadModule(dir, WEIXIN_MODULE),
      loadModule(dir, CREDENTIALS_MODULE),
    ]);
  } catch (error) {
    throw new Error(
      `加载 ${IM_CONNECT_PACKAGE} 的模块失败（${join(dir, WEIXIN_MODULE)}）：${messageOf(error)}。`
      + `${IM_CONNECT_PACKAGE} 可能改了内部结构，请更新 dsh-helper。`,
    );
  }
  if (typeof weixin?.createWeixinChannel !== 'function') {
    throw new Error(
      `${IM_CONNECT_PACKAGE} 的 ${WEIXIN_MODULE} 没有导出 createWeixinChannel：`
      + `${IM_CONNECT_PACKAGE} 可能改了内部结构，请更新 dsh-helper。`,
    );
  }
  return { weixin, credentials };
}

/**
 * 从 channels.json 里挑一个微信账号。
 *
 * 不给 wantedId 时取第一个「已启用」的微信账号；给了就必须命中，**不做静默退回** ——
 * 否则用户指定了一个已删掉的账号，文件会发给另一个账号上的人。
 *
 * @param store - channels.json 解析后的对象。
 * @param wantedId - 配置里的 botId（这里是 im-connect 的账号 id，如 weixin_a50bc9312964）。
 * @returns `{ id, platform, enabled, config }`，没有可用账号时 undefined。
 */
export function pickWeixinAccount(store, wantedId) {
  const channels = store?.channels;
  if (!channels || typeof channels !== 'object') return undefined;
  const want = typeof wantedId === 'string' ? wantedId.trim() : '';
  if (want !== '') {
    const account = channels[want];
    if (!account || account.platform !== 'weixin') {
      throw new Error(`im-connect 里没有名为 ${want} 的微信账号，请检查配置里的 botId。`);
    }
    return {
      id: want,
      platform: 'weixin',
      enabled: account.enabled !== false,
      config: account.config ?? {},
    };
  }
  for (const [id, account] of Object.entries(channels)) {
    if (account?.platform === 'weixin' && account.enabled !== false) {
      return { id, platform: 'weixin', enabled: true, config: account.config ?? {} };
    }
  }
  return undefined;
}

/**
 * 凭据名。上游规则是 `im_connect_<账号 id>_<字段>` 再把非 POSIX 标识符字符换成下划线
 * （lib/engine/credentials.js 的 credentialRef）。优先用上游那个函数，只有它没导出时才用
 * 本地等价实现 —— 免得上游改了命名规则，我们还在拼旧名字。
 */
export function credentialRefFor(credentialsModule, channelId, key) {
  if (typeof credentialsModule?.credentialRef === 'function') {
    return credentialsModule.credentialRef(channelId, key);
  }
  return `im_connect_${channelId}_${key}`.replace(/[^A-Za-z0-9_]/g, '_');
}

/**
 * 把上游抛出的错误翻译成可操作的中文。
 *
 * 与旧后端（dsh-im 抛带 code 的结构化错误）不同，这里拿到的是通道内部抛出的普通 Error，
 * 信息都在文本里：`weixin /ilink/bot/sendmessage ret=-2 errcode=0 errmsg=prepare failed`、
 * `CDN 上传失败: HTTP 413` 之类，所以按文本解析。
 *
 * -2（iLink 的 `prepare failed`）的措辞沿用旧后端的结论：腾讯协议里只定义了 -14（token 失效）
 * 而没有定义 -2，社区实测都指向「缺少活跃的用户会话上下文」，所以不写成「频率限制」，
 * 也不断言原因，只给「先去微信里发一条消息再重试」这个可执行动作。
 * -14 有明确定义（bot token 失效），直接让用户重连微信。
 */
export function describeImConnectFailure(error, { stateAgeMinutes } = {}) {
  const message = messageOf(error);
  const ret = /ret=(-?\d+)/.exec(message)?.[1];
  const errcode = /errcode=(-?\d+)/.exec(message)?.[1];
  const code = ret !== undefined ? ret : (errcode !== undefined ? errcode : '');
  const suffix = code !== '' ? `（上游错误码 ${code}）` : '';
  const age = Number.isFinite(stateAgeMinutes)
    ? `本地登录态最后写入于 ${stateAgeMinutes} 分钟前。`
    : '';

  let text = null;
  if (code === '-14') {
    text = `微信机器人凭据已失效${suffix}：请到 im-connect 的账号设置里重新连接微信。`;
  } else if (code === '-2' || /prepare failed/i.test(message)) {
    text = `微信拒绝了这条消息${suffix}：这个错误不区分原因，可能是会话上下文过期、发送额度用尽，`
      + `或消息内容被拒。${age}其中最可能是上下文过期 —— 微信只在机器人「收到消息」时才刷新它。`
      + '请先在微信里给机器人发一条任意消息，然后立刻重试；若仍然失败，再考虑额度或内容。';
  } else if (/413|too large|exceed/i.test(message)) {
    text = `文件超出微信的大小限制${suffix}：换一个更小的文件再试。`;
  } else if (/getuploadurl/i.test(message)) {
    text = `微信没有给出上传地址${suffix}：这次上传没有开始，稍后重试；若必现，请用 im-connect 的账号诊断查一次通道状态。`;
  } else if (/CDN 上传失败/i.test(message)) {
    text = `上传到微信 CDN 失败${suffix}：网络不稳或文件偏大，直接重试一次。`;
  } else if (/CDN 上传响应/.test(message)) {
    // 上游：上传成功但响应里没有 x-encrypted-param —— 消息体还没发出去，重试是安全的。
    text = `上传已完成但微信没有回传收据${suffix}：这条消息没有发出，直接重试一次。`;
  } else if (/invalid-file-name/i.test(message)) {
    // 上游 withOutgoingPath 的本地校验：文件名不能含反斜杠 / 控制字符（basename 只消解了斜杠）。
    text = '文件名里有微信不接受的字符（反斜杠、控制字符等）：重命名后再投递。';
  } else if (/http 5\d\d/i.test(message)) {
    text = `微信服务返回错误${suffix}：平台侧临时故障，稍后重试。`;
  } else if (/http 4\d\d/i.test(message)) {
    text = `微信服务拒绝了请求${suffix}：多半是凭据或账号状态问题，请重新连接微信后再试。`;
  } else if (error?.name === 'TimeoutError' || /\btimeout\b/i.test(message)) {
    text = '投递超时：网络太慢或文件偏大，重试一次；持续失败请检查本机网络。';
  }

  if (text === null) return error;
  const wrapped = new Error(text, { cause: error });
  if (code !== '') wrapped.providerCode = code;
  return wrapped;
}

/** 读 channels.json；读不到 / 解析不了时给可操作的提示，而不是把 JSON 报错甩给用户。 */
function readChannelsStore(stateDir) {
  const file = join(stateDir, 'channels.json');
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new Error(`找不到 im-connect 的账号配置（${file}）：请先在 im-connect（IM 助理）的设置里接入微信。`);
    }
    throw new Error(`im-connect 的账号配置无法解析（${file}）：${messageOf(error)}`);
  }
}

/** 读一个 JSON 文件，失败一律当空对象：它只影响提示文案，不该让投递失败。 */
function readJsonQuiet(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/** 状态文件的年龄（分钟）：微信只在收到入站消息时才刷新 context_token，所以它越新越可能发得出去。 */
function fileAgeMinutes(file) {
  try {
    return Math.max(0, Math.round((Date.now() - statSync(file).mtimeMs) / 60000));
  } catch {
    return undefined;
  }
}

/**
 * 上游通道的 log 回调：转成插件日志，绝不写用户可见的错误里。
 *
 * 这里保留 `console.warn` 兜底是**刻意的**（不是漏改）：上游通道的输出是排查投递失败
 * 的唯一线索，而 `channelLogger` 可能在拿不到 ctx.logger 的路径上被调用（模块加载早期、
 * 或调用方没传 logger）。那种情况下宁可写到 stdout 也不要静默丢掉 ——
 * 丢掉之后用户只会看到"发不出去"，而我们连一行可查的东西都没留下。
 */
function channelLogger(logger) {
  return (line) => {
    const text = `[dsh-helper/im-connect] ${line}`;
    if (typeof logger?.warn === 'function') logger.warn(text);
    else console.warn(text);
  };
}

/** 凭据服务返回 { value } 或裸字符串，这里统一成字符串。 */
function credentialValue(credential) {
  if (typeof credential === 'string') return credential;
  if (credential && typeof credential.value === 'string') return credential.value;
  return null;
}

/**
 * 核心：把文件投递到 im-connect 的微信账号。
 *
 * 文件已由调用方读完并校验过大小时才进来（这里只负责投递），所以入参是 absolutePath + bytes。
 *
 * @param credentials - 宿主的 credentials 服务（取 botToken）。
 * @param settings - 本插件 config.json（用 imConnectDir / botId / toUserId）。
 * @param absolutePath - 已解析为绝对路径的待发文件。
 * @param bytes - 文件内容。
 * @param signal - 取消信号（会话中止时透传）。
 * @param logger - 宿主 logger（可选）。
 */
export async function deliverViaImConnect({
  credentials, settings, absolutePath, bytes, signal, logger,
}) {
  const dir = resolveImConnectDir(settings.imConnectDir);
  const { weixin, credentials: credentialModule } = await loadImConnectModules(dir);

  const stateDir = imConnectStateDir();
  const account = pickWeixinAccount(readChannelsStore(stateDir), settings.botId);
  if (account === undefined) {
    throw new Error('im-connect 里还没有可用的微信账号：请先在「设置 → 插件列表」的 IM 助手里接入微信。');
  }
  if (account.enabled === false) {
    throw new Error(`微信账号 ${account.id} 在 im-connect 里是停用状态：启用它之后再投递。`);
  }

  const accountDir = imConnectAccountDir(stateDir, account.id, account.platform);
  const ref = credentialRefFor(credentialModule, account.id, 'botToken');
  const vault = typeof credentialModule?.createServiceVault === 'function'
    ? credentialModule.createServiceVault(credentials)
    : null;
  let token = vault
    ? await vault.resolve(ref)
    : credentialValue(await credentials.resolve(ref));
  // 兜底：旧版把 token 明文写在 wechat-state.json 里（上游自己也留了这个迁移读取器）。
  if (!token && typeof weixin.readLegacyWeixinBotToken === 'function') {
    token = weixin.readLegacyWeixinBotToken(accountDir);
  }
  if (!token) {
    throw new Error(`微信机器人凭据缺失（${ref}）：请到 im-connect 的账号设置里移除后重新连接微信。`);
  }

  const chatId = (typeof settings.toUserId === 'string' && settings.toUserId.trim())
    || account.config.allowedUserId
    || (typeof weixin.readWeixinAllowedUserId === 'function'
      ? weixin.readWeixinAllowedUserId(accountDir)
      : undefined);
  if (!chatId) {
    throw new Error('没有可用的收件人：这个微信账号还没绑定用户，请先在微信里给机器人发一条消息。');
  }

  const statePath = join(accountDir, 'wechat-state.json');
  const stateAgeMinutes = fileAgeMinutes(statePath);
  // 只读 context_token：它在机器人收到入站消息时刷新，我们自己的代码绝不写回这个文件。
  // （唯一的例外在上游：构造通道时若 wechat-state.json 已损坏，上游会把它改名备份 —— 那是它
  // 自身的恢复逻辑，宿主里真正在跑的通道遇到同样情况也会这么做。）
  const contextToken = readJsonQuiet(statePath)?.contextTokens?.[chatId] ?? null;

  // via 只用于回执与日志，判定口径必须与上游一致（上游按扩展名分图片/视频/文件），
  // 不然会出现「回执说图片、实际发了文件」这种对不上的情况。
  const fileName = basename(absolutePath);
  // 先验货：上游只按文件名后缀分流，名不副实会把真图片发成文件卡片（要点开才能看）、
  // 或把假图片发出去被微信拒收。这里按内容魔数纠正「发送名」——只动发送那一刻的名字
  // （微信里显示的文件名），磁盘原文件不动；回执里的 fileName 仍是原名，纠正细节进日志。
  const outgoing = correctOutgoingImageName(fileName, bytes);
  if (outgoing.corrected) {
    logger?.warn?.(`[dsh-helper/im-connect] 文件名与内容不符：${outgoing.note}（原名 ${fileName}）`);
  }
  const ext = extensionOf(outgoing.name);
  const mime = typeof weixin.mimeFromExt === 'function'
    ? weixin.mimeFromExt(ext)
    : (IMAGE_EXTENSIONS.has(ext) ? 'image/*' : 'application/octet-stream');
  const via = mime.startsWith('image/') ? 'image' : (mime.startsWith('video/') ? 'video' : 'file');

  const channel = weixin.createWeixinChannel(
    { enabled: true, stateDir: accountDir, botToken: token },
    channelLogger(logger),
    accountDir,
  );
  if (typeof channel?.sendFile !== 'function') {
    throw new Error(
      `${IM_CONNECT_PACKAGE} 的微信通道没有 sendFile：它可能改了内部结构，请更新 dsh-helper。`,
    );
  }

  try {
    // 注意：这里只调 sendFile，绝不调 channel.start()（见文件头）。
    // 发送名用验货纠偏后的（上游拿它既分流又当显示名）；回执 fileName 仍是磁盘原名。
    await channel.sendFile(chatId, { name: outgoing.name, data: bytes }, signal);
  } catch (error) {
    throw describeImConnectFailure(error, { stateAgeMinutes });
  }

  // 字段必须与 lib/index.js 的 DELIVERY_RESULT_SCHEMA 一致（工具返回值要过 DSH 校验）。
  return {
    sent: true,
    fileName,
    bytes: bytes.byteLength,
    toUserId: chatId,
    botId: account.id,
    hadContextToken: Boolean(contextToken),
    via,
  };
}
