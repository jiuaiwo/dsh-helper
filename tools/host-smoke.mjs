/**
 * dsh-helper host 侧冒烟：把 host 里为「可测」而导出的纯函数真跑一遍。
 *
 * 与 client-smoke.mjs（跑浏览器端产物）互补：那边验的是合并进来的呼吸灯，
 * 这边验的是投递编排、图片嗅探、重启安全闸。所有被测函数都是纯函数或隔离了
 * 副作用的 hook（如 setDetectedDebuggerOverride），不碰真实 dsh-im / dsh-im-connect /
 * 真实账号目录 / 进程控制 —— 需要文件系统时一律用临时目录，需要 DSH_HOME 时临时改环境变量。
 *
 * 为什么要有它：host 侧这些函数「特意导出 + 设了测试 hook」，但仓库里一直
 * 没有对应测试，改安全闸或错误翻译时没有护栏。这里把它们固定下来。
 */
import assert from 'node:assert/strict';
import {
  sniffImageKind,
  isImagePayload,
  chooseDeliveryMethod,
  describeDeliveryFailure,
  detectDeliveryBackend,
  ensureDataDirMigrated,
  migrateScheduleFile,
  reviseScheduleDir,
  scheduleDefaultDir,
  scheduleFile,
} from '../lib/index.js';
import { createScheduleEngine } from '../lib/schedule.js';
import {
  credentialRefFor,
  currentProfileDir,
  describeImConnectFailure,
  imConnectAccountDir,
  imConnectCandidates,
  pickWeixinAccount,
  resolveImConnectDir,
} from '../src/host/im-connect.js';
import { correctOutgoingImageName, withExtension } from '../src/host/image-sniff.js';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { nodeExecutable } from '../src/host/dsh-cli.js';
import { loopbackAuthority, trustedLocalRequest, trustedRestartRequest } from '../src/host/http-trust.js';
import {
  detectedSupervisor,
  detectedDebugger,
  detectedDesktopHost,
  setDetectedDebuggerOverride,
  servingPort,
  respawnInvocation,
  restartHelperSource,
} from '../src/host/restart.js';

const results = [];
/**
 * 跑一条断言。
 *
 * 支持返回 Promise 的断言：**必须支持**，否则 `check("…", async () => …)` 里的失败会被
 * 直接丢掉、那条断言永远是"通过"（假阳性）。异步断言统一收进 pending，收尾处 await。
 */
const pending = [];
function check(label, fn) {
  const report = (ok, message) => {
    results.push(ok ? `  ✓ ${label}` : `  ✗ ${label}\n      ${message}`);
    if (!ok) process.exitCode = 1;
  };
  try {
    const out = fn();
    if (out instanceof Promise) {
      pending.push(out.then(() => report(true), (cause) => report(false, cause instanceof Error ? cause.message : String(cause))));
      return;
    }
    report(true);
  } catch (cause) {
    report(false, cause instanceof Error ? cause.message : String(cause));
  }
}

/* ------------------------------------------------------------- 图片嗅探 */

check('sniff png', () => assert.equal(sniffImageKind(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0])), 'png'));
check('sniff jpeg', () => assert.equal(sniffImageKind(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), 'jpeg'));
check('sniff gif（GIF87a/GIF89a 都认）', () => assert.equal(sniffImageKind(Buffer.from('GIF89a....')), 'gif'));
check('sniff bmp（要过结构校验，不是只看到 "BM" 就认）', () => {
  // 回归点（2026-09-28）：BMP 的签名只有 2 字节，原先 `Buffer.from('BMxxxx')` 就被判成图片。
  // 后果不是理论上的 —— 一个叫「BMC 集群巡检报告.txt」的文件、一段以 BM 开头的 Base64、
  // 一个首格是 BM 的 CSV，都会被改名成 .bmp 按图片消息发出去，微信那边要么拒收要么给出坏图。
  const real = Buffer.alloc(26);
  real.write('BM', 0, 'latin1');
  real.writeUInt32LE(26, 2);        // 文件大小
  real.writeUInt32LE(54, 10);       // 像素数据偏移
  real.writeUInt32LE(40, 14);       // DIB 头大小 = BITMAPINFOHEADER
  assert.equal(sniffImageKind(real), 'bmp', '结构合法的 BMP 要认出来');
  // 保留字段非 0 → 不是 BMP（真 BMP 那 4 个字节一律是 0）
  const badReserved = Buffer.from(real);
  badReserved[6] = 0x41;
  assert.equal(sniffImageKind(badReserved), null, '保留字段非 0 的不该认成 BMP');
  // DIB 头大小是胡写的 → 不是 BMP
  const badDib = Buffer.from(real);
  badDib.writeUInt32LE(4242, 14);
  assert.equal(sniffImageKind(badDib), null, 'DIB 头大小不在已知集合里的不该认成 BMP');
  // 以 BM 开头的文本：这几个都是真实会遇到的内容
  for (const text of ['BMxxxx', 'BMC 集群巡检报告\n第二行', 'BMV0hUAGkAcwAgAGkAcwAgAG4AbwB0ACAAYgBtAHAA']) {
    assert.equal(sniffImageKind(Buffer.from(text, 'utf8')), null, `以 BM 开头的文本不该被当成图片：${text.slice(0, 12)}…`);
  }
  // 太短也不认（连头都读不全）
  assert.equal(sniffImageKind(Buffer.from('BM')), null, '只有 2 字节时不该猜');
});
check('sniff webp（RIFF 容器）', () => assert.equal(sniffImageKind(Buffer.from('RIFF\x00\x00\x00\x00WEBP')), 'webp'));
check('sniff 非图片 → null', () => assert.equal(sniffImageKind(Buffer.from('hello world')), null));

/* ----------------------------------------------------------- 图片判定 */

check('魔数命中不看扩展名', () => assert.equal(isImagePayload(Buffer.from([0xff, 0xd8, 0xff]), 'a.dat'), true));
check('魔数认不出时扩展名兜底 .webp', () => assert.equal(isImagePayload(Buffer.from('xx'), 'a.webp'), true));
check('非图片且非图片扩展名 → false', () => assert.equal(isImagePayload(Buffer.from('xx'), 'a.txt'), false));
check('无扩展名且非图片 → false', () => assert.equal(isImagePayload(Buffer.from('xx'), 'README'), false));

/* --------------------------------------------------------- 投递方式选择 */

const jpeg = Buffer.from([0xff, 0xd8, 0xff]);
check('开关关 → 一律文件', () => assert.deepEqual(
  chooseDeliveryMethod({ bytes: jpeg, filePath: 'a.jpg', imageAsPicture: false, hasSendImage: true }),
  { via: 'file', method: 'sendFile' },
));
check('非图片 → 文件', () => assert.deepEqual(
  chooseDeliveryMethod({ bytes: Buffer.from('xx'), filePath: 'a.txt', imageAsPicture: true, hasSendImage: true }),
  { via: 'file', method: 'sendFile' },
));
check('图片 + 上游有 sendImage → 图片', () => assert.deepEqual(
  chooseDeliveryMethod({ bytes: jpeg, filePath: 'a.jpg', imageAsPicture: true, hasSendImage: true }),
  { via: 'image', method: 'sendImage' },
));
check('图片 + 上游无 sendImage → 降级文件', () => assert.deepEqual(
  chooseDeliveryMethod({ bytes: jpeg, filePath: 'a.jpg', imageAsPicture: true, hasSendImage: false }),
  { via: 'file', method: 'sendFile', degraded: true },
));

/* ----------------------------------------------------------- 错误翻译 */

check('providerCode -2 → prepare failed + token 年龄', () => {
  const e = describeDeliveryFailure(Object.assign(new Error('x'), { providerCode: '-2' }), { tokenAgeMinutes: 3 });
  assert.match(e.message, /prepare failed/);
  assert.match(e.message, /3 分钟前/);
});
check('artifact-provider-rejected 同样走 -2 文案', () => {
  const e = describeDeliveryFailure(Object.assign(new Error('x'), { code: 'artifact-provider-rejected' }));
  assert.match(e.message, /prepare failed/);
});
check('artifact-permission-required → 重新接入', () => {
  const e = describeDeliveryFailure(Object.assign(new Error('x'), { code: 'artifact-permission-required' }));
  assert.match(e.message, /重新接入/);
});
check('artifact-too-large → 大小限制', () => {
  const e = describeDeliveryFailure(Object.assign(new Error('x'), { code: 'artifact-too-large' }));
  assert.match(e.message, /大小限制/);
});
check('artifact-rate-limited → 限流', () => {
  const e = describeDeliveryFailure(Object.assign(new Error('x'), { code: 'artifact-rate-limited' }));
  assert.match(e.message, /限流/);
});
check('artifact-upload-timeout → 超时', () => {
  const e = describeDeliveryFailure(Object.assign(new Error('x'), { code: 'artifact-upload-timeout' }));
  assert.match(e.message, /超时/);
});
check('artifact-delivery-uncertain → 不要盲目重发', () => {
  const e = describeDeliveryFailure(Object.assign(new Error('x'), { code: 'artifact-delivery-uncertain' }));
  assert.match(e.message, /不要盲目重发/);
});
check('翻译后的错误保留 code / providerCode', () => {
  const e = describeDeliveryFailure(Object.assign(new Error('x'), { code: 'artifact-too-large', providerCode: '9' }));
  assert.equal(e.code, 'artifact-too-large');
  assert.equal(e.providerCode, '9');
});
check('未知错误原样返回（同一个对象）', () => {
  const orig = new Error('boom');
  assert.equal(describeDeliveryFailure(orig), orig);
});

/* ------------------------------------------------- im-connect 后端适配 */

check('候选目录：显式配置排第一，web / desktop 的 profile 排前面', () => {
  const home = mkdtempSync(join(tmpdir(), 'hp-imc-home-'));
  try {
    for (const name of ['zeta', 'desktop', 'web']) {
      mkdirSync(join(home, 'profiles', name, 'node_modules', '@michengai', 'dsh-im-connect'), { recursive: true });
    }
    const list = imConnectCandidates('/custom/im-connect', home);
    assert.equal(list[0], '/custom/im-connect');
    assert.match(list[1], /profiles\/web\//);
    assert.match(list[2], /profiles\/desktop\//);
    assert.match(list[3], /profiles\/zeta\//);
    assert.equal(imConnectCandidates('', home).includes(''), false, '空配置不该进候选');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

check('找安装目录：只认真正含微信通道模块的那个（同名空目录跳过）', () => {
  const home = mkdtempSync(join(tmpdir(), 'hp-imc-dir-'));
  try {
    const real = join(home, 'profiles', 'desktop', 'node_modules', '@michengai', 'dsh-im-connect');
    const decoy = join(home, 'profiles', 'web', 'node_modules', '@michengai', 'dsh-im-connect');
    mkdirSync(join(real, 'lib', 'channels'), { recursive: true });
    writeFileSync(join(real, 'lib', 'channels', 'weixin.js'), '');
    // web 排在 desktop 前面但里面没有那个模块 —— 必须跳过它，而不是"找到同名目录就用"。
    mkdirSync(decoy, { recursive: true });
    assert.equal(resolveImConnectDir('', home), real);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

check('找不到安装目录时报错文案可操作（含 imConnectDir）', () => {
  const home = mkdtempSync(join(tmpdir(), 'hp-imc-miss-'));
  try {
    assert.throws(() => resolveImConnectDir('', home), /imConnectDir/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

check('从宿主 argv 认出当前 profile（猜不出就是 undefined）', () => {
  const home = mkdtempSync(join(tmpdir(), 'hp-imc-argv-'));
  try {
    const profile = join(home, 'profiles', 'desktop');
    const argv = ['/usr/bin/node', '/app/asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js', '/app/asar/dsh', profile, '/app/runtime'];
    assert.equal(currentProfileDir(argv, home), profile);
    assert.equal(currentProfileDir(['/usr/bin/node', 'x.js'], home), undefined, '没有 profile 参数时猜不出');
    assert.equal(currentProfileDir([join(home, 'profiles', 'a', 'b')], home), undefined, 'profile 下面还有层级就不算');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

check('候选目录：当前 profile 排在显式配置之后、其它 profile 之前', () => {
  const home = mkdtempSync(join(tmpdir(), 'hp-imc-profile-'));
  try {
    const profile = join(home, 'profiles', 'desktop');
    const list = imConnectCandidates('', home, profile);
    assert.equal(list[0], join(profile, 'node_modules', '@michengai', 'dsh-im-connect'));
    // desktop 已在第一名，扫 profiles 时不能再插一次。
    assert.equal(list.filter((dir) => dir === join(profile, 'node_modules', '@michengai', 'dsh-im-connect')).length, 1);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

check('账号状态目录：id ≠ 渠道名走 accounts/，id = 渠道名走渠道路径', () => {
  assert.equal(imConnectAccountDir('/s', 'weixin_a50bc9312964', 'weixin'), join('/s', 'accounts', 'weixin_a50bc9312964'));
  assert.equal(imConnectAccountDir('/s', 'weixin', 'weixin'), join('/s', 'weixin'));
});

const channelsStore = {
  channels: {
    weixin_1: { platform: 'weixin', enabled: true, config: { allowedUserId: 'u1' } },
    weixin_2: { platform: 'weixin', enabled: false, config: {} },
    ding1: { platform: 'dingtalk', enabled: true, config: {} },
  },
};
check('挑账号：不给 id 时取第一个已启用的微信账号', () => {
  assert.equal(pickWeixinAccount(channelsStore, '').id, 'weixin_1');
  assert.equal(pickWeixinAccount(channelsStore, '').config.allowedUserId, 'u1');
});
check('挑账号：没有已启用的微信账号 → undefined（不换别的渠道顶上）', () => {
  assert.equal(pickWeixinAccount({
    channels: {
      weixin_1: { platform: 'weixin', enabled: false, config: {} },
      qq1: { platform: 'qq', enabled: true, config: {} },
    },
  }, ''), undefined);
  assert.equal(pickWeixinAccount({}, ''), undefined);
  assert.equal(pickWeixinAccount(undefined, ''), undefined);
});
check('挑账号：指定了不存在的账号 → 抛错（绝不静默退回第一个）', () => {
  assert.throws(() => pickWeixinAccount(channelsStore, 'weixin_nope'), /没有名为 weixin_nope/);
});
check('挑账号：指定的 id 不是微信渠道 → 抛错', () => {
  assert.throws(() => pickWeixinAccount(channelsStore, 'ding1'), /没有名为 ding1 的微信账号/);
});
check('挑账号：指定 id 时把 enabled 一起带出来（要不要拦停用由调用方定）', () => {
  const picked = pickWeixinAccount(channelsStore, 'weixin_2');
  assert.equal(picked.id, 'weixin_2');
  assert.equal(picked.enabled, false);
});

check('凭据名：优先用上游的 credentialRef', () => {
  assert.equal(
    credentialRefFor({ credentialRef: (id, key) => `up_${id}_${key}` }, 'weixin_x', 'botToken'),
    'up_weixin_x_botToken',
  );
});
check('凭据名：上游没导出时按它的规则本地拼（非标识符字符换下划线）', () => {
  assert.equal(credentialRefFor({}, 'weixin-a.b', 'botToken'), 'im_connect_weixin_a_b_botToken');
});

check('im-connect 错误翻译：-14 → 重新连接微信', () => {
  const e = describeImConnectFailure(new Error('weixin /ilink/bot/sendmessage ret=-14 errcode=0 '));
  assert.match(e.message, /重新连接微信/);
  assert.equal(e.providerCode, '-14');
});
check('im-connect 错误翻译：prepare failed → 上下文过期 + 状态文件年龄', () => {
  const e = describeImConnectFailure(
    new Error('weixin /ilink/bot/sendmessage ret=-2 errcode=0 errmsg=prepare failed'),
    { stateAgeMinutes: 7 },
  );
  assert.match(e.message, /7 分钟前/);
  assert.match(e.message, /给机器人发一条任意消息/);
  assert.equal(e.providerCode, '-2');
});
check('im-connect 错误翻译：413 → 大小限制', () => {
  assert.match(describeImConnectFailure(new Error('CDN 上传失败: HTTP 413')).message, /大小限制/);
});
check('im-connect 错误翻译：CDN 上传失败 → 直接重试', () => {
  assert.match(describeImConnectFailure(new Error('CDN 上传失败: network error')).message, /重试/);
});
check('im-connect 错误翻译：上传后缺回执参数 → 没发出、重试', () => {
  // 上游这条消息含「CDN 上传响应」而非「CDN 上传失败」，两条翻译不能互相吞掉。
  const e = describeImConnectFailure(new Error('CDN 上传响应缺少 x-encrypted-param'));
  assert.match(e.message, /没有发出/);
  assert.match(e.message, /重试/);
});
check('im-connect 错误翻译：文件名非法（含反斜杠等）→ 重命名', () => {
  // basename 只消解斜杠，macOS 文件名仍可能含反斜杠，上游会以 invalid-file-name 拒绝。
  assert.match(describeImConnectFailure(new Error('invalid-file-name')).message, /重命名/);
});
check('im-connect 错误翻译：http 5xx → 平台临时故障', () => {
  assert.match(describeImConnectFailure(new Error('weixin /ilink/bot/getupdates http 502')).message, /临时故障/);
});
check('im-connect 错误翻译：没拿到上传地址 → 单独说法', () => {
  assert.match(describeImConnectFailure(new Error('getuploadurl 未返回上传地址')).message, /没有给出上传地址/);
});
check('im-connect 错误翻译：认不出的错误原样返回（同一个对象）', () => {
  const orig = new Error('boom');
  assert.equal(describeImConnectFailure(orig), orig);
});

/* ------------------------------------------- 发送名纠偏（先验货、后分流） */

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);

check('纠偏：真图片叫错名字 → 换成正确图片后缀（按图片消息发）', () => {
  const r = correctOutgoingImageName('截图.txt', JPEG);
  assert.equal(r.name, '截图.jpg');
  assert.equal(r.corrected, true);
  assert.match(r.note, /图片消息/);
});
check('纠偏：无后缀的真图片 → 追加后缀', () => {
  assert.equal(correctOutgoingImageName('screenshot', PNG).name, 'screenshot.png');
});
check('纠偏：名字已是图片类就不动（.jpeg 不必规范成 .jpg）', () => {
  assert.equal(correctOutgoingImageName('photo.jpeg', JPEG).corrected, false);
  assert.equal(correctOutgoingImageName('photo.jpg', JPEG).name, 'photo.jpg');
});
check('纠偏：PNG 内容顶着 .jpg 名 → 不纠（名字已是图片类，微信按图片发；避免 .jpeg→.jpg 这类无谓改名）', () => {
  // 取舍：只在「名字会造成错误分流」时才动名字。名字和内容都是图片、只是格式对不上时，
  // 微信按图片消息发、转码按实际内容识别；强行改名反而让 .jpeg 这类合法名字也被动过。
  const r = correctOutgoingImageName('a.jpg', PNG);
  assert.equal(r.name, 'a.jpg');
  assert.equal(r.corrected, false);
});
check('纠偏：文本改名 .jpg → 换 .bin 按文件发（免得被微信当图片拒收）', () => {
  const r = correctOutgoingImageName('说明.jpg', Buffer.from('hello, world'));
  assert.equal(r.name, '说明.bin');
  assert.match(r.note, /内容不是/);
});
check('纠偏：普通文件名 + 普通内容 → 原样发送', () => {
  assert.equal(correctOutgoingImageName('报告.pdf', Buffer.from('%PDF-1.7')).corrected, false);
  assert.equal(correctOutgoingImageName('noext', Buffer.from('x')).name, 'noext');
});
check('换后缀：只动最后一段后缀', () => {
  assert.equal(withExtension('a.tar.gz', '.jpg'), 'a.tar.jpg');
  assert.equal(withExtension('b', '.png'), 'b.png');
});

check('后端探测：装了两个就选 im-connect（auto）', () => {
  const home = mkdtempSync(join(tmpdir(), 'hp-backend-auto-'));
  const prev = process.env.DSH_HOME;
  try {
    mkdirSync(join(home, 'profiles', 'web', 'node_modules', '@michengai', 'dsh-im-connect', 'lib', 'channels'), { recursive: true });
    writeFileSync(join(home, 'profiles', 'web', 'node_modules', '@michengai', 'dsh-im-connect', 'lib', 'channels', 'weixin.js'), '');
    mkdirSync(join(home, 'profiles', 'web', 'node_modules', '@xmanrui', 'dsh-im', 'src', 'channels', 'weixin'), { recursive: true });
    writeFileSync(join(home, 'profiles', 'web', 'node_modules', '@xmanrui', 'dsh-im', 'src', 'channels', 'weixin', 'weixin-api.mjs'), '');
    process.env.DSH_HOME = home;
    assert.equal(detectDeliveryBackend({}), 'im-connect');
    assert.equal(detectDeliveryBackend({ backend: 'dsh-im' }), 'dsh-im', '显式指定旧后端时要听');
  } finally {
    if (prev === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prev;
    rmSync(home, { recursive: true, force: true });
  }
});
check('后端探测：一个都没装 → 空串（面板显示未检测到），不抛错', () => {
  const home = mkdtempSync(join(tmpdir(), 'hp-backend-none-'));
  const prev = process.env.DSH_HOME;
  try {
    process.env.DSH_HOME = home;
    assert.equal(detectDeliveryBackend({}), '');
    // 显式指定一个没装的后端：探测本身不抛（它只回报"没有"），真正投递时才报错。
    assert.equal(detectDeliveryBackend({ backend: 'im-connect' }), '');
  } finally {
    if (prev === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prev;
    rmSync(home, { recursive: true, force: true });
  }
});

// ---------------------------------------- 改名迁移（0.16.0：dsh-helper-patch → dsh-helper）

/**
 * 运行时数据按包名落盘（`$DSH_HOME/integrations/<包名>/`），改名等于换门牌号。
 * 这里钉住的是「老用户升级后配置与定时任务不丢」——该路径**一次性且不可逆**（搬了就搬了），
 * 所以必须有护栏。上一个名字 dsh-imsend 就是因为没做迁移，目录至今还留在用户机器上。
 */
check('改名迁移：旧包名目录整体搬到新包名目录', () => {
  const home = mkdtempSync(join(tmpdir(), 'hp-rename-'));
  const prev = process.env.DSH_HOME;
  try {
    process.env.DSH_HOME = home;
    const legacy = join(home, 'integrations', 'dsh-helper-patch');
    const current = join(home, 'integrations', 'dsh-helper');
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, 'config.json'), '{"enabled":true}');
    writeFileSync(join(legacy, 'schedule.json'), '{"items":[{"id":"t1"}]}');

    ensureDataDirMigrated();

    assert.equal(readFileSync(join(current, 'config.json'), 'utf8'), '{"enabled":true}', 'config.json 要跟着搬');
    assert.equal(readFileSync(join(current, 'schedule.json'), 'utf8'), '{"items":[{"id":"t1"}]}', '定时任务要跟着搬');
    assert.equal(existsSync(legacy), false, '旧目录要搬走（是搬运，不是复制留一份）');
    assert.equal(scheduleFile(), join(current, 'schedule.json'), 'scheduleFile() 必须指向新目录');
  } finally {
    if (prev === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prev;
    rmSync(home, { recursive: true, force: true });
  }
});

check('改名迁移：目标已存在时不覆盖，两边都没有时不凭空建目录', () => {
  const home = mkdtempSync(join(tmpdir(), 'hp-rename-idem-'));
  const prev = process.env.DSH_HOME;
  try {
    process.env.DSH_HOME = home;
    const legacy = join(home, 'integrations', 'dsh-helper-patch');
    const current = join(home, 'integrations', 'dsh-helper');

    // 已经迁过了（新目录有数据）：旧目录即便又冒出来，也不许覆盖新数据
    mkdirSync(current, { recursive: true });
    writeFileSync(join(current, 'config.json'), '{"enabled":"NEW"}');
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, 'config.json'), '{"enabled":"OLD"}');
    ensureDataDirMigrated();
    assert.equal(readFileSync(join(current, 'config.json'), 'utf8'), '{"enabled":"NEW"}', '目标已存在时不许被旧数据覆盖');
    assert.equal(existsSync(join(legacy, 'config.json')), true, '此时不该动旧目录（留给用户自己清）');

    // 全新安装：两边都没有 → 静默通过，不凭空造目录
    rmSync(join(home, 'integrations'), { recursive: true, force: true });
    ensureDataDirMigrated();
    assert.equal(existsSync(current), false, '全新 DSH_HOME 不该被凭空创建目录');
  } finally {
    if (prev === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prev;
    rmSync(home, { recursive: true, force: true });
  }
});

/* ----------------------------------------------------------- 环回权威 */

check('localhost（带端口）权威', () => assert.equal(loopbackAuthority('localhost:3080'), true));
check('127.0.0.1 权威', () => assert.equal(loopbackAuthority('127.0.0.1'), true));
check('[::1]（带端口）权威', () => assert.equal(loopbackAuthority('[::1]:3080'), true));
check('::1 权威', () => assert.equal(loopbackAuthority('::1'), true));
check('evil.com 拒绝', () => assert.equal(loopbackAuthority('evil.com'), false));
check('空 Host 拒绝', () => assert.equal(loopbackAuthority(''), false));

/* --------------------------------------------------------- 重启请求信任 */

const goodReq = { socket: { remoteAddress: '127.0.0.1' }, headers: { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' } };
check('同源环回放行', () => assert.equal(trustedRestartRequest(goodReq), true));
check('::1 环回 peer 放行', () => assert.equal(trustedRestartRequest({ socket: { remoteAddress: '::1' }, headers: { host: '[::1]:3080', origin: 'http://[::1]:3080' } }), true));
check('非环回 peer 拒绝', () => assert.equal(trustedRestartRequest({ socket: { remoteAddress: '8.8.8.8' }, headers: goodReq.headers }), false));
check('带 x-forwarded-for 拒绝（环回 peer 其实是代理）', () => assert.equal(trustedRestartRequest({ socket: { remoteAddress: '127.0.0.1' }, headers: { ...goodReq.headers, 'x-forwarded-for': '1.2.3.4' } }), false));
check('Host 非环回拒绝（DNS rebinding）', () => assert.equal(trustedRestartRequest({ socket: { remoteAddress: '127.0.0.1' }, headers: { host: 'evil.com', origin: 'http://evil.com' } }), false));
check('Origin 与 Host 不一致拒绝', () => assert.equal(trustedRestartRequest({ socket: { remoteAddress: '127.0.0.1' }, headers: { host: '127.0.0.1:3080', origin: 'http://evil.com' } }), false));

/* ----------------------------------------------------------- 端口解析 */

check('带端口解析出端口', () => assert.equal(servingPort({ headers: { host: '127.0.0.1:3080' } }), 3080));
check('无端口 → null', () => assert.equal(servingPort({ headers: { host: '127.0.0.1' } }), null));
check('非法端口 → null', () => assert.equal(servingPort({ headers: { host: '127.0.0.1:99999' } }), null));

/* --------------------------------------------------------- 监督器检测 */

check('systemd 环境命中', () => assert.equal(detectedSupervisor({ INVOCATION_ID: 'x' }, 1, () => null), 'systemd'));
check('无环境 → null', () => assert.equal(detectedSupervisor({}, 100, () => null), null));
check('仅 JOURNAL_STREAM 但非 systemd 父进程 → null', () => assert.equal(detectedSupervisor({ JOURNAL_STREAM: 'x' }, 100, () => 'bash'), null));
check('JOURNAL_STREAM + 父 comm=systemd → 命中', () => assert.equal(detectedSupervisor({ JOURNAL_STREAM: 'x' }, 100, () => 'systemd'), 'systemd'));

/* --------------------------------------------------------- 桌面端宿主检测 */

// 回归点（2026-10-06）：桌面端窗口经 Electron 的 forwardWebRequest 转发请求时会剥掉 Origin，
// 重启闸 trustedRestartRequest 因此恒 false —— 若不单独认这一档，用户点按钮只会拿到
// 403 untrusted，而按钮（走松一档的 trustedLocalRequest）还是亮的。
check('桌面端：DSH_CLIENT_VERSION 非空 → desktop', () => assert.equal(detectedDesktopHost({ DSH_CLIENT_VERSION: '0.2.0-rc.2' }), 'desktop'));
check('桌面端：空/空白版本号 → null（空串不算标识）', () => {
  assert.equal(detectedDesktopHost({ DSH_CLIENT_VERSION: '' }), null);
  assert.equal(detectedDesktopHost({ DSH_CLIENT_VERSION: '   ' }), null);
});
check('桌面端：dsh web / CLI 的环境（无该变量）→ null', () => assert.equal(detectedDesktopHost({}), null));
// ELECTRON_RUN_AS_NODE 是"Electron 当 Node 用"的通用标记，别的 Electron 应用里跑 dsh 也会命中，
// 所以刻意不拿它当判据 —— 这条断言就是把这个决定钉住。
check('桌面端：只认 DSH_CLIENT_VERSION，不吃 ELECTRON_RUN_AS_NODE', () => assert.equal(detectedDesktopHost({ ELECTRON_RUN_AS_NODE: '1' }), null));

/* --------------------------------------------------------- 调试器检测 */

// 用 override 隔离环境，避免测试机本身有没有 inspector 影响结果。
setDetectedDebuggerOverride('inspector');
check('debugger override → inspector', () => assert.equal(detectedDebugger(), 'inspector'));
setDetectedDebuggerOverride(undefined);

check('execArgv 含 --inspect → inspector', () => assert.equal(detectedDebugger('', ['--inspect'], ''), 'inspector'));
check('execArgv 含 --inspect-brk=9229 → inspector', () => assert.equal(detectedDebugger('', ['--inspect-brk=9229'], ''), 'inspector'));
check('NODE_OPTIONS 含 --inspect → inspector', () => assert.equal(detectedDebugger('', [], '--inspect-wait'), 'inspector'));
check('全空 → null', () => assert.equal(detectedDebugger('', [], ''), null));

/* ------------------------------------------------- node 可执行路径 */

check('nodeExecutable 优先 argv0（绝对且存在）', () => assert.equal(nodeExecutable(process.execPath, '/nonexistent'), process.execPath));
check('nodeExecutable argv0 不存在时回退 execPath', () => assert.equal(nodeExecutable('/nonexistent/argv0', process.execPath), process.execPath));

/* ------------------------------------------------- 平台适配的 spawn */

check('POSIX 直连 detached', () => assert.deepEqual(
  respawnInvocation({ file: 'node', args: ['x'], viaShell: false }, 'linux'),
  { file: 'node', args: ['x'], viaShell: false, detached: true },
));
check('Windows viaShell 且非 .cmd → 加 .cmd 后缀、包 powershell', () => {
  const inv = respawnInvocation({ file: 'dsh', args: [], viaShell: true }, 'win32');
  assert.equal(inv.file, 'powershell.exe');
  assert.equal(inv.viaShell, false);
  assert.equal(inv.detached, false);
  assert.match(inv.args.join(' '), /dsh\.cmd/);
});
check('Windows 已是 .cmd → 不加后缀', () => {
  const inv = respawnInvocation({ file: 'dsh.cmd', args: [], viaShell: true }, 'win32');
  assert.match(inv.args.join(' '), /dsh\.cmd/);
});

/* ------------------------------------------------- detached helper 源码 */

check('helper 源码含端口探测与启动逻辑', () => {
  const src = restartHelperSource(
    { file: 'node', args: ['a'], viaShell: false, detached: true },
    { cwd: '/tmp' },
    { out: '/tmp/o.log', err: '/tmp/e.log' },
    3080,
  );
  assert.match(src, /net\.connect/);
  assert.match(src, /dsh-helper/);
  assert.match(src, /spawn\(file, args/);
  assert.match(src, /3080/);
  assert.match(src, /SETTLE_MS/);
});
check('helper 源码：无端口时退化为固定 sleep', () => {
  const src = restartHelperSource(
    { file: 'node', args: [], viaShell: false, detached: true },
    { cwd: '/tmp' },
    { out: '/tmp/o.log', err: '/tmp/e.log' },
    null,
  );
  // port 为 null 时 main 里走 sleep(1500) 分支；net.connect 的探测函数定义仍在，
  // 只是不会被调用，所以这里只看分支本身。
  assert.match(src, /const port = null/);
  assert.match(src, /sleep\(1500\)/);
});

/* ------------------------------------------------- 定时任务（从 T专家 迁来） */

check('定时任务数据文件落在本插件自己的数据根', () => {
  // 不再借用 T专家 的 ~/.t-team：那是"零关联"的一部分。
  const file = scheduleFile();
  assert.match(file, /integrations\/dsh-helper\/schedule\.json$/);
  assert.doesNotMatch(file, /\.t-team/);
});

check('数据迁移：旧文件存在、新文件不存在时复制一份（只复制不删除）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hp-sched-'));
  const legacy = join(dir, 'legacy.json');
  const target = join(dir, 'nested', 'schedule.json');
  writeFileSync(legacy, JSON.stringify({ version: 1, items: [{ id: 'a', title: '任务' }] }), 'utf8');
  const previous = process.env.DSH_HELPER_PATCH_SCHEDULE_LEGACY;
  process.env.DSH_HELPER_PATCH_SCHEDULE_LEGACY = legacy;
  try {
    migrateScheduleFile(target, {});
    // 顶层多了 migration.legacy 标记，所以两条 JSON 不完全相等 —— 比较 items 部分。
    const targetBody = JSON.parse(readFileSync(target, 'utf8'));
    const legacyBody = JSON.parse(readFileSync(legacy, 'utf8'));
    assert.deepEqual(targetBody.items, legacyBody.items, 'items 内容应与旧文件一致');
    assert.equal(targetBody.migration?.legacy, legacy, '首次迁移也要写 migration.legacy 标记（目标不存在分支）');
    assert.ok(readFileSync(legacy, 'utf8').includes('任务'), '旧文件必须原样保留（回退要靠它）');
  } finally {
    if (previous === undefined) delete process.env.DSH_HELPER_PATCH_SCHEDULE_LEGACY;
    else process.env.DSH_HELPER_PATCH_SCHEDULE_LEGACY = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});

check('数据迁移：目标已存在就不覆盖；旧文件不存在则什么都不做', () => {
  // 这条断言覆盖的是"两个文件都有任务" = stranded（见上方独立的 stranded 测试）。
  // 这里要保证的是：目标文件内容**没动**，且迁移结果带 stranded 诊断（旧文件有 1 条）。
  const dir = mkdtempSync(join(tmpdir(), 'hp-sched-'));
  try {
    const legacy = join(dir, 'legacy.json');
    const target = join(dir, 'schedule.json');
    writeFileSync(legacy, '{"items":["旧"]}', 'utf8');
    writeFileSync(target, '{"items":["新"]}', 'utf8');
    const previous = process.env.DSH_HELPER_PATCH_SCHEDULE_LEGACY;
    process.env.DSH_HELPER_PATCH_SCHEDULE_LEGACY = legacy;
    try {
      const report = migrateScheduleFile(target, {});
      assert.match(readFileSync(target, 'utf8'), /新/, '目标已存在时绝不覆盖用户当前数据');
      assert.equal(report.merged, undefined, '目标非空时绝不能合并');
      assert.notEqual(report.stranded, undefined, '目标非空时旧文件里的任务要由用户处理（stranded）');
    } finally {
      if (previous === undefined) delete process.env.DSH_HELPER_PATCH_SCHEDULE_LEGACY;
      else process.env.DSH_HELPER_PATCH_SCHEDULE_LEGACY = previous;
    }
    // 旧文件不存在 → 静默返回，不抛
    rmSync(legacy, { force: true });
    assert.deepEqual(migrateScheduleFile(join(dir, 'never.json'), {}), {}, '旧文件不存在时不产生任何诊断');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

check('迁移：旧文件有任务、目标文件为空时**自动合并**到目标，不再搁浅', () => {
  // 回归点（2026-09-28 → 2026-09-29 再修）：
  // 第一版把这条分支做成"出声但不动数据"——面板里说"还有 2 条没迁"，但用户依旧不会
  // 看到任务在跑。第二版改成"自动合并到空目标"：目标文件没有用户数据，合并安全。
  // 典型场景：本插件先于迁移闸门启动过一次（那次把空表写进目标），旧文件里的任务就永远没迁过来。
  const dir = mkdtempSync(join(tmpdir(), 'hp-merged-'));
  try {
    const legacy = join(dir, 'legacy.json');
    const target = join(dir, 'schedule.json');
    const legacyBody = JSON.stringify({
      version: 1,
      items: [
        { id: 'a', title: '每日热点新闻', cron: '0 9 * * *', enabled: false },
        { id: 'b', title: '国内热点新闻', cron: '8 12 * * *', enabled: true },
      ],
    });
    writeFileSync(legacy, legacyBody, 'utf8');
    writeFileSync(target, JSON.stringify({ version: 1, items: [] }), 'utf8');
    const previous = process.env.DSH_HELPER_PATCH_SCHEDULE_LEGACY;
    process.env.DSH_HELPER_PATCH_SCHEDULE_LEGACY = legacy;
    const logs = [];
    try {
      const report = migrateScheduleFile(target, {
        warn: (message) => logs.push(String(message)),
        info: (message) => logs.push(String(message)),
      });
      // 诊断形状：merged + 路径 + 条数；stranded 不应出现（已经合并好了）
      assert.ok(report.merged !== undefined, '目标为空 + 旧文件有任务时必须自动合并');
      assert.equal(report.merged.count, 2, '要报出合并的任务条数');
      assert.equal(report.merged.legacy, legacy, '诊断里要带上旧文件路径（面板文案里要显示）');
      assert.equal(report.merged.target, target, '也要带上目标路径');
      assert.equal(report.stranded, undefined, '合并成功后就不该再报搁浅了');
      // 落盘验证：目标文件**items 部分**应与旧文件一致；顶层还会多一个 migration.legacy 标记。
      const targetBody = JSON.parse(readFileSync(target, 'utf8'));
      assert.deepEqual(targetBody.items, JSON.parse(legacyBody).items, '目标文件的 items 应与旧文件一致');
      assert.equal(targetBody.migration?.legacy, legacy, '合并成功后必须写 migration.legacy 标记（幂等性的依据）');
      assert.equal(typeof targetBody.migration?.at, 'string', '迁移标记要有 at 时间戳');
      // 旧文件必须**保留**（与初次迁移同样口径：只复制不删除，便于回退）
      assert.equal(readFileSync(legacy, 'utf8'), legacyBody, '旧文件必须原样保留（合并后还能回退）');
      // 日志要留一条 info，含条数
      assert.equal(logs.length, 1, '合并日志只该有一条 info（没有 warn，因为没出错）');
      assert.equal(logs[0].includes('2') && logs[0].includes('合并'), true, '日志要说清是合并操作与条数');
      // 幂等性：第二次跑迁移必须看到标记就跳过，不再触发合并 + 不报诊断
      const second = migrateScheduleFile(target, {});
      assert.deepEqual(second, {}, '已迁移过的旧文件再跑一次必须静默返回（幂等）');
      assert.equal(readFileSync(target, 'utf8').length > 0, true, '幂等运行不能误删目标文件');
    } finally {
      if (previous === undefined) delete process.env.DSH_HELPER_PATCH_SCHEDULE_LEGACY;
      else process.env.DSH_HELPER_PATCH_SCHEDULE_LEGACY = previous;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

check('迁移：目标已有任务时仍**不覆盖**，只报 stranded 让用户处理', () => {
  // 反面验证：合并只对"目标为空"成立。目标已经有任何一条任务，都绝不能动
  // —— 否则用户在辅助补丁里后来建/改的任务会被旧文件覆盖掉。
  const dir = mkdtempSync(join(tmpdir(), 'hp-stranded-'));
  try {
    const legacy = join(dir, 'legacy.json');
    const target = join(dir, 'schedule.json');
    const targetBody = JSON.stringify({
      version: 1,
      items: [{ id: 'new', title: '用户在辅助补丁里建的任务', cron: '0 9 * * *', enabled: true }],
    });
    writeFileSync(legacy, JSON.stringify({
      version: 1,
      items: [
        { id: 'a', title: '每日热点新闻', cron: '0 9 * * *', enabled: false },
        { id: 'b', title: '国内热点新闻', cron: '8 12 * * *', enabled: true },
      ],
    }), 'utf8');
    writeFileSync(target, targetBody, 'utf8');
    const previous = process.env.DSH_HELPER_PATCH_SCHEDULE_LEGACY;
    process.env.DSH_HELPER_PATCH_SCHEDULE_LEGACY = legacy;
    const logs = [];
    try {
      const report = migrateScheduleFile(target, {
        warn: (message) => logs.push(String(message)),
        info: (message) => logs.push(String(message)),
      });
      assert.equal(report.stranded?.count, 2, '要报出旧文件里没迁过来的条数');
      assert.equal(report.merged, undefined, '目标非空时绝不能合并');
      assert.equal(readFileSync(target, 'utf8'), targetBody, '目标文件内容不能动');
      assert.equal(logs.length, 1, '宿主日志里也要留一条（面板之外的第二条线索）');
      assert.match(logs[0], /2 条任务/u, '日志要说清条数');
      assert.match(logs[0], /恢复办法|重建|移走/u, '日志要给出可操作的恢复办法');
    } finally {
      if (previous === undefined) delete process.env.DSH_HELPER_PATCH_SCHEDULE_LEGACY;
      else process.env.DSH_HELPER_PATCH_SCHEDULE_LEGACY = previous;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

check('数据文件损坏时按空表继续，但必须把原文件留存下来', async () => {
  // 回归点（2026-09-28）：原先解析失败只 warn 一句就当空表继续 —— 而下一次 create/update
  // 的 persist 会用空表**覆盖**那个损坏文件。用户的全部定时任务就此凭空消失，且没有任何副本可恢复。
  const { createScheduleEngine } = await import('../lib/schedule.js');
  const dir = mkdtempSync(join(tmpdir(), 'hp-corrupt-'));
  const file = join(dir, 'schedule.json');
  const original = '{"version":1,"items":[{"id":"a","title":"重要任务","cron":"0 9 * * *"';  // 故意截断
  try {
    writeFileSync(file, original, 'utf8');
    const logs = [];
    const engine = createScheduleEngine({
      ctx: { get: () => undefined }, file, t: (k) => k, defaultCwd: dir, armed: true,
      logger: { warn: (message) => logs.push(String(message)) },
    });
    try {
      assert.equal(engine.list().length, 0, '损坏时按空表继续（不能因为一个坏文件就启动失败）');
      assert.equal(existsSync(file), false, '损坏文件要被移走，别留在原地等着被空表覆盖');
      const kept = readdirSync(dir).filter((name) => name.startsWith('schedule.json.corrupt-'));
      assert.equal(kept.length, 1, `要留存一份 .corrupt-<时间戳> 副本（实际：${kept.join(',') || '无'}）`);
      assert.equal(readFileSync(join(dir, kept[0]), 'utf8'), original, '副本必须是原始字节，用户才可能手工修好');
      assert.equal(logs.length, 1, '要出声（一条 warn）');
      assert.match(logs[0], /留存/u, '日志要说清副本在哪，否则用户不知道能恢复');
      // 留存之后新建一条，确认写入的是新文件而不是把副本覆盖掉
      await engine.create({ title: '新的', prompt: 'p', cron: '0 9 * * *' });
      assert.equal(engine.list().length, 1, '留存后引擎要能正常写新数据');
      assert.equal(readFileSync(join(dir, kept[0]), 'utf8'), original, '副本不能被后续写入动到');
    } finally {
      engine.dispose();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

check('迁移诊断要能走到面板：snapshot 带 migrationNotice + kind，穿得过线格式', async () => {
  // 日志在桌面/Web 里用户看不见，所以这条诊断必须走 remote → 面板。
  // 两个环节都可能断：引擎没把它放进 snapshot，或者 schema 漏声明被 zod strip 掉。
  // 2026-09-29 起 kind 必填，stranded / merged 两种都要能穿过 schema。
  const { createScheduleEngine } = await import('../lib/schedule.js');
  const { scheduleSnapshotSchema } = await import('../lib/schedule-schemas.js');
  const dir = mkdtempSync(join(tmpdir(), 'hp-notice-'));
  try {
    for (const [kind, source] of [
      ['stranded', { stranded: { legacy: '/old/schedule.json', target: '/new/schedule.json', count: 2 } }],
      ['merged', { merged: { legacy: '/old/schedule.json', target: '/new/schedule.json', count: 2 } }],
    ]) {
      const engine = createScheduleEngine({
        ctx: { get: () => undefined }, file: join(dir, `${kind}.json`),
        t: (k) => k, defaultCwd: dir, armed: true, migrationNotice: source,
      });
      try {
        const parsed = scheduleSnapshotSchema.parse(engine.snapshot());
        assert.equal(parsed.migrationNotice?.count, 2, `${kind} 诊断必须能穿过快照 schema`);
        assert.equal(parsed.migrationNotice?.kind, kind, `${kind} 诊断的 kind 必须透传（决定面板用哪条文案）`);
        assert.equal(parsed.migrationNotice?.legacy, '/old/schedule.json', '旧文件路径要传得出去（文案里要显示）');
      } finally {
        engine.dispose();
      }
    }
    // 没有诊断时不该凭空出现这个键（否则面板会渲染一条空提示）
    const clean = createScheduleEngine({
      ctx: { get: () => undefined }, file: join(dir, 'clean.json'),
      t: (k) => k, defaultCwd: dir, armed: true,
    });
    try {
      assert.equal('migrationNotice' in clean.snapshot(), false, '正常启动时不该出现这个键');
    } finally {
      clean.dispose();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

check('迁移幂等性：target 顶层 migration.legacy 标记存在时，snapshot 不再透传提示', async () => {
  // 用户报的现状（2026-09-29）：合并成功后用户在面板里把任务删了，迁移提示还在。
  // 根因：migrationNotice 是 apply 时算一次就缓存的内存值，用户删任务不会更新它。
  // 修：合并成功后给 target 顶层写 migration.legacy 标记，load 时读进 migrationTag，
  // snapshot 据此判断"已经迁移过那个旧文件" → 不再透传提示。
  const { createScheduleEngine } = await import('../lib/schedule.js');
  const dir = mkdtempSync(join(tmpdir(), 'hp-mig-idem-'));
  try {
    // 准备一个"合并过"状态的 target：items 是空的（用户已经删完），但顶层有 migration 标记。
    const file = join(dir, 'schedule.json');
    // 旧文件路径必须与**引擎自己算出来的**那个一致。引擎取
    // `DSH_HELPER_PATCH_SCHEDULE_LEGACY ?? homedir()/.t-team/schedule.json`，这里原先是硬编码的
    // `/Users/biaoge/...`：换个 home（CI 是 /home/runner）就判不相等 → 迁移标记匹配不上 →
    // snapshot 继续透传提示 → 断言假失败。2026-10-06 由 CI 首次跑抓到（本地 home 恰好就是那个值）。
    const legacy = process.env.DSH_HELPER_PATCH_SCHEDULE_LEGACY
      ?? join(homedir(), '.t-team', 'schedule.json');
    writeFileSync(file, JSON.stringify({
      version: 1,
      // 用户已经删了那 2 条合并过去的任务
      items: [],
      migration: { legacy, at: '2026-09-28T22:00:00.000Z' },
    }), 'utf8');
    // host 启动时（理论上）会算 migrationNotice = merged —— 那条提示
    const engine = createScheduleEngine({
      ctx: { get: () => undefined },
      file,
      t: (k) => k, defaultCwd: dir, armed: true,
      migrationNotice: { merged: { legacy, target: file, count: 2 } },
    });
    try {
      // 关键断言：snapshot 不该再返回 migrationNotice —— 即使内存里有那条诊断
      const snap = engine.snapshot();
      assert.equal('migrationNotice' in snap, false,
        '已迁移过的旧文件再发 snapshot 不该带提示（用户删完任务后这条必须消失）');
    } finally {
      engine.dispose();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

check('迁移字段要穿过 persist：用户在面板里增删改任务，migration 标记必须保留', async () => {
  // 这是上条测试的反面：migration 字段**不能**因为 persist 被 strip 掉，
  // 否则下次启动又按"未迁移"处理 → 又触发合并 → 又报提示。
  // ⚠️ 这是 zod z.object 默认 strip 的又一个必填字段 —— 漏声明就是这种静默回归。
  const { createScheduleEngine } = await import('../lib/schedule.js');
  const dir = mkdtempSync(join(tmpdir(), 'hp-mig-persist-'));
  try {
    const file = join(dir, 'schedule.json');
    writeFileSync(file, JSON.stringify({
      version: 1,
      items: [],
      migration: { legacy: '/old/schedule.json', at: '2026-09-28T22:00:00.000Z' },
    }), 'utf8');
    const engine = createScheduleEngine({
      ctx: { get: () => undefined }, file, t: (k) => k, defaultCwd: dir, armed: true,
    });
    try {
      await engine.create({ title: '新任务', prompt: '提示词', cron: '0 9 * * *', enabled: true });
      // 写盘之后，文件必须仍带 migration 字段
      const body = JSON.parse(readFileSync(file, 'utf8'));
      assert.equal(body.migration?.legacy, '/old/schedule.json', 'persist 必须保留 migration.legacy 标记');
      assert.equal(body.items.length, 1, '新任务确实落了盘');
    } finally {
      engine.dispose();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

check('迁移闸门已打开（T专家 那边已不再调度，复制不会造成双跑）', () => {
  const src = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8');
  assert.match(src, /const SCHEDULE_MIGRATION_ENABLED = true;/);
  assert.match(src, /if \(SCHEDULE_MIGRATION_ENABLED\)/);
});

check('host 侧文案表：占位符替换 + 缺键回退 + 指向本插件的设置位置', async () => {
  const { t } = await import('../lib/schedule-copy.js');
  assert.equal(t('schedule.titleTooLong', { limit: 60 }), '标题超过 60 个字符');
  assert.equal(t('schedule.noSuchKey'), 'schedule.noSuchKey');
  assert.match(t('schedule.disabled'), /辅助补丁/, '关掉时的提示要指向本插件的设置位置，不能再说 T专家');
});

check('remote 模块能被宿主真正加载（少一个 import 就会在这里炸）', async () => {
  // 这就是 2026-09-25 实际踩到的坑：从 T专家 提取时漏了 `import { z }`，模块加载直接抛
  // "z is not defined" —— 宿主静默跳过这个 patch 条目，装进浏览器后只表现为
  // 「定时任务服务暂时不可用：Cannot read properties of undefined (reading 'getSchedule')」。
  // 那条报错离根因隔着两层，所以这里直接加载模块本身。
  const mod = await import('../lib/schedule-remote.js');
  assert.equal(mod.DESCRIPTORS.length, 8);
  assert.equal(mod.TYPERT.package, 'dsh-helper');
  assert.equal(mod.TYPERT.face, 'host');
  // wire 名必须与客户端信封（src/client/schedule-remote.js）逐字一致，否则 api-gateway 找不到服务
  for (const d of mod.DESCRIPTORS) {
    assert.equal(d.service, 'helperPatch');
    assert.equal(d.namespace, 'helperPatch');
    assert.match(d.id, /^dsh-helper#helperPatch\//);
  }
});

check('客户端信封与宿主描述符的方法集合完全一致（缺一个就是"调不到"）', async () => {
  const host = await import('../lib/schedule-remote.js');
  const client = await import('../src/client/schedule-remote.js');
  const hostMethods = host.DESCRIPTORS.map((d) => d.method).sort();
  const clientMethods = client.TYPERT_REMOTE.descriptors.map((d) => d.method).sort();
  assert.deepEqual(clientMethods, hostMethods);
  assert.equal(client.TYPERT_REMOTE.package, host.TYPERT.package);
});

check('apply 会把 remote 服务挂上（不依赖包的 cordis.patch.yml）', async () => {
  // 背景：profile 以 link: 安装时，包内 cordis.patch.yml 不会在安装后自动同步到
  // ~/.dsh/profiles/web/cordis.patch.yml（那是**安装时**生成的快照）。只改包内 patch 不重装，
  // 宿主就不会加载这个 remote 服务，面板表现为「服务暂时不可用：…reading 'getSchedule'」。
  // 所以改成插件在 apply 里自注册，这条断言盯的就是"自注册这一步真的发生了"。
  const { apply } = await import('../lib/index.js');
  const remoteModule = await import('../lib/schedule-remote.js');
  const mounted = [];
  const provided = [];
  const ctx = {
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    get: () => undefined,
    effect: (fn) => { const cleanup = typeof fn === 'function' ? fn() : undefined; return cleanup ?? (() => {}); },
    inject: () => {},
    on: () => {},
    plugin: (plugin) => { mounted.push(plugin); return () => {}; },
    reflect: { provide: (name, value) => { provided.push(name); } },
  };
  apply(ctx);
  assert.ok(mounted.includes(remoteModule.default), 'apply 必须把 remote 类交给 ctx.plugin');
  assert.ok(provided.includes('helperPatchSchedule'), '调度引擎的服务名必须被 provide（remote 靠它取引擎）');
});

/* ------------------------------------------ 本地功能请求信任（投递/配置路由） */

// /send-file 与 /config 的来源闸：比重启闸松一档（放行无 Origin 的本机脚本），
// 但"有 Origin 必须同源"这条是挡恶意网页 drive-by 投递/篡改的核心，单独钉死。
const localReq = (headers, remoteAddress = '127.0.0.1') => ({ socket: { remoteAddress }, headers });
check('本地功能：无 Origin（curl/本机脚本）放行', () => assert.equal(trustedLocalRequest(localReq({ host: '127.0.0.1:3080' })), true));
check('本地功能：同源 Origin 放行', () => assert.equal(trustedLocalRequest(localReq({ host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' })), true));
check('本地功能：跨站 Origin 拒绝（drive-by 投递）', () => assert.equal(trustedLocalRequest(localReq({ host: '127.0.0.1:3080', origin: 'https://evil.example' })), false));
check('本地功能：非环回 peer 拒绝', () => assert.equal(trustedLocalRequest(localReq({ host: '127.0.0.1:3080' }, '8.8.8.8')), false));
check('本地功能：Host 非环回拒绝（DNS rebinding）', () => assert.equal(trustedLocalRequest(localReq({ host: 'evil.com:3080', origin: 'http://evil.com:3080' })), false));
check('本地功能：带 x-forwarded-for 拒绝', () => assert.equal(trustedLocalRequest(localReq({ host: '127.0.0.1:3080', 'x-forwarded-for': '1.2.3.4' })), false));
check('本地功能：::1 环回放行', () => assert.equal(trustedLocalRequest(localReq({ host: '[::1]:3080' }, '::1')), true));

/* ------------------------------ 定时任务业务错误路径（businessError 丢失回归） */

check('remote 业务错误转 RemoteError 带领域码（不再退化成 TypeError）', async () => {
  // 回归点：2026-09-25 从 T专家 迁入时，7 个访问器里的 this.businessError(...) 调用被搬了过来，
  // 方法体本身却丢了——每条业务错误都变成 `TypeError: this.businessError is not a function`，
  // 被网关折成 gateway/internal，用户看到的是这句 JS 报错而不是中文校验提示。
  // 正常路径全通，所以只有专门打错误路径的这条断言能守住。
  const mod = await import('../lib/schedule-remote.js');
  const { RemoteError } = await import('@deepseek-ai/dsh-typert-protocol');
  assert.equal(typeof RemoteError, 'function', '上游必须能取到 RemoteError 类');
  const makeRemote = (engine) => new mod.default({
    typert: { register: () => {} },
    reflect: { provide: () => {} },
    get: (name) => (name === mod.SCHEDULE_SERVICE ? engine : undefined),
  });
  const remote = makeRemote({
    snapshot: () => { throw new Error('boom'); },
    create: async () => { throw new Error('标题不能为空'); },
    remove: async () => { throw Object.assign(new Error('任务不存在'), { code: 'ENOENT' }); },
  });
  await assert.rejects(remote.createScheduleItem({}), (error) => {
    assert.ok(error instanceof RemoteError, '业务错误必须是 RemoteError（能过网关）');
    assert.equal(error.code, 'helperPatch/schedule-invalid');
    assert.equal(error.message, '标题不能为空', '面板要显示的是校验文案，不是 "businessError is not a function"');
    return true;
  });
  // 系统 errno 不是领域码：必须回落访问器的兜底码（D-17），不能把 ENOENT 透传成业务失败类型。
  await assert.rejects(remote.deleteScheduleItem('item-x'), (error) => {
    assert.ok(error instanceof RemoteError);
    assert.equal(error.code, 'helperPatch/schedule-invalid');
    assert.notEqual(error.code, 'ENOENT');
    return true;
  });
  await assert.rejects(remote.getSchedule(), (error) => {
    assert.equal(error.code, 'helperPatch/schedule-unreadable');
    return true;
  });
  // 形如 <domain>/<reason> 的域码原样透传。
  const passThrough = makeRemote({ create: async () => { throw Object.assign(new Error('自定义'), { code: 'helperPatch/schedule-custom' }); } });
  await assert.rejects(passThrough.createScheduleItem({}), (error) => {
    assert.equal(error.code, 'helperPatch/schedule-custom');
    return true;
  });
});

/* ------------------------------------------ 定时任务总开关接线（P2 回归） */

check('scheduleEnabled：引擎随配置启动 + POST 立即生效 + 三路由来源闸', async () => {
  // 回归点：引擎一直有 setArmed/isArmed，但 apply 写死 armed:true、remote 没暴露、
  // 客户端也不读 armed——总开关没有任何入口，用户无法整体停用定时触发。
  const { apply } = await import('../lib/index.js');
  const dir = mkdtempSync(join(tmpdir(), 'hp-armed-'));
  let dir2;
  const previousHome = process.env.DSH_HOME;
  const previousLegacy = process.env.DSH_HELPER_PATCH_SCHEDULE_LEGACY;
  const fakeRequest = ({ method = 'POST', headers = {}, body, remoteAddress = '127.0.0.1' } = {}) => ({
    method,
    socket: { remoteAddress },
    headers,
    // handleSendRequest 会在 request 上挂 'close' 监听（客户端断开就取消上游投递），
    // 真实的 IncomingMessage 本来就是 EventEmitter；这里给一对空实现即可 ——
    // 测试不需要真的触发 close，只需要那两行调用不抛。
    once() { return this; },
    off() { return this; },
    // readJsonBody 对 request 做 for-await：一个 async 生成器就够。
    [Symbol.asyncIterator]: function* () {
      if (body !== undefined) yield Buffer.from(JSON.stringify(body));
    },
  });
  const fakeResponse = () => ({
    destroyed: false, writableEnded: false, status: undefined, body: undefined,
    writeHead(status) { this.status = status; },
    end(body) { this.body = body; this.writableEnded = true; },
  });
  // 默认工作区"存不存在"要能翻转：既验证"已存在 → 只读复用"，也验证"还不存在 → 建任务时
  // **仍然不许**顺手把它建出来"（用户口径：创建时不建、执行时才建）。
  // ⚠️ 声明在 harness **外面** —— 放进去就只是它的局部变量，断言那边看不见（踩过：
  // mockWorkspaceExists is not defined）。
  let mockWorkspaceExists = true;
  // mock 那个「定时任务」工作区的目录：断言"注册表里躺着的是旧版默认目录（…/tesk）时**不许复用**"
  // 要能翻转它（2026-09-29 的 bug 正是被这种坏工作区粘住）。
  let mockWorkspacePath = '/tmp/schedule-ws';
  let workspaceCreateCalls = 0;
  const harness = () => {
    const handlers = {};
    const provided = {};
    // 定时任务那 4 个工具是**动态挂摘**的（跟着总开关走），断言要看这两个收集器。
    // ⚠️ 这两条 async 用例共用一个进程级 DSH_HOME，所以定时任务工具的验证必须写在
    // **同一条 check 里**串行做：check() 对 async 函数是立即调用的，两条 async 用例
    // 会并发跑，各自设 process.env.DSH_HOME 就会互相踩（踩过）。
    const tools = [];
    const sections = [];
    const ctx = {
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      // workspaceRegistry：定时任务绑定工作区要用。默认 mock 一个已存在的「定时任务」工作区，
      // 让解析走"按标题复用"分支（不 mkdir、不建目录，测试零副作用）。
      get: (name) => (name === 'workspaceRegistry'
        ? {
          list: () => (mockWorkspaceExists
            ? [{ id: 'ws-default', title: '定时任务', path: mockWorkspacePath }]
            : []),
          create: (target, label) => {
            workspaceCreateCalls += 1;
            throw new Error(`测试不该走到 create（${label}）`);
          },
        }
        : undefined),
      effect: (fn) => { const inner = typeof fn === 'function' ? fn() : undefined; return typeof inner === 'function' ? inner : () => {}; },
      inject: (_names, callback) => callback({
        webServer: { register: (spec) => { handlers[spec.path] = spec.handler; } },
        effect: (fn) => { const inner = fn(); return typeof inner === 'function' ? inner : () => {}; },
        credentials: {},
        tools: {
          register: (definition) => {
            tools.push(definition);
            // disposer 必须真的把工具摘掉，否则"整组注销"这件事在测试里观察不到。
            return () => { const index = tools.indexOf(definition); if (index >= 0) tools.splice(index, 1); };
          },
        },
        systemPrompt: { section: (spec) => { sections.push(spec); } },
      }),
      on: () => {},
      plugin: () => () => {},
      reflect: { provide: (name, value) => { provided[name] = value; } },
    };
    return { ctx, handlers, provided, tools, sections };
  };
  try {
    process.env.DSH_HOME = dir;
    process.env.DSH_HELPER_PATCH_SCHEDULE_LEGACY = join(dir, 'no-legacy.json');
    const configDir = join(dir, 'integrations', 'dsh-helper');
    mkdirSync(configDir, { recursive: true });
    // 1) 配置里关了 → 引擎必须从关态启动
    writeFileSync(join(configDir, 'config.json'), JSON.stringify({ scheduleEnabled: false }), 'utf8');
    const a = harness();
    apply(a.ctx);
    const engineA = a.provided['helperPatchSchedule'];
    assert.ok(engineA, '调度引擎必须被 provide');
    assert.equal(engineA.isArmed(), false, '配置为关时引擎要从关态启动');
    // 工具要跟着一起下线：模型看不到它们，才不会去建任务，也不会在「用哪种定时任务」
    // 的弹窗里让用户选一个已经停用的选项。
    assert.deepEqual(
      a.tools.map((tool) => tool.name).filter((n) => n !== 'send_file_to_im'), [],
      '关态下不该注册定时任务工具',
    );
    // 关态下建任务也不挂定时器（scheduledIds 就是为诊断"任务在、但没排定"这类失效留的）。
    const itemA = await engineA.create({ title: '自检', prompt: 'noop', cron: '0 9 * * *', enabled: true });
    assert.ok(!engineA.scheduledIds().includes(itemA.id), '关态下建任务不得挂定时器');
    // 2) curl 式 POST（无 Origin）改开关 → 立即生效，不用等重启
    const resA = fakeResponse();
    await a.handlers['/api/dsh-helper/config'](
      fakeRequest({ headers: { host: '127.0.0.1:3080', 'content-type': 'application/json' }, body: { scheduleEnabled: true } }),
      resA,
    );
    assert.equal(resA.status, 200);
    assert.equal(JSON.parse(resA.body).scheduleEnabled, true);
    assert.equal(engineA.isArmed(), true, 'POST 改总开关必须立即对齐引擎');
    assert.ok(engineA.scheduledIds().includes(itemA.id), '开关打开后 enabled 任务必须自动进入调度表（rescheduleAll）');
    // 工具也要挂回来，而且 create 必须真的落到这台 harness 的引擎上（不是只返回一个像样的结果）。
    assert.equal(
      a.tools.map((tool) => tool.name).filter((n) => n !== 'send_file_to_im').length, 4,
      'POST 打开总开关后 4 个定时任务工具要挂回来',
    );
    const createdByTool = await a.tools.find((tool) => tool.name === 'create_schedule_task')
      .execute({ title: '工具新建', prompt: 'noop', cron: '30 9 * * *' });
    assert.ok(createdByTool.id, 'create 要返回 id');
    // 回归点：自然语言建任务省略 workspacePath 时，必须绑定默认「定时任务」工作区，
    // 而不是落到引擎 defaultCwd（process.cwd()）——与面板 openNewForm 的行为对齐。
    assert.equal(createdByTool.workspacePath, '/tmp/schedule-ws', '省略 workspacePath 应绑定默认「定时任务」工作区');
    assert.ok(createdByTool.nextRuns.length > 0, '总开关开着时要给出下次触发时间');
    assert.equal(engineA.list().length, 2, 'create 必须真的落进引擎（原有 1 条 + 新建 1 条）');
    // ---- 定时任务工具的两个可用性回归（2026-09-28，用户报「提示词建的任务不在定时任务工作区下」）----
    {
      const createTool = a.tools.find((tool) => tool.name === 'create_schedule_task');
      const listTool = a.tools.find((tool) => tool.name === 'list_schedule_tasks');
      // ① id 必须出现在**回执文本**里。注意上面那条 `createdByTool.id` 断言并不覆盖这件事：
      //    模型拿到的是 render 的文本、不是 execute 的返回值。而 update / delete 都按 id 定位，
      //    systemPrompt 又明确写着"先 list 拿 id" —— list 原先不渲染 id，模型就只能拿标题去猜，
      //    delete 直接报「找不到定时任务「xxx」」（本次实测踩到）。
      const createPass = createTool.output.render({}, {
        id: 'item-abc-123', title: 'T', prompt: 'p', cron: '0 9 * * *', enabled: true,
        workspacePath: '/tmp/x', maxRuns: 0, runCount: 0, nextRuns: [],
      })[0].text;
      assert.ok(createPass.includes('item-abc-123'), `create 的回执必须带 id，实际：${createPass}`);
      const listPass = listTool.output.render({}, {
        armed: true,
        total: 1,
        items: [{
          id: 'item-abc-123', title: 'T', cron: '0 9 * * *', enabled: true,
          maxRuns: 0, runCount: 0, nextRuns: [], lastRunAt: '', lastRunError: '',
        }],
      })[0].text;
      assert.ok(listPass.includes('item-abc-123'), `list 的每一行都必须带 id，实际：${listPass}`);
      // ② workspacePath 的描述必须劝阻"按任务主题自己挑目录"。
      //    任务绑哪个工作区，执行出来的会话就落在哪个 cwd（引擎的 meta.cwd = workspace.path）。
      //    模型自选目录 → 任务在「定时任务」之外另建工作区 → 会话散落在那边，用户在侧栏的
      //    「定时任务」下找不到（用户报的正是这个：Temp/news-daily、Temp/hotspots 那批会话，
      //    目录都是建任务那一刻才被 mkdir 出来的，任何配置里都搜不到）。
      const wpDesc = String(createTool.parameters.properties.workspacePath.description ?? '');
      assert.ok(wpDesc.includes('省略') && wpDesc.includes('不要'),
        `workspacePath 的描述必须写明「通常省略」并劝阻自选目录，实际：${wpDesc.slice(0, 80)}`);
    }
    // ---- 建任务时**不建**工作区（用户 2026-09-28 口径：「为什么任务还没执行，都已经把工作区
    //      建立了？不用这样，他执行的时候应该会自动建立工作区」）----
    // "默认工作区还不存在"是最能暴露旧行为的一幕：以前会当场 mkdir + registry.create，于是
    // 用户还没让它跑过第一次，磁盘上先多一个空目录、侧栏里先多一个工作区 —— 而这条任务可能
    // 永远不执行（建完忘了 / cron 排在很久以后 / 建错了随手删）。现在只记路径，
    // 建的动作交给执行时的 tryAutoRecoverWorkspace。
    {
      mockWorkspaceExists = false;
      const before = workspaceCreateCalls;
      const createdNoWs = await a.tools.find((tool) => tool.name === 'create_schedule_task')
        .execute({ title: '默认工作区尚未存在', prompt: 'noop', cron: '40 9 * * *' });
      assert.equal(workspaceCreateCalls, before,
        '建任务时不该创建任何工作区 —— 创建要推迟到第一次执行时');
      // ⚠️ 这里必须钉**具体路径**，不能只断言"非空"：旧版默认目录正是
      // `join(process.cwd(), 'tesk')`，而宿主进程的 cwd 是 `/`（桌面端）或启动目录 ——
      // 只断言"非空"时 `/tesk`、`/usr/local/bin/tesk` 都能一路绿灯（2026-09-29 用户在新电脑上
      // 实测建出 `/usr/local/bin/tesk`，就是这么漏过去的）。
      assert.equal(createdNoWs.workspacePath, join(homedir(), '定时任务'),
        '默认目录必须是用户目录下的「定时任务」，不许跟着宿主进程的 cwd 走');
      assert.equal(createdNoWs.workspaceId ?? '', '', '此刻还不该有 workspaceId（工作区尚未创建）');
      await engineA.remove(createdNoWs.id);   // 清掉，别影响后面的计数断言
      mockWorkspaceExists = true;
    }
    // ---- 默认目录必须落在**用户目录**，不是宿主进程的 cwd ----
    // 用户 2026-09-29 报：「新电脑上以对话方式建任务，还是会自动乱建目录」
    // （实测建出 /usr/local/bin/tesk）。根因是默认目录写死成 join(process.cwd(), 'tesk')，
    // 而桌面端 App 的 cwd 是 `/`、命令行从哪个目录起来就是哪个目录。
    {
      mockWorkspaceExists = false;
      assert.equal(scheduleDefaultDir(), join(homedir(), '定时任务'), '默认目录 = 用户目录下的「定时任务」');
      assert.equal(engineA.resolveWorkspace('').workspacePath, join(homedir(), '定时任务'),
        '默认工作区还不存在时，记下的路径也必须是它');
      // 显式传旧版默认目录 → 同样改判回默认目录（不是"用户指定"）
      assert.equal(engineA.resolveWorkspace('/usr/local/bin/tesk').workspacePath, join(homedir(), '定时任务'),
        '旧版默认目录 …/tesk 要改判成默认目录');
      // 显式传 ~ → 必须展开（否则 resolve("~/x") = <cwd>/~/x，mkdir -p 真建一个叫 ~ 的目录）
      assert.equal(engineA.resolveWorkspace('~/Temp/report').workspacePath, join(homedir(), 'Temp/report'),
        '~ 必须展开成家目录');
      // 相对路径以家目录为基准，不再以 cwd 为基准
      assert.equal(engineA.resolveWorkspace('reports').workspacePath, join(homedir(), 'reports'),
        '相对路径以家目录为基准');
      // 注册表里那个标题「定时任务」的工作区若指向旧版默认目录 → **不许复用**（否则改判白做）
      mockWorkspaceExists = true;
      mockWorkspacePath = '/usr/local/bin/tesk';
      const legacyResolved = engineA.resolveWorkspace('');
      assert.equal(legacyResolved.workspaceId ?? '', '',
        '路径是旧版默认目录的工作区不能被复用 —— 复用等于把用户钉死在坏目录上');
      assert.equal(legacyResolved.workspacePath, join(homedir(), '定时任务'), '坏工作区要改判到默认目录');
      mockWorkspacePath = '/tmp/schedule-ws';
      // 路径正确的默认工作区照旧复用（这条是回归：改判不能把好的也一并丢掉）
      assert.equal(engineA.resolveWorkspace('').workspaceId, 'ws-default', '路径正确的默认工作区仍要复用');
      // 读盘改判：数据里记着 `<cwd>/tesk` 的老任务，load 后必须已经换到默认目录并丢掉坏 workspaceId
      const reviseDir = mkdtempSync(join(tmpdir(), 'helper-schedule-revise-'));
      const reviseFile = join(reviseDir, 'schedule.json');
      writeFileSync(reviseFile, JSON.stringify({
        version: 1,
        items: [{
          id: 'legacy-1', title: '老任务', prompt: 'noop', cron: '0 9 * * *', enabled: true,
          workspaceId: 'ws-legacy', workspacePath: '/usr/local/bin/tesk',
          createdAt: '2026-09-29T00:00:00.000Z', updatedAt: '2026-09-29T00:00:00.000Z', runs: [],
        }],
      }), 'utf8');
      const reviseEngine = createScheduleEngine({
        ctx: { get: () => undefined },
        file: reviseFile,
        logger: { info: () => {}, warn: () => {}, error: () => {} },
        t: (key) => key,
        defaultCwd: homedir(),
        armed: false,
        reviseWorkspacePath: (path) => reviseScheduleDir(path),
      });
      const revised = reviseEngine.list()[0];
      assert.equal(revised.workspacePath, join(homedir(), '定时任务'), 'load 时就要把旧版默认目录改判掉');
      assert.equal(revised.workspaceId ?? '', '', '改判后必须丢掉旧的 workspaceId（否则执行时又把它捞回来）');
      // 改判要落盘，否则每次启动都重来一遍（写链是异步的，等一拍再看文件）
      await new Promise((done) => setTimeout(done, 80));
      const persisted = JSON.parse(readFileSync(reviseFile, 'utf8'));
      assert.equal(persisted.items[0].workspacePath, join(homedir(), '定时任务'), '改判结果必须落盘');
      assert.equal(persisted.items[0].workspaceId ?? '', '', '落盘的记录里不该再有坏 workspaceId');
      reviseEngine.dispose();
      rmSync(reviseDir, { recursive: true, force: true });
      // 归一化 ≠ 改判：路径只差一个尾斜杠（宿主或手工编辑都可能留下）时，**有效的 workspaceId
      // 不许被丢掉** —— 丢了只是让任务退化成"执行时按路径重建"，白多一次 create 调用。
      // 判"改判过"必须比 resolve 之后的语义路径，不能只比字符串（2026-09-30 端到端测试发现）。
      const keepDir = mkdtempSync(join(tmpdir(), 'helper-schedule-keep-'));
      const keepFile = join(keepDir, 'schedule.json');
      writeFileSync(keepFile, JSON.stringify({
        version: 1,
        items: [{
          id: 'keep-1', title: '自定义目录', prompt: 'noop', cron: '0 9 * * *', enabled: true,
          workspaceId: 'ws-keep', workspacePath: `${keepDir}/`,
          createdAt: '2026-09-29T00:00:00.000Z', updatedAt: '2026-09-29T00:00:00.000Z', runs: [],
        }],
      }), 'utf8');
      const keepEngine = createScheduleEngine({
        ctx: { get: () => undefined },
        file: keepFile,
        logger: { info: () => {}, warn: () => {}, error: () => {} },
        t: (key) => key,
        defaultCwd: homedir(),
        armed: false,
        reviseWorkspacePath: (path) => reviseScheduleDir(path),
      });
      assert.equal(keepEngine.list()[0].workspaceId, 'ws-keep',
        '只是尾斜杠归一化，不该丢掉有效的 workspaceId');
      assert.equal(keepEngine.list()[0].workspacePath, keepDir, '路径仍要归一化到规范形态');
      keepEngine.dispose();
      rmSync(keepDir, { recursive: true, force: true });
      // 日志不许把主流程带崩：load 跑在 apply 期，那里抛错 = 整个插件没挂上（用户看到"功能消失"）。
      // 更不能因为一句 warn 抛错就走到"文件损坏"分支，把好文件改名成 .corrupt-*。
      const boomDir = mkdtempSync(join(tmpdir(), 'helper-schedule-boom-'));
      const boomFile = join(boomDir, 'schedule.json');
      writeFileSync(boomFile, JSON.stringify({
        version: 1,
        items: [{
          id: 'b1', title: 'B', prompt: 'p', cron: '0 9 * * *', enabled: true,
          workspacePath: '/usr/local/bin/tesk',
          createdAt: '2026-09-29T00:00:00.000Z', updatedAt: '2026-09-29T00:00:00.000Z', runs: [],
        }],
      }), 'utf8');
      const boomEngine = createScheduleEngine({
        ctx: { get: () => undefined },
        file: boomFile,
        // 宿主 logger 实现各异，这里模拟"一 warn 就抛"的最坏情况
        logger: { info: () => {}, error: () => {}, warn: () => { throw new Error('logger 炸了'); } },
        t: (key) => key,
        defaultCwd: homedir(),
        armed: false,
        reviseWorkspacePath: (path) => reviseScheduleDir(path),
      });
      assert.equal(boomEngine.list()[0].workspacePath, join(homedir(), '定时任务'),
        'logger 抛错也要完成改判（日志不该影响主流程）');
      assert.deepEqual(readdirSync(boomDir), ['schedule.json'],
        'logger 抛错时不许把好文件改名成 .corrupt-*');
      boomEngine.dispose();
      rmSync(boomDir, { recursive: true, force: true });
      mockWorkspaceExists = true;
    }
    // 单条停用/启用（面板行内按钮走的就是这条路径）：patch 只带 enabled（合并语义），
    // 定时器随之摘/挂，其它字段原样保留。
    const itemOff = await engineA.update(itemA.id, { enabled: false });
    assert.equal(itemOff.enabled, false, '停用要落到数据上');
    assert.equal(itemOff.title, '自检', '合并语义：未传的字段必须原样保留');
    assert.ok(!engineA.scheduledIds().includes(itemA.id), '停用后定时器必须摘除');
    const itemOn = await engineA.update(itemA.id, { enabled: true });
    assert.ok(engineA.scheduledIds().includes(itemOn.id), '重新启用后定时器必须挂回');
    // 3) 跨站 Origin 写 /config → 403，且配置没被动
    const resB = fakeResponse();
    await a.handlers['/api/dsh-helper/config'](
      fakeRequest({ headers: { host: '127.0.0.1:3080', 'content-type': 'text/plain;charset=UTF-8', origin: 'https://evil.example' }, body: { toUserId: 'attacker' } }),
      resB,
    );
    assert.equal(resB.status, 403);
    assert.match(readFileSync(join(configDir, 'config.json'), 'utf8'), /"scheduleEnabled":\s*true/, '跨站写入不得落到配置');
    // 4) 跨站 POST /send-file → 403，且发生在读文件之前（这里给个真路径也读不到）
    const resC = fakeResponse();
    await a.handlers['/api/dsh-helper/send-file'](
      fakeRequest({ headers: { host: '127.0.0.1:3080', 'content-type': 'text/plain;charset=UTF-8', origin: 'https://evil.example' }, body: { path: '/etc/hostname' } }),
      resC,
    );
    assert.equal(resC.status, 403);
    // 5) 跨站读 /restart/status → 同样拒绝
    const resD = fakeResponse();
    await a.handlers['/api/dsh-helper/restart/status'](
      fakeRequest({ method: 'GET', headers: { host: '127.0.0.1:3080', origin: 'https://evil.example' } }),
      resD,
    );
    assert.equal(resD.status, 403);
    // 5.5) 桌面端回归（2026-10-06 实测定案）：Electron 主进程的 forwardWebRequest 转发请求时
    //      会删掉 Origin，桌面端宿主环境带 DSH_CLIENT_VERSION。此时 status 必须给出
    //      reason='desktop'（按钮置灰），POST /restart 必须 403 desktop 而不是 untrusted。
    //      ⚠️ 这里的 mock 请求刻意**不带 Origin**，与桌面端真实请求同形；万一桌面端那一档
    //      没生效，请求会掉进 trustedRestartRequest 被拒（同样 403），**不会**走到
    //      scheduleRestart 把测试进程杀掉 —— 这条断言必须保持这个安全性质。
    process.env.DSH_CLIENT_VERSION = '0.2.0-rc.2';
    try {
      const resDesktopStatus = fakeResponse();
      await a.handlers['/api/dsh-helper/restart/status'](
        fakeRequest({ method: 'GET', headers: { host: '127.0.0.1:19387' } }),
        resDesktopStatus,
      );
      assert.equal(resDesktopStatus.status, 200);
      const desktopStatus = JSON.parse(resDesktopStatus.body);
      assert.equal(desktopStatus.allowed, false, '桌面端不许把重启按钮显示成可点（原先就是这里不一致）');
      assert.equal(desktopStatus.reason, 'desktop');
      assert.equal(desktopStatus.desktopHost, 'desktop');
      const resDesktopRestart = fakeResponse();
      await a.handlers['/api/dsh-helper/restart'](
        fakeRequest({ headers: { host: '127.0.0.1:19387' } }),
        resDesktopRestart,
      );
      assert.equal(resDesktopRestart.status, 403);
      assert.equal(JSON.parse(resDesktopRestart.body).reason, 'desktop',
        '桌面端要给出 desktop 理由，不能再是没头没尾的 untrusted');
      // 桌面端这一档必须排在来源闸**之前**：同一个无 Origin 请求，只要环境不是桌面端，
      // 就该按原样落到 untrusted —— 证明这一档没有把来源闸整体顶掉。
      delete process.env.DSH_CLIENT_VERSION;
      const resNonDesktopRestart = fakeResponse();
      await a.handlers['/api/dsh-helper/restart'](
        fakeRequest({ headers: { host: '127.0.0.1:19387' } }),
        resNonDesktopRestart,
      );
      assert.equal(resNonDesktopRestart.status, 403);
      assert.equal(JSON.parse(resNonDesktopRestart.body).reason, 'untrusted',
        '非桌面端的无 Origin 请求仍要被来源闸拒掉');
    } finally {
      delete process.env.DSH_CLIENT_VERSION;
    }
    // 6) 没有配置文件 → 默认开（与 ensureConfig 的默认值一致）
    dir2 = mkdtempSync(join(tmpdir(), 'hp-armed-'));
    process.env.DSH_HOME = dir2;
    const b = harness();
    apply(b.ctx);
    assert.equal(b.provided['helperPatchSchedule'].isArmed(), true, '无配置文件时默认从开态启动');
    // 7) 默认开态：4 个工具 + 一条判断引导；再关掉就整组摘掉（模型看不到就不该去建）
    const scheduleToolNames = (h) => h.tools.map((tool) => tool.name).filter((n) => n !== 'send_file_to_im').sort();
    assert.deepEqual(scheduleToolNames(b), [
      'create_schedule_task', 'delete_schedule_task', 'list_schedule_tasks', 'update_schedule_task',
    ], '默认开态下 4 个工具都要注册');
    assert.ok(
      b.sections.some((section) => section.name === 'dsh-helper:schedule-tasks'),
      '要有定时任务的判断引导小节（四态规则写在那里）',
    );
    // 两段引导都不给**子会话**：「该不该把文件发到用户微信」「该不该建一个每天自动跑的任务」
    // 都是用户级决定，要由主会话和用户商量。塞给 subagent 只是白占 token，更糟的是可能被
    // 诱导自作主张 —— 两者都有持久副作用。判据与 T专家 的 t-team:experts 小节一致。
    for (const name of ['dsh-helper:send-file', 'dsh-helper:schedule-tasks']) {
      const section = b.sections.find((entry) => entry.name === name);
      assert.ok(section, `${name} 这一小节应当已注册`);
      assert.equal(typeof section.text, 'function',
        `${name} 的 text 必须是函数：静态字符串没法按会话类型豁免（这是当初漏掉子会话的原因）`);
      const forParent = section.text({ agent: { session: { header: {} } } });
      assert.ok(forParent.length > 100, `${name} 对主会话要给出完整引导，实际只有 ${forParent.length} 字`);
      assert.equal(section.text({ agent: { session: { header: { parentSession: 'ses_parent' } } } }), '',
        `${name} 对子会话必须返回空串`);
      // 没有 parentSession 证据时按主会话处理（与 T专家 同一个判据：宁可多说，不要漏说）；
      // 且 context 缺失/为空都不该抛 —— 那会让整段 system prompt 组装失败。
      assert.ok(section.text({}).length > 100, `${name} 在拿不到会话信息时按主会话处理`);
      assert.ok(section.text(undefined).length > 100, `${name} 没有 context 时也不该抛`);
    }
    const resToolsOff = fakeResponse();
    await b.handlers['/api/dsh-helper/config'](
      fakeRequest({ headers: { host: '127.0.0.1:3080', 'content-type': 'application/json' }, body: { scheduleEnabled: false } }),
      resToolsOff,
    );
    assert.equal(resToolsOff.status, 200);
    assert.deepEqual(scheduleToolNames(b), [], '关掉总开关后 4 个工具必须整组注销');
    assert.equal(b.provided['helperPatchSchedule'].isArmed(), false, '工具与引擎要一起停');
    // 8) 失败侧的计数与止损语义。
    //    语义（2026-09-28 改）：**只有成功的运行消耗 maxRuns 配额**。改之前失败也计数，
    //    一个 maxRuns:1 的一次性任务失败一次就 enabled=false 永久停用 —— 用户看到的状态是
    //    「没成功却已停」，而且不会有任何重试机会。失败改为累计 failStreak，
    //    到 MAX_FAIL_STREAK 才自动停用（止损：坏提示词配分钟级 cron 会无限开新会话烧额度）。
    //    本步跑在"没有 agents 服务"的环境里 → 运行必然失败，正好覆盖失败这一侧；
    //    成功那一侧（消耗配额、跑满停用并落盘）在下面单独一条 check 里用 mock agents 覆盖。
    //    ⚠️ 先把 DSH_HOME 切回 dir：工具里的 assertSwitchOn 读的是**进程级** DSH_HOME，
    //    而上面第 7 步刚把它指到 dir2 并把那边的开关关掉了。
    const { MAX_FAIL_STREAK } = await import('../lib/schedule.js');
    process.env.DSH_HOME = dir;
    const once = await a.tools.find((t) => t.name === 'create_schedule_task')
      .execute({ title: '一次性', prompt: 'noop', cron: '0 9 28 9 *', maxRuns: 1 });
    assert.equal(once.maxRuns, 1, 'create 要回显次数上限');
    assert.ok(engineA.scheduledIds().includes(once.id), '刚建的限次任务应当先进入调度表');
    await engineA.runNow(once.id);   // 没有 agents 服务 → 这一次必然失败
    const afterOnce = engineA.list().find((item) => item.id === once.id);
    assert.equal(afterOnce.runCount, undefined, '失败的运行不该消耗 maxRuns 配额（否则一次性任务失败即永久停用）');
    assert.equal(afterOnce.failStreak, 1, '失败要累计连续失败次数');
    assert.equal(afterOnce.enabled, true, '失败一次不该停用（要留重试机会）');
    assert.ok(engineA.scheduledIds().includes(once.id), '失败一次后仍该留在调度表里');
    // 连续失败到阈值 → 自动停用 + 摘表（止损）
    for (let i = 1; i < MAX_FAIL_STREAK; i += 1) await engineA.runNow(once.id);
    const stopped = engineA.list().find((item) => item.id === once.id);
    assert.equal(stopped.failStreak, MAX_FAIL_STREAK, '连续失败次数要一直累计到阈值');
    assert.equal(stopped.enabled, false, `连续失败 ${MAX_FAIL_STREAK} 次必须自动停用（否则坏任务无限烧额度）`);
    assert.ok(!engineA.scheduledIds().includes(once.id), '停用后要顺手把定时器摘掉（scheduledIds 不该说谎）');
    const forever = await a.tools.find((t) => t.name === 'create_schedule_task')
      .execute({ title: '长期', prompt: 'noop', cron: '0 9 * * *' });
    assert.equal(forever.maxRuns, 0, '不限次时回 0（严格 schema 不接受 undefined）');
    await engineA.runNow(forever.id);
    const afterForever = engineA.list().find((item) => item.id === forever.id);
    assert.equal(afterForever.enabled, true, '失败没到阈值时不该停用');
    assert.equal(afterForever.failStreak, 1, '不限次的任务同样要累计连续失败次数');
    // 9) update 不能把 maxRuns 冲掉：merged 里漏了这个字段时，normalizeInput 会把它读成 null，
    //    紧接着的 `delete next.maxRuns` 就把上限抹了 —— 表现是"改个 cron 就变回每年跑"。
    await engineA.update(once.id, { cron: '30 9 28 9 *' });
    assert.equal(engineA.list().find((item) => item.id === once.id).maxRuns, 1, '改别的字段不能把次数上限冲掉');
    await engineA.update(once.id, { maxRuns: 0 });
    assert.equal(
      engineA.list().find((item) => item.id === once.id).maxRuns, undefined,
      '显式传 0 要能改回不限次数（旧上限必须被删掉，否则再也改不回来）',
    );
    // 10) 投递加固（可选，**默认全关**）：HTTP 口令 + 目录白名单。
    //     写在这条 check 里而不是单开一条：两条 async 用例共用进程级 DSH_HOME，
    //     check() 对 async 是立即调用的，分开写会并发互踩（文件头那条注释警告过）。
    const sendPath = '/api/dsh-helper/send-file';
    const configPath = '/api/dsh-helper/config';
    const localHeaders = { host: '127.0.0.1:3080', 'content-type': 'application/json' };
    const probe = async (body, headers = localHeaders) => {
      const res = fakeResponse();
      await a.handlers[sendPath](fakeRequest({ headers, body }), res);
      return { status: res.status, body: JSON.parse(res.body) };
    };
    const cfg = async (body, method = 'POST') => {
      const res = fakeResponse();
      await a.handlers[configPath](fakeRequest({ method, headers: localHeaders, body }), res);
      return JSON.parse(res.body);
    };
    // 10.1) 默认状态：既有的 curl 用法必须逐字节不受影响。
    //       用一个不存在的路径探测 —— 要一路走到"文件不存在"，才证明两道闸门都放行了。
    let out = await probe({ path: join(dir, 'nope.txt') });
    assert.equal(out.status, 500, '默认（未加固）时不该被闸门拦住');
    assert.match(out.body.error, /文件不存在/u, '默认关：要走到读文件那一步（证明口令与白名单都没拦）');
    // 10.2) 口令：不带 → 401；带错 → 401；带对 → 放行；明文永不出 host
    await cfg({ sendToken: 'secret-token' });
    const readBack = await cfg(undefined, 'GET');
    assert.equal('sendToken' in readBack, false, 'GET 绝不能回明文口令（这条路由同样对本机任意进程放行）');
    assert.equal(readBack.sendTokenSet, true, 'GET 要回「设没设」这一个比特，界面据此显示清除按钮');
    assert.ok(Array.isArray(readBack.sendAllowRoots), 'GET 要回白名单（它不是秘密，设置页要显示当前允许哪些目录）');
    out = await probe({ path: join(dir, 'nope.txt') });
    assert.equal(out.status, 401, '设了口令后，不带口令的本机请求必须 401');
    assert.equal(out.body.code, 'send-token-required', '要带机器可判断的码（脚本据此区分"没权限"与"发不出去"）');
    out = await probe({ path: join(dir, 'nope.txt') }, { ...localHeaders, 'x-dsh-helper-token': 'wrong' });
    assert.equal(out.status, 401, '口令错误同样 401');
    out = await probe({ path: join(dir, 'nope.txt') }, { ...localHeaders, 'x-dsh-helper-token': 'secret-token' });
    assert.match(out.body.error, /文件不存在/u, '请求头带对口令就该放行到下一层');
    out = await probe({ path: join(dir, 'nope.txt'), token: 'secret-token' });
    assert.match(out.body.error, /文件不存在/u, 'body 里的 token 也要认（curl 用户两种写法都顺手）');
    const cleared = await cfg({ sendToken: '' });
    assert.equal(cleared.sendTokenSet, false, '传空串要能清除口令（三段式：不传=不改、空串=清除）');
    out = await probe({ path: join(dir, 'nope.txt') });
    assert.match(out.body.error, /文件不存在/u, '清除后不带口令也要能用 —— 回到加固前的行为');
    // 10.3) 目录白名单：外部一律拒且错误可自查；**工具路径同样受限**
    const allowed = join(dir, 'allowed');
    mkdirSync(allowed, { recursive: true });
    const savedRoots = await cfg({ sendAllowRoots: [allowed] });
    assert.deepEqual(savedRoots.sendAllowRoots, [allowed], 'POST 要回显白名单');
    out = await probe({ path: join(dir, 'outside.txt') });
    assert.match(out.body.error, /不在允许投递的目录之内/u, '白名单外的路径要给出能自查的错');
    assert.match(
      out.body.error,
      new RegExp(allowed.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'),
      '错误里要列出允许的目录，否则用户不知道该填什么',
    );
    // 前缀相似但不是子目录：漏了路径分隔符就会把 allowed-evil 误判成 allowed 的子目录
    const sibling = `${allowed}-evil`;
    mkdirSync(sibling, { recursive: true });
    out = await probe({ path: join(sibling, 'x.txt') });
    assert.match(out.body.error, /不在允许投递的目录之内/u, '前缀相似的兄弟目录不能被误放行');
    // 白名单内：用一个**不存在**的文件探测 —— 要看到「文件不存在」而不是「不在允许投递的目录之内」，
    // 才说明闸门放行了。刻意不用真实存在的文件：那会一路走到 IM 后端、在测试里发起真实网络请求。
    out = await probe({ path: join(allowed, 'ghost.txt') });
    assert.match(out.body.error, /文件不存在/u, '白名单内的路径要走过闸门（这里因文件不存在而失败，不是被白名单拦的）');
    // 工具路径受同一道限制：只在 HTTP 侧挡的话，模型调用那条路就成了绕过白名单的后门
    const sendTool = a.tools.find((tool) => tool.name === 'send_file_to_im');
    assert.ok(sendTool, 'send_file_to_im 应当已注册');
    const toolOut = await sendTool.execute({ path: join(dir, 'outside.txt') })
      .catch((error) => ({ message: error?.message ?? String(error) }));
    const toolText = typeof toolOut === 'string' ? toolOut : JSON.stringify(toolOut ?? {});
    assert.match(toolText, /不在允许投递的目录之内/u, '工具路径也要受白名单限制（否则它就是绕过闸门的那道后门）');
    // 取消限制 → 恢复"任何本机路径都能投递"
    const emptied = await cfg({ sendAllowRoots: [] });
    assert.deepEqual(emptied.sendAllowRoots, [], '传空数组要能取消限制');
    out = await probe({ path: join(dir, 'outside.txt') });
    assert.match(out.body.error, /文件不存在/u, '取消限制后白名单外的路径也要能走到读文件那步');
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
    if (previousLegacy === undefined) delete process.env.DSH_HELPER_PATCH_SCHEDULE_LEGACY;
    else process.env.DSH_HELPER_PATCH_SCHEDULE_LEGACY = previousLegacy;
    rmSync(dir, { recursive: true, force: true });
    if (dir2 !== undefined) rmSync(dir2, { recursive: true, force: true });
  }
});

/* ------------------------------------------- 线格式 schema 不能漏字段（同步检查） */

check("线格式 schema 不能漏字段：新增的 maxRuns / runCount 必须能穿过快照与表单校验", async () => {
  // 回归点：zod 的 z.object 默认是 **strip** 模式 —— 引擎（与 remote）新增了字段、
  // 但 lib/schedule-schemas.js 没同步，字段过网关时会被**静默剥掉**。
  // 表现是"面板永远不显示限次信息、表单提交的上限被吃掉"，而所有别的测试都照过
  // （它们直接调 engine/工具，根本不经过 remote 的 schema）。这条专门盯这个缝。
  //
  // 用**真实引擎产出的 snapshot** 去过 schema，而不是手写一个 item —— 手写的只能证明
  // "schema 里有这个键"，证明不了"引擎真的会把它放进快照里"。
  const { scheduleSnapshotSchema, scheduleInputSchema } = await import('../lib/schedule-schemas.js');
  const { createScheduleEngine } = await import('../lib/schedule.js');
  const dir = mkdtempSync(join(tmpdir(), 'hp-schema-'));
  const file = join(dir, 'schedule.json');
  // 这条要的是**成功**的运行：失败不消耗 maxRuns 配额（见上面第 8 步的语义说明），
  // 用"没有 agents 服务"的 ctx 的话 runCount 永远是 undefined，字段能不能穿过 schema 就测不到了。
  const okCtx = {
    get: (name) => (name === 'agents'
      ? { create: async () => ({ agent: { session: { append() {} }, followup() {} } }) }
      : undefined),
  };
  const engine = createScheduleEngine({ ctx: okCtx, file, t: (k) => k, defaultCwd: tmpdir(), armed: true });
  try {
    await engine.create({ title: 't', prompt: 'p', cron: '0 9 28 9 *', maxRuns: 1 });
    const parsed = scheduleSnapshotSchema.parse(engine.snapshot());
    assert.equal(parsed.items[0].maxRuns, 1, 'maxRuns 必须能穿过快照 schema（否则面板收不到它）');
    assert.equal(parsed.items[0].runCount, undefined, '没跑过时 runCount 不该凭空出现');
    await engine.runNow(parsed.items[0].id);
    const after = scheduleSnapshotSchema.parse(engine.snapshot());
    assert.equal(after.items[0].runCount, 1, 'runCount 也要能穿过快照 schema');
    assert.equal(after.items[0].enabled, false, '跑满上限后停用状态要传得出去');
  } finally {
    engine.dispose();
    rmSync(dir, { recursive: true, force: true });
  }

  const withLimit = scheduleInputSchema.parse({ title: 't', prompt: 'p', cron: '0 9 * * *', enabled: true, maxRuns: 3 });
  assert.equal(withLimit.maxRuns, 3, 'maxRuns 必须能穿过表单 schema（否则面板提交的上限被剥掉）');
  const unlimited = scheduleInputSchema.parse({ title: 't', prompt: 'p', cron: '0 9 * * *', enabled: true, maxRuns: 0 });
  assert.equal(unlimited.maxRuns, 0, '0（不限次数）也要能过');
  const legacy = scheduleInputSchema.parse({ title: 't', prompt: 'p', cron: '0 9 * * *', enabled: true });
  assert.equal(legacy.maxRuns, undefined, '老客户端不传 maxRuns 时要保持向后兼容');
});

/* --------------------- 执行窗口里的并发变更（回归：删除复活 / 更新被覆盖） */

check("执行窗口里的并发变更：删除不能复活、修改不能被旧快照覆盖", async () => {
  // 回归点（2026-09-28）：runScheduled / runNow 原先在 execute 之后无条件 items.set(id, updated)，
  // 而 updated 是 withRun 用**执行开始时**那份 item 展开出来的。execute 内部有真实的 await 窗口
  // （agents.create 建会话 + followup 提交提示词，实测数百毫秒），窗口里用户完全可能删掉或改过
  // 这条事项，整体写回于是造成两种静默损坏：
  //   · 删除被撤销 → 任务复活并落盘；宿主一重启 rescheduleAll() 又给它挂上定时器，
  //     用户以为删掉了，它第二天照常跑；
  //   · 修改被覆盖 → 更隐蔽：update() 当时已按**新** cron 重挂了定时器，items 却被写回旧值，
  //     于是面板显示的 cron 与实际触发的 cron 不一致，要到下次重启才对齐。
  // 修法是 mergeRunResult：只取运行记录字段、以 items 里的当前值为基底合并，已删除就丢弃结果。
  // runScheduled 与 runNow 共用这一个函数，所以下面用 runNow 覆盖即等价覆盖定时触发路径。
  const { createScheduleEngine } = await import('../lib/schedule.js');
  const { scheduleSnapshotSchema } = await import('../lib/schedule-schemas.js');
  const mk = () => {
    const dir = mkdtempSync(join(tmpdir(), 'hp-race-'));
    // 把执行窗口撑到 200ms，好让断言能可靠地落在窗口里。
    const ctx = {
      get: (name) => (name === 'agents'
        ? {
          create: async () => {
            await new Promise((resolve) => setTimeout(resolve, 200));
            return { agent: { session: { append() {} }, followup() {} } };
          },
        }
        : undefined),
    };
    return { dir, engine: createScheduleEngine({ ctx, file: join(dir, 'schedule.json'), t: (k) => k, defaultCwd: dir, armed: true }) };
  };
  const inWindow = () => new Promise((resolve) => setTimeout(resolve, 60));

  // A) 执行期间删除 → 内存与磁盘都不许把它写回来
  {
    const { dir, engine } = mk();
    try {
      const item = await engine.create({ title: '每天 9 点', prompt: 'p', cron: '0 9 * * *' });
      const running = engine.runNow(item.id);
      await inWindow();
      await engine.remove(item.id);
      assert.equal(engine.list().length, 0, '删除后立刻查应当是空的');
      // 手动路径要报"事项不存在"：把一份已删除的快照当成功结果返回，面板会渲染一条根本不存在的事项。
      // （定时触发路径 runScheduled 走的是静默丢弃 —— 那边没人接异常。）
      await assert.rejects(running, /itemMissing/u, 'runNow 应当报错，而不是返回已删除事项的旧快照');
      assert.equal(engine.list().length, 0, '执行收尾后不许把已删除的任务写回内存');
      const disk = JSON.parse(readFileSync(join(dir, 'schedule.json'), 'utf8')).items;
      assert.equal(disk.length, 0, '更不许落盘 —— 落盘后宿主一重启就会重新调度它');
      assert.equal(engine.scheduledIds().length, 0, '定时器也不该留着');
    } finally {
      engine.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  }

  // B) 执行期间修改 → 改动必须保住，同时运行记录仍要记上
  {
    const { dir, engine } = mk();
    try {
      // 带上 maxRuns：顺便验证"合并只动运行记录字段"时，配额计数照常推进、上限不被修改冲掉。
      const item = await engine.create({ title: '旧标题', prompt: '旧提示词', cron: '0 9 * * *', maxRuns: 5 });
      const running = engine.runNow(item.id);
      await inWindow();
      await engine.update(item.id, { title: '新标题', prompt: '新提示词', cron: '30 22 * * *' });
      await running;
      const now = engine.list()[0];
      assert.equal(now.title, '新标题', '执行窗口里的改名不许被旧快照覆盖');
      assert.equal(now.cron, '30 22 * * *', '执行窗口里改的 cron 不许被覆盖（否则面板显示与实际触发不一致）');
      assert.equal(now.prompt, '新提示词', '提示词同理');
      assert.equal(now.runs.length, 1, '合并只覆盖运行记录字段，运行本身仍要记上');
      assert.equal(now.runCount, 1, '成功的运行照常消耗配额');
      assert.equal(now.maxRuns, 5, '次数上限也不该被合并冲掉');
      assert.equal(now.enabled, true, '配额没用满就不该停用');
    } finally {
      engine.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  }

  // C) 执行窗口里被停用/启用 → 用户意图优先；系统因跑满上限的停用仍然生效
  {
    const { dir, engine } = mk();
    try {
      const item = await engine.create({ title: 'c', prompt: 'p', cron: '0 9 * * *', enabled: true });
      const running = engine.runNow(item.id);
      await inWindow();
      await engine.update(item.id, { enabled: false });
      await running;
      assert.equal(engine.list()[0].enabled, false, '用户在执行窗口里手动停用的意图必须保住');
      assert.equal(engine.scheduledIds().length, 0, '停用后定时器要摘掉');
    } finally {
      engine.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  }

  // D) failStreak 也要能穿过线格式（漏声明就会被 zod strip，面板只能看到一个光秃秃的停用状态）
  {
    const dir = mkdtempSync(join(tmpdir(), 'hp-failstreak-'));
    /** @type {ReturnType<typeof createScheduleEngine> | undefined} */
    let bad;
    try {
      bad = createScheduleEngine({
        ctx: { get: () => undefined },   // 没有 agents 服务 → 运行必然失败
        file: join(dir, 'schedule.json'), t: (k) => k, defaultCwd: dir, armed: true,
      });
      const item = await bad.create({ title: 'd', prompt: 'p', cron: '0 9 * * *' });
      await bad.runNow(item.id);
      const parsed = scheduleSnapshotSchema.parse(bad.snapshot());
      assert.equal(parsed.items[0].failStreak, 1, 'failStreak 必须能穿过快照 schema（否则面板看不出为什么被停用）');
      assert.equal(typeof parsed.items[0].lastRunError, 'string', '失败原因也要传得出去');
      assert.equal(parsed.items[0].runCount, undefined, '失败的运行不该出现在配额计数里');
    } finally {
      bad?.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

/* --------------------------------------------- 投递加固的纯函数（口令 + 目录白名单） */

check('投递加固：口令比较、白名单归一化与前缀判断', async () => {
  const {
    expandTilde, normalizeAllowRoots, pathWithinRoots, describePathDenial,
    tokenMatches, pickSendToken, realpathDeepest,
  } = await import('../lib/index.js');
  const { homedir, tmpdir } = await import('node:os');
  const { join, resolve, sep } = await import('node:path');

  // --- expandTilde：设置页的说明里写了「可用 ~ 表示家目录」，host 就必须真的认
  assert.equal(expandTilde('~'), homedir(), '光一个 ~ 要展开成家目录');
  assert.equal(expandTilde(`~${sep}Downloads`), join(homedir(), 'Downloads'), '~/x 要展开成家目录下的 x');
  assert.equal(expandTilde('/abs/path'), '/abs/path', '绝对路径原样');
  assert.equal(expandTilde('~user/x'), '~user/x', '~user/ 这种 shell 展开刻意不支持（原样留着，稍后会因路径不存在而失败，而不是静默指向别处）');

  // --- tokenMatches：没设口令 = 不启用（这是「默认关」的语义所在）
  assert.equal(tokenMatches('', 'anything'), true, '未设口令时一律放行（默认关，既有 curl 用法不受影响）');
  assert.equal(tokenMatches(undefined, 'x'), true, '字段缺失同样视为未启用');
  assert.equal(tokenMatches('secret', 'secret'), true, '口令正确要放行');
  assert.equal(tokenMatches('secret', 'secretx'), false, '口令错误要拒');
  assert.equal(tokenMatches('secret', 'secret'), true, '长度相同也要逐字节比');
  assert.equal(tokenMatches('secret', ''), false, '设了口令却不带 → 拒');
  assert.equal(tokenMatches('secret', undefined), false, '设了口令而请求里没有 → 拒');
  assert.equal(tokenMatches('a'.repeat(64), 'a'.repeat(63)), false, '长度不同要拒（且不能让 timingSafeEqual 抛出去）');

  // --- pickSendToken：header 优先，body 兜底
  assert.equal(pickSendToken({ headers: { 'x-dsh-helper-token': 'h' } }, { token: 'b' }), 'h', '请求头优先于 body');
  assert.equal(pickSendToken({ headers: { 'x-dsh-helper-token': ['h1', 'h2'] } }, {}), 'h1', '重复头取第一个（Node 会把重复头收成数组）');
  assert.equal(pickSendToken({ headers: {} }, { token: 'b' }), 'b', '没有头时用 body 的 token');
  assert.equal(pickSendToken({ headers: {} }, {}), '', '两处都没有 → 空串');
  assert.equal(pickSendToken(undefined, undefined), '', '缺参数也不该抛');

  // --- pathWithinRoots：空列表 = 未启用 = 一律放行
  assert.equal(pathWithinRoots('/etc/passwd', []), true, '未设白名单时任何路径都放行（默认关）');
  assert.equal(pathWithinRoots('/etc/passwd', undefined), true, '字段缺失同样视为未启用');
  const root = join(tmpdir(), 'hp-allow');
  assert.equal(pathWithinRoots(root, [root]), true, '目录本身算命中');
  assert.equal(pathWithinRoots(join(root, 'a', 'b.txt'), [root]), true, '子目录里的文件算命中');
  assert.equal(pathWithinRoots(join(tmpdir(), 'other', 'x'), [root]), false, '白名单外要拒');
  // 前缀相似但不是子目录：少了分隔符判断就会把 allowed-evil 当成 allowed 的子目录
  assert.equal(pathWithinRoots(`${root}-evil${sep}x`, [root]), false, '前缀相似的兄弟目录不能被误放行');
  assert.equal(pathWithinRoots(`${root}X`, [root]), false, '同前缀的另一个名字也不能被误放行');
  assert.equal(pathWithinRoots(join(root, 'x'), [join(tmpdir(), 'nope'), root]), true, '多条白名单里命中任意一条即可');
  assert.equal(pathWithinRoots('', [root]), false, '空路径要拒');
  assert.match(describePathDenial('/x/y', [root]), /不在允许投递的目录之内/u, '拒绝文案要说清是什么问题');
  assert.match(describePathDenial('/x/y', [root]), new RegExp(root.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'), '拒绝文案要列出允许的目录，用户才知道该填什么');

  // --- normalizeAllowRoots：过滤 + 展开 + realpath
  assert.deepEqual(normalizeAllowRoots(undefined), [], '非数组一律归一化成空列表（= 不限制）');
  assert.deepEqual(normalizeAllowRoots([]), [], '空列表保持空');
  assert.deepEqual(normalizeAllowRoots(['', '   ', 42, null]), [], '空串与非字符串要被过滤掉（否则会变成一条指向 cwd 的白名单）');
  assert.deepEqual(normalizeAllowRoots(['~/Downloads']), [realpathDeepest(join(homedir(), 'Downloads'))], '~ 要展开后再归一化');
  assert.equal(
    normalizeAllowRoots([resolve(tmpdir())])[0],
    realpathDeepest(resolve(tmpdir())),
    '白名单目录本身要 realpath（macOS 上 /var → /private/var）',
  );

  // --- realpathDeepest：两侧规则必须一致，否则合法路径会被误拒
  const dir = mkdtempSync(join(tmpdir(), 'hp-realpath-'));
  try {
    assert.equal(realpathDeepest(dir), realpathSync(dir), '存在的目录直接 realpath');
    // 关键场景：文件还不存在，但父目录存在 —— 必须 realpath 父目录再拼回来，
    // 否则 macOS 上 tmpdir() 的 /var/... 与白名单的 /private/var/... 对不上而被误拒。
    assert.equal(
      realpathDeepest(join(dir, 'ghost.txt')),
      join(realpathSync(dir), 'ghost.txt'),
      '文件不存在时要 realpath 最近的存在祖先再拼回尾部',
    );
    assert.equal(
      realpathDeepest(join(dir, 'a', 'b', 'c.txt')),
      join(realpathSync(dir), 'a', 'b', 'c.txt'),
      '多层不存在也要一路拼回来',
    );
    assert.equal(realpathDeepest(sep), sep, '根路径原样返回，不该无限上溯');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------------------- tsconfig 与 // @ts-check 标记必须对得上 */

check('每个标了 // @ts-check 的自研文件都在 tsconfig 的 include 里（否则那个标记是死的）', () => {
  // 回归点：`// @ts-check` 只在文件被 tsc **读到**时才有意义。这个仓库原先有 4 个文件标了它，
  // 但既没有 tsconfig.json 也没有 typecheck 脚本 —— 那些标记一直是死的，类型写错也没人拦。
  // 0.12.0 补上 tsconfig 后第一次 typecheck 就抓出两个真问题：createScheduleEngine 漏写
  // migrationNotice 的 @param（TS2339），以及 businessError 的 fallbackCode 缺类型标注
  // 导致整个三元表达式退化成 any、那道 @ts-expect-error 从来没生效过（TS2578 unused）。
  //
  // 这条盯的是"别再退回去"：新增 @ts-check 文件时必须同步 include，反之 include 里
  // 也不该留着已经删掉或已经摘掉标记的文件（那会让人以为它还在被检查）。
  const repo = fileURLToPath(new URL('..', import.meta.url));
  const tsconfig = JSON.parse(readFileSync(join(repo, 'tsconfig.json'), 'utf8'));
  const include = Array.isArray(tsconfig.include) ? tsconfig.include : [];
  const marked = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      // **递归**：T专家 那份同类自检用的是非递归 readdirSync，于是 lib/skill-gate/ 整个
      // 子目录里的 6 个 @ts-check 文件都不在它视野内 —— 同一个坑这里不再踩一次。
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.name.endsWith('.js')) continue;
      const head = readFileSync(full, 'utf8').slice(0, 400);
      if (head.includes('@ts-check')) marked.push(relative(repo, full).split('\\').join('/'));
    }
  };
  for (const dir of ['lib', 'src']) {
    const full = join(repo, dir);
    if (existsSync(full)) walk(full);
  }
  assert.ok(marked.length >= 4, `应当扫到标了 @ts-check 的自研文件，实际 ${marked.length} 个（是不是目录结构变了？）`);
  const missing = marked.filter((file) => !include.includes(file));
  assert.deepEqual(missing, [], `这些文件标了 // @ts-check 却不在 tsconfig 的 include 里，标记是死的：${missing.join(', ')}`);
  const stale = include.filter((file) => !marked.includes(file));
  assert.deepEqual(stale, [], `tsconfig 的 include 里这些条目已经没有对应的 @ts-check 文件（改名/删除/摘标记了？）：${stale.join(', ')}`);
  // typecheck 必须真的挂在自检链上，否则 tsconfig 只是摆设
  const pkg = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts.typecheck, 'tsc -p tsconfig.json', '要有 typecheck 脚本');
  assert.match(pkg.scripts.verify ?? '', /typecheck/u, 'verify 必须包含 typecheck（否则本地自检跑不到它）');
  assert.match(pkg.scripts.prepublishOnly ?? '', /verify/u, 'prepublishOnly 必须跑 verify：发布前漏跑自检是这个仓库踩过的坑（docs/PUBLISHING.md 里写着"要手动跑"）');
});

/* ---------------------------------------------------------------- 输出 */

await Promise.all(pending);

console.log(results.join('\n'));
console.log(process.exitCode === 1
  ? '\nhost 冒烟：失败'
  : `\nhost 冒烟：全部通过（${results.length} 项）`);

// 文档不许说谎：核对 docs/DEVELOPMENT.md 自检表里写的项数（理由与写法见 client-smoke 末尾那段）。
try {
  const doc = readFileSync(new URL('../docs/DEVELOPMENT.md', import.meta.url), 'utf8');
  const claimed = /^\| `npm run host-smoke` \|.*\|\s*(\d+)\s*项\s*\|$/mu.exec(doc)?.[1];
  if (claimed !== undefined && Number(claimed) !== results.length) {
    console.log(`  ✗ docs/DEVELOPMENT.md 的自检表说 host-smoke 是 ${claimed} 项，实际 ${results.length} 项（加了测试就同步那三个数字）`);
    process.exitCode = 1;
  }
} catch {
  /* 文档读不到就跳过：核对文档不该成为冒烟本身的失败原因 */
}
