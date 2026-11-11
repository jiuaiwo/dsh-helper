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
} from '../lib/index.js';
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
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
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

/**
 * 凡是改 `process.env.DSH_HOME` 的用例都过这把锁。
 *
 * `check()` 对 async 函数是立即调用的：两条 async 用例各自 mkdtemp 再改同一个进程级 env，
 * 就会互相踩（曾经踩过，当时是把几段合并成一条 check 绕开的）。这里改成排队执行，
 * 比"合并成一条"更容易维护，也让每条用例保住自己的名字。
 */
let dshHomeQueue = Promise.resolve();
const withDshHome = (run) => {
  const next = dshHomeQueue.then(run, run);
  dshHomeQueue = next.then(() => {}, () => {});
  return next;
};

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
    // 顺便放一个非配置文件的普通数据文件：迁移是**整目录搬**，不能只搬 config.json。
    writeFileSync(join(legacy, 'data.json'), '{"items":[{"id":"t1"}]}');

    ensureDataDirMigrated();

    assert.equal(readFileSync(join(current, 'config.json'), 'utf8'), '{"enabled":true}', 'config.json 要跟着搬');
    assert.equal(readFileSync(join(current, 'data.json'), 'utf8'), '{"items":[{"id":"t1"}]}',
      '旧目录里的其它文件要跟着整目录一起搬（不能只搬 config.json）');
    assert.equal(existsSync(legacy), false, '旧目录要搬走（是搬运，不是复制留一份）');
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

/* ------------------------------------------ HTTP 路由接线与投递加固（回归） */

check('HTTP 路由：跨站来源全拒 + 桌面端重启降级 + 投递加固 + send-file 引导', () => withDshHome(async () => {
  // 这条盯的是三条同源路由的**接线**（纯函数在下一章单独钉）：
  //   · 跨站写入一律 403，且拒绝发生在任何副作用之前；
  //   · 桌面端的重启降级（Electron 主进程转发请求时会剥掉 Origin）；
  //   · 投递加固（可选口令 + 目录白名单）在 HTTP 与工具两条入口上行为一致；
  //   · send-file 的 systemPrompt 引导对子会话闭嘴。
  const { apply } = await import('../lib/index.js');
  const dir = mkdtempSync(join(tmpdir(), 'hp-http-'));
  const previousHome = process.env.DSH_HOME;
  const fakeRequest = ({ method = 'POST', headers = {}, body, raw, remoteAddress = '127.0.0.1' } = {}) => ({
    method,
    socket: { remoteAddress },
    headers,
    // handleSendRequest 会在 request 上挂 'close' 监听（客户端断开就取消上游投递），
    // 真实的 IncomingMessage 本来就是 EventEmitter；这里给一对空实现即可 ——
    // 测试不需要真的触发 close，只需要那两行调用不抛。
    once() { return this; },
    off() { return this; },
    // readJsonBody 对 request 做 for-await：一个 async 生成器就够。
    // raw 用来喂**非法** JSON（传 body 只会被正确序列化，测不出解析失败那条路径）。
    [Symbol.asyncIterator]: function* () {
      if (raw !== undefined) yield Buffer.from(raw);
      else if (body !== undefined) yield Buffer.from(JSON.stringify(body));
    },
  });
  const fakeResponse = () => ({
    destroyed: false, writableEnded: false, status: undefined, body: undefined,
    writeHead(status) { this.status = status; },
    end(body) { this.body = body; this.writableEnded = true; },
  });
  const harness = () => {
    const handlers = {};
    const tools = [];
    const sections = [];
    const ctx = {
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      get: () => undefined,
      effect: (fn) => { const inner = typeof fn === 'function' ? fn() : undefined; return typeof inner === 'function' ? inner : () => {}; },
      inject: (_names, callback) => callback({
        webServer: { register: (spec) => { handlers[spec.path] = spec.handler; } },
        effect: (fn) => { const inner = fn(); return typeof inner === 'function' ? inner : () => {}; },
        credentials: {},
        tools: { register: (definition) => { tools.push(definition); return () => {}; } },
        systemPrompt: { section: (spec) => { sections.push(spec); } },
      }),
      on: () => {},
      plugin: () => () => {},
      reflect: { provide: () => {} },
    };
    return { ctx, handlers, tools, sections };
  };
  try {
    process.env.DSH_HOME = dir;
    const configDir = join(dir, 'integrations', 'dsh-helper');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, 'config.json'), JSON.stringify({ toUserId: 'me' }), 'utf8');
    const a = harness();
    apply(a.ctx);

    // 1) 跨站 Origin 写 /config → 403，且配置没被动
    const resB = fakeResponse();
    await a.handlers['/api/dsh-helper/config'](
      fakeRequest({ headers: { host: '127.0.0.1:3080', 'content-type': 'text/plain;charset=UTF-8', origin: 'https://evil.example' }, body: { toUserId: 'attacker' } }),
      resB,
    );
    assert.equal(resB.status, 403);
    assert.match(readFileSync(join(configDir, 'config.json'), 'utf8'), /"toUserId":\s*"me"/, '跨站写入不得落到配置');

    // 1.5) 坏 JSON 是**客户端**错误（400），不是宿主故障（500）——
    //      写成 500 会让脚本当成"服务端挂了"去重试一个永远不可能成功的请求。
    const resBadJson = fakeResponse();
    await a.handlers['/api/dsh-helper/config'](
      fakeRequest({ headers: { host: '127.0.0.1:3080', 'content-type': 'application/json' }, raw: '{not json' }),
      resBadJson,
    );
    assert.equal(resBadJson.status, 400, `坏 JSON 应当 400，实际 ${resBadJson.status}`);

    // 2) 跨站 POST /send-file → 403，且发生在读文件之前（这里给个真路径也读不到）
    const resC = fakeResponse();
    await a.handlers['/api/dsh-helper/send-file'](
      fakeRequest({ headers: { host: '127.0.0.1:3080', 'content-type': 'text/plain;charset=UTF-8', origin: 'https://evil.example' }, body: { path: '/etc/hostname' } }),
      resC,
    );
    assert.equal(resC.status, 403);

    // 3) 跨站读 /restart/status → 同样拒绝
    const resD = fakeResponse();
    await a.handlers['/api/dsh-helper/restart/status'](
      fakeRequest({ method: 'GET', headers: { host: '127.0.0.1:3080', origin: 'https://evil.example' } }),
      resD,
    );
    assert.equal(resD.status, 403);

    // 4) 桌面端回归（2026-10-06 实测定案）：Electron 主进程的 forwardWebRequest 转发请求时
    //    会删掉 Origin，桌面端宿主环境带 DSH_CLIENT_VERSION。此时 status 必须给出
    //    reason='desktop'（按钮置灰），POST /restart 必须 403 desktop 而不是 untrusted。
    //    ⚠️ 这里的 mock 请求刻意**不带 Origin**，与桌面端真实请求同形；万一桌面端那一档
    //    没生效，请求会掉进 trustedRestartRequest 被拒（同样 403），**不会**走到
    //    scheduleRestart 把测试进程杀掉 —— 这条断言必须保持这个安全性质。
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

    // 5) send-file 的 systemPrompt 引导不给**子会话**：「该不该把文件发到用户微信」是
    //    用户级决定，要由主会话和用户商量。塞给 subagent 只是白占 token，更糟的是可能被
    //    诱导自作主张把中间产物直接发进用户微信。判据与 T专家 的 t-team:experts 小节一致。
    {
      const section = a.sections.find((entry) => entry.name === 'dsh-helper:send-file');
      assert.ok(section, 'dsh-helper:send-file 这一小节应当已注册');
      assert.equal(typeof section.text, 'function',
        'text 必须是函数：静态字符串没法按会话类型豁免（这是当初漏掉子会话的原因）');
      const forParent = section.text({ agent: { session: { header: {} } } });
      assert.ok(forParent.length > 100, `对主会话要给出完整引导，实际只有 ${forParent.length} 字`);
      assert.equal(section.text({ agent: { session: { header: { parentSession: 'ses_parent' } } } }), '',
        '对子会话必须返回空串');
      // 没有 parentSession 证据时按主会话处理（与 T专家 同一个判据：宁可多说，不要漏说）；
      // 且 context 缺失/为空都不该抛 —— 那会让整段 system prompt 组装失败。
      assert.ok(section.text({}).length > 100, '在拿不到会话信息时按主会话处理');
      assert.ok(section.text(undefined).length > 100, '没有 context 时也不该抛');
    }

    // 6) 投递加固（可选，**默认全关**）：HTTP 口令 + 目录白名单。
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
    // 6.1) 默认状态：既有的 curl 用法必须逐字节不受影响。
    //      用一个不存在的路径探测 —— 要一路走到"文件不存在"，才证明两道闸门都放行了。
    let out = await probe({ path: join(dir, 'nope.txt') });
    assert.equal(out.status, 500, '默认（未加固）时不该被闸门拦住');
    assert.match(out.body.error, /文件不存在/u, '默认关：要走到读文件那一步（证明口令与白名单都没拦）');
    // 6.2) 口令：不带 → 401；带错 → 401；带对 → 放行；明文永不出 host
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
    // 6.3) 目录白名单：外部一律拒且错误可自查；**工具路径同样受限**
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
    rmSync(dir, { recursive: true, force: true });
  }
}));

check('收件人解析：换了账号就绝不用上一个账号的收件人', async () => {
  // 多账号场景最阴的一类错：不报错、对方也收得到，只是收错了人。
  // 配置里只有一个 toUserId，它属于配置里那个账号；一旦模型按用户要求换了账号，
  // 还拿它发就会发到"上一个人"的微信上。
  const { pickDshImRecipient } = await import('../lib/index.js');
  const { pickImConnectRecipient } = await import('../src/host/im-connect.js');

  const me = { botId: 'wx_me', ownerUserId: 'user-me' };
  const other = { botId: 'wx_other', ownerUserId: 'user-other' };

  // 选中就是配置里的账号 → 用配置里的收件人
  assert.equal(
    pickDshImRecipient(me, { configuredBotId: 'wx_me', configuredToUserId: 'user-me-config' }),
    'user-me-config',
  );
  // 换了账号 → 必须回落到该账号自己的主人，不能沿用配置里的
  assert.equal(
    pickDshImRecipient(other, { configuredBotId: 'wx_me', configuredToUserId: 'user-me-config' }),
    'user-other',
    '换账号后仍用配置里的收件人 = 发到上一个人的微信',
  );
  // 显式收件人压过一切
  assert.equal(
    pickDshImRecipient(other, { explicitToUserId: 'user-x', configuredBotId: 'wx_me', configuredToUserId: 'user-me-config' }),
    'user-x',
  );
  // 会话推断只在同一账号时生效
  assert.equal(
    pickDshImRecipient(me, { inferredBotId: 'wx_me', inferredToUserId: 'user-sender', configuredToUserId: 'user-me-config' }),
    'user-sender',
  );
  assert.equal(
    pickDshImRecipient(other, { inferredBotId: 'wx_me', inferredToUserId: 'user-sender' }),
    'user-other',
    '推断出来的收件人属于另一个账号，不能跨账号套用',
  );
  // 只填了 toUserId 没填 botId：默认账号照用（用户的直觉）
  assert.equal(pickDshImRecipient(me, { configuredToUserId: 'user-me-config' }), 'user-me-config');
  // 什么都没有 → 空串，由调用方报"没有可用收件人"
  assert.equal(pickDshImRecipient({}, {}), '');

  // im-connect 同一套规则（账号 id 是 channels 的 key）
  const icMe = { id: 'weixin_me', config: { allowedUserId: 'ic-me' } };
  const icOther = { id: 'weixin_other', config: { allowedUserId: 'ic-other' } };
  assert.equal(
    pickImConnectRecipient(icMe, { configuredBotId: 'weixin_me', configuredToUserId: 'ic-me-config' }),
    'ic-me-config',
  );
  assert.equal(
    pickImConnectRecipient(icOther, { configuredBotId: 'weixin_me', configuredToUserId: 'ic-me-config' }),
    'ic-other',
    'im-connect 同样不许跨账号套用配置里的收件人',
  );
  assert.equal(pickImConnectRecipient(icMe, { explicitToUserId: 'ic-explicit' }), 'ic-explicit');
  assert.equal(pickImConnectRecipient({ id: 'weixin_x' }, {}), '');
});

check('多账号且没指定收件人时拒绝投递（fail-closed，不发错人）', () => withDshHome(async () => {
  // 引导是软约束：模型不照做时也要有硬防线。同后端有多个可用账号、而调用方与配置都没点名时，
  // 直接拒绝——"拿第一个试试"的代价是发到别人微信上，而且不报错。
  const { apply } = await import('../lib/index.js');
  const home = mkdtempSync(join(tmpdir(), 'hp-failclosed-'));
  const previousHome = process.env.DSH_HOME;
  try {
    process.env.DSH_HOME = home;
    mkdirSync(join(home, 'integrations', 'dsh-weixin'), { recursive: true });
    mkdirSync(join(home, 'integrations', 'dsh-helper'), { recursive: true });
    writeFileSync(join(home, 'integrations', 'dsh-weixin', 'config.json'), JSON.stringify({
      version: 1,
      accounts: [{ botId: 'wx_a', ownerUserId: 'u-a' }, { botId: 'wx_b', ownerUserId: 'u-b' }],
    }), 'utf8');
    const configFile = join(home, 'integrations', 'dsh-helper', 'config.json');
    writeFileSync(configFile, JSON.stringify({ enabled: true }), 'utf8');
    const payload = join(home, 'file.txt');
    writeFileSync(payload, 'hello', 'utf8');

    const tools = [];
    const ctx = {
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      get: () => undefined,
      effect: (fn) => { const inner = typeof fn === 'function' ? fn() : undefined; return typeof inner === 'function' ? inner : () => {}; },
      inject: (_n, callback) => callback({
        webServer: { register: () => {} },
        effect: (fn) => { const inner = fn(); return typeof inner === 'function' ? inner : () => {}; },
        credentials: { resolve: async () => undefined },
        tools: { register: (definition) => { tools.push(definition); return () => {}; } },
        systemPrompt: { section: () => {} },
      }),
      on: () => {}, plugin: () => () => {}, reflect: { provide: () => {} },
    };
    apply(ctx);
    const tool = tools.find((entry) => entry.name === 'send_file_to_im');
    assert.ok(tool, 'send_file_to_im 应当已注册');

    // 配置里没有 botId / toUserId + 两个可用账号 → 必须在投递前拒绝
    await assert.rejects(
      tool.execute({ path: payload }, { agent: { session: { header: { cwd: home } } } }),
      /多个?可用的微信账号|个可用的微信账号/u,
      '多账号且没有默认收件人时应当拒绝投递',
    );

    // 配置里点名了发件账号 → 不再走这条拒绝（会继续往下走到"IM 模块缺失"之类的错误，但绝不是发错人）
    writeFileSync(configFile, JSON.stringify({ enabled: true, botId: 'wx_a' }), 'utf8');
    await assert.rejects(
      tool.execute({ path: payload }, { agent: { session: { header: { cwd: home } } } }),
      (error) => {
        assert.doesNotMatch(String(error?.message), /个可用的微信账号/u, '配置点名后不该再被 fail-closed 拦');
        return true;
      },
    );
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
}));

/* ------------------------------- HTTP 入口的真实请求（0.20.2 回归） */

// 通用：起一个真 http server，把插件注册的 handler 挂上去。
async function withRealServer(run) {
  const { createServer } = await import('node:http');
  const { apply } = await import('../lib/index.js');
  const handlers = {};
  const ctx = {
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    get: () => undefined,
    effect: (fn) => { const inner = typeof fn === 'function' ? fn() : undefined; return typeof inner === 'function' ? inner : () => {}; },
    inject: (_n, callback) => callback({
      webServer: { register: (spec) => { handlers[spec.path] = spec.handler; } },
      effect: (fn) => { const inner = fn(); return typeof inner === 'function' ? inner : () => {}; },
      credentials: { resolve: async () => undefined },
      tools: { register: () => () => {} },
      systemPrompt: { section: () => {} },
    }),
    on: () => {}, plugin: () => () => {}, reflect: { provide: () => {} },
  };
  apply(ctx);
  const server = createServer((request, response) => {
    const handler = handlers[request.url];
    if (handler === undefined) { response.writeHead(404).end('no route'); return; }
    Promise.resolve(handler(request, response)).catch((error) => {
      if (!response.writableEnded) response.writeHead(599).end(String(error));
    });
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (path, body, headers = {}) => fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
    // 关键：真挂死时让 fetch 自己超时，测试不会卡住
    signal: AbortSignal.timeout(4000),
  }).then(async (r) => ({ status: r.status, body: await r.text() }));
  const get = (path) => fetch(`${base}${path}`, { signal: AbortSignal.timeout(4000) })
    .then(async (r) => ({ status: r.status, body: await r.text() }));
  try {
    return await run({ post, get });
  } finally {
    await new Promise((done) => server.close(done));
  }
}

check('/send-file：合法请求必须有响应（真实 http server，P0 回归）', () => withDshHome(async () => {
  // 2026-11-11 实测的 P0：取消源挂在 request 的 'close' 上，而 Node 在**请求体读完**时就触发它
  // → 投递被自己 abort 成 client-gone → 不投递也不写响应，客户端只能等到超时。
  // 这条用真 server + 真 fetch：只要它挂死，AbortSignal.timeout 会让断言直接失败。
  const home = mkdtempSync(join(tmpdir(), 'hp-sendfile-'));
  const previousHome = process.env.DSH_HOME;
  try {
    process.env.DSH_HOME = home;
    mkdirSync(join(home, 'integrations', 'dsh-helper'), { recursive: true });
    writeFileSync(join(home, 'integrations', 'dsh-helper', 'config.json'),
      JSON.stringify({ enabled: true, botId: 'wx_a', toUserId: 'u-a' }), 'utf8');
    writeFileSync(join(home, 'payload.txt'), 'hello', 'utf8');

    const out = await withRealServer(async ({ post }) => {
      const missing = await post('/api/dsh-helper/send-file', { path: join(home, 'nope.txt') });
      const missingBody = JSON.parse(missing.body);
      const real = await post('/api/dsh-helper/send-file', { path: join(home, 'payload.txt') });
      return { missing, missingBody, real };
    });
    assert.equal(out.missing.status, 500, '文件不存在要回 500');
    assert.match(out.missingBody.error, /文件不存在/u);
    // 文件能读到 → 会走到"选后端"，而临时 HOME 里两个 IM 包都不在 → 500 且说明找不到；
    // 关键是**有响应**（挂死会抛 AbortError，走不到下面）。
    assert.equal(out.real.status, 500, `合法文件也要有响应（实际 ${out.real.status}）`);
    assert.match(JSON.parse(out.real.body).error, /找不到 dsh-im|找不到 @michengai/u);
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
}));

check('配置坏了能自救：GET 回默认值、坏文件留备份、随后 POST 可修复', () => withDshHome(async () => {
  const home = mkdtempSync(join(tmpdir(), 'hp-corrupt-'));
  const previousHome = process.env.DSH_HOME;
  try {
    process.env.DSH_HOME = home;
    const dir = join(home, 'integrations', 'dsh-helper');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'config.json');
    writeFileSync(file, '{ "enabled": true, "toUserId": "u1",  BROKEN', 'utf8');

    const first = await withRealServer(async ({ get, post }) => {
      const read = await get('/api/dsh-helper/config');
      const write = await post('/api/dsh-helper/config', { toUserId: 'u2' });
      return { read, write };
    });
    assert.equal(first.read.status, 200, '坏配置不能把设置页打成 400/500');
    assert.equal(JSON.parse(first.read.body).enabled, true, '读不到就按默认值继续（默认开）');
    assert.ok(
      readdirSync(dir).some((name) => name.includes('.corrupt-')),
      '坏文件要留一份备份（用户可能想抢救），而不是被下一次保存直接覆盖',
    );
    assert.equal(first.write.status, 200, '坏配置之后必须还能写回来（否则用户只能去磁盘上改）');
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).toUserId, 'u2');
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
}));

check('GET 路由不写盘 + 非法 JSON 归 400 + 非字符串口令 fail-closed', () => withDshHome(async () => {
  const home = mkdtempSync(join(tmpdir(), 'hp-get-'));
  const previousHome = process.env.DSH_HOME;
  try {
    process.env.DSH_HOME = home;
    const dir = join(home, 'integrations', 'dsh-helper');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'config.json');

    // GET 不该补默认值写盘
    const readOnly = await withRealServer(async ({ get }) => {
      const config = await get('/api/dsh-helper/config');
      const status = await get('/api/dsh-helper/restart/status');
      return { config, status };
    });
    assert.equal(readOnly.config.status, 200);
    assert.equal(readOnly.status.status, 200, '/restart/status 必须自己兜底，不能挂起');
    assert.equal(existsSync(file), false, 'GET 不该创建 config.json');

    // 非法 JSON → 400（不是 500）。这里要发**裸 body**，所以单独起一次真服务。
    const bad = await (async () => {
      const { createServer } = await import('node:http');
      const { apply } = await import('../lib/index.js');
      const handlers = {};
      const ctx = {
        logger: { info: () => {}, warn: () => {}, error: () => {} },
        get: () => undefined,
        effect: (fn) => { const inner = typeof fn === 'function' ? fn() : undefined; return typeof inner === 'function' ? inner : () => {}; },
        inject: (_n, callback) => callback({
          webServer: { register: (spec) => { handlers[spec.path] = spec.handler; } },
          effect: (fn) => { const inner = fn(); return typeof inner === 'function' ? inner : () => {}; },
          credentials: { resolve: async () => undefined },
          tools: { register: () => () => {} }, systemPrompt: { section: () => {} },
        }),
        on: () => {}, plugin: () => () => {}, reflect: { provide: () => {} },
      };
      apply(ctx);
      const server = createServer((request, response) => {
        Promise.resolve(handlers[request.url](request, response)).catch(() => {});
      });
      await new Promise((done) => server.listen(0, '127.0.0.1', done));
      const url = `http://127.0.0.1:${server.address().port}/api/dsh-helper/config`;
      const res = await fetch(url, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{not json',
        signal: AbortSignal.timeout(4000),
      });
      const body = await res.text();
      await new Promise((done) => server.close(done));
      return { status: res.status, body };
    })();
    assert.equal(bad.status, 400, `坏 JSON 应当 400，实际 ${bad.status}`);

    // 非字符串口令 → fail-closed（不能当成"没设口令"）
    writeFileSync(file, JSON.stringify({ enabled: true, toUserId: 'u1', sendToken: 123456 }), 'utf8');
    writeFileSync(join(home, 'x.txt'), 'hi', 'utf8');
    const tokenCase = await withRealServer(async ({ post, get }) => {
      const blocked = await post('/api/dsh-helper/send-file', { path: join(home, 'x.txt') });
      const config = await get('/api/dsh-helper/config');
      return { blocked, config };
    });
    assert.equal(tokenCase.blocked.status, 401, '配置里的口令坏成非字符串时必须拒绝，而不是放行');
    assert.equal(JSON.parse(tokenCase.config.body).sendTokenSet, true,
      '界面要知道"设过但坏了"，才给得出「清除口令」');
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
}));

check('HTTP /send-file 同样受多账号 fail-closed 保护', () => withDshHome(async () => {
  const home = mkdtempSync(join(tmpdir(), 'hp-http-failclosed-'));
  const previousHome = process.env.DSH_HOME;
  try {
    process.env.DSH_HOME = home;
    mkdirSync(join(home, 'integrations', 'dsh-helper'), { recursive: true });
    mkdirSync(join(home, 'integrations', 'dsh-weixin'), { recursive: true });
    writeFileSync(join(home, 'integrations', 'dsh-weixin', 'config.json'), JSON.stringify({
      accounts: [{ botId: 'wx_a', ownerUserId: 'u-a' }, { botId: 'wx_b', ownerUserId: 'u-b' }],
    }), 'utf8');
    writeFileSync(join(home, 'integrations', 'dsh-helper', 'config.json'), JSON.stringify({ enabled: true }), 'utf8');
    writeFileSync(join(home, 'x.txt'), 'hi', 'utf8');

    const out = await withRealServer(async ({ post }) => post('/api/dsh-helper/send-file', { path: join(home, 'x.txt') }));
    assert.equal(out.status, 500);
    assert.match(JSON.parse(out.body).error, /个可用的微信账号/u,
      '脚本入口也必须拒绝歧义投递——它是最容易被脚本化、也最容易发错人的那条路');
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
}));

check('原子写失败路径也不留临时文件；路径展开与 profile 识别兼容 Windows 写法', async () => {
  const { writeFileAtomic } = await import('../src/host/atomic-write.js');
  const { expandTilde, currentProfileDir } = await import('../lib/index.js').then(async (m) => ({
    expandTilde: m.expandTilde,
    currentProfileDir: (await import('../src/host/im-connect.js')).currentProfileDir,
  }));
  const dir = mkdtempSync(join(tmpdir(), 'hp-atomic-fail-'));
  try {
    // 目标被占成目录 → rename 必失败
    const target = join(dir, 'config.json');
    mkdirSync(target, { recursive: true });
    await assert.rejects(writeFileAtomic(target, 'x'));
    assert.deepEqual(
      readdirSync(dir).filter((name) => name.includes('.tmp-')),
      [],
      '失败路径同样不许留临时文件',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  // Windows 写法：`~\Downloads` 也要展开（否则白名单永远匹配不上）
  assert.equal(expandTilde('~/x'), join(homedir(), 'x'));
  assert.equal(expandTilde('~\\x'), join(homedir(), 'x'));
  // profile 识别在 Windows 分隔符下也要命中（原先用 '/' 拼前缀，永远 startsWith 不到）
  assert.equal(
    currentProfileDir(['node', 'x', 'C:\\Users\\bk\\.dsh\\profiles\\desktop'], 'C:\\Users\\bk\\.dsh'),
    'C:\\Users\\bk\\.dsh\\profiles\\desktop',
  );
  assert.equal(currentProfileDir(['node', '/tmp/other']), undefined);
});

/* ------------------------------------------ 配置落盘（原子写 + 串行队列） */

check('原子写：同一毫秒内的并发写不会写出坏 JSON，也不留临时文件', async () => {
  // 2026-11-11 实测复现的真 bug：临时文件名只用 `pid-时间戳(毫秒)`，同一毫秒的两次写入
  // 撞同一个名字 → 两个 open(temp,'w') 互相覆盖（坏 JSON），先 rename 的那次把文件搬走后
  // 另一次 rename 直接 ENOENT。修法是加随机后缀。
  const { writeFileAtomic } = await import('../src/host/atomic-write.js');
  const dir = mkdtempSync(join(tmpdir(), 'hp-atomic-'));
  const file = join(dir, 'config.json');
  let corrupted = 0;
  try {
    for (let round = 0; round < 100; round += 1) {
      await Promise.all([
        writeFileAtomic(file, JSON.stringify({ a: 'x'.repeat(200), round })),
        writeFileAtomic(file, JSON.stringify({ b: 'y'.repeat(200), round })),
      ]);
      try {
        JSON.parse(readFileSync(file, 'utf8'));
      } catch {
        corrupted += 1;
      }
    }
    assert.equal(corrupted, 0, '并发写不能产生坏 JSON（临时文件重名会互相覆盖）');
    assert.deepEqual(
      readdirSync(dir).filter((name) => name.includes('.tmp-')),
      [],
      '不许残留临时文件',
    );
    // 配置文件里有可选的投递口令：权限必须是 0600，不能让同机其他用户读到
    assert.equal(statSync(file).mode & 0o777, 0o600, '落盘权限应为 0600');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

check('配置写入串行化：10 个并发 patch 一个都不能丢', () => withDshHome(async () => {
  // 回归点：`saveConfig` 是「读 → 合并 → 写」，并发两次会互相覆盖（后写赢），
  // 表现是用户快速连点两个开关时其中一个改动凭空消失。
  const { apply } = await import('../lib/index.js');
  const home = mkdtempSync(join(tmpdir(), 'hp-config-race-'));
  const previousHome = process.env.DSH_HOME;
  try {
    process.env.DSH_HOME = home;
    mkdirSync(join(home, 'integrations', 'dsh-helper'), { recursive: true });
    const file = join(home, 'integrations', 'dsh-helper', 'config.json');
    writeFileSync(file, JSON.stringify({}), 'utf8');
    const handlers = {};
    const ctx = {
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      get: () => undefined,
      effect: (fn) => { const inner = typeof fn === 'function' ? fn() : undefined; return typeof inner === 'function' ? inner : () => {}; },
      inject: (_n, callback) => callback({
        webServer: { register: (spec) => { handlers[spec.path] = spec.handler; } },
        effect: (fn) => { const inner = fn(); return typeof inner === 'function' ? inner : () => {}; },
        credentials: {}, tools: { register: () => () => {} }, systemPrompt: { section: () => {} },
      }),
      on: () => {}, plugin: () => () => {}, reflect: { provide: () => {} },
    };
    apply(ctx);
    const request = (body) => ({
      method: 'POST',
      socket: { remoteAddress: '127.0.0.1' },
      headers: { host: '127.0.0.1:3080', 'content-type': 'application/json' },
      once() { return this; }, off() { return this; },
      [Symbol.asyncIterator]: function* () { yield Buffer.from(JSON.stringify(body)); },
    });
    const response = () => ({
      destroyed: false, writableEnded: false, status: 0, body: '',
      writeHead(status) { this.status = status; }, end(body) { this.body = body; this.writableEnded = true; },
    });
    const patches = [
      { enabled: false }, { imageAsPicture: false }, { restartEnabled: false },
      { botId: 'b1' }, { toUserId: 'u1' }, { sendToken: 't1' },
      { sendAllowRoots: ['/tmp'] }, { botId: 'b2' }, { toUserId: 'u2' }, { enabled: true },
    ];
    await Promise.all(patches.map((body) => handlers['/api/dsh-helper/config'](request(body), response())));
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    for (const key of ['enabled', 'imageAsPicture', 'restartEnabled', 'botId', 'toUserId', 'sendToken', 'sendAllowRoots']) {
      assert.ok(key in saved, `并发写入丢了字段 ${key}（读-改-写没有被串行化）`);
    }
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
}));

/* ------------------------------------------ 投递目标清单与账号解析（0.20.0） */

check('listImTargets：跨后端列账号、标出当前默认、某个后端缺失只进 notices', () => withDshHome(async () => {
  // 需求（2026-11-11 用户提）：一台机器可能接了多个微信账号，说"发我微信"时不能靠猜。
  // 这个工具是模型唯一的取数入口，所以它的形状（label / isConfigured / notices）要钉死。
  const { listImTargets } = await import('../lib/index.js');
  const home = mkdtempSync(join(tmpdir(), 'hp-targets-'));
  const previousHome = process.env.DSH_HOME;
  try {
    process.env.DSH_HOME = home;
    mkdirSync(join(home, 'integrations', 'dsh-weixin'), { recursive: true });
    writeFileSync(join(home, 'integrations', 'dsh-weixin', 'config.json'), JSON.stringify({
      version: 1,
      accounts: [
        { botId: 'wx_me', ownerUserId: 'user-me' },
        { botId: 'wx_other', ownerUserId: 'user-other' },
      ],
    }), 'utf8');

    const result = listImTargets({ botId: 'wx_other', toUserId: 'user-other' });
    assert.equal(result.targets.length, 2, '两个 dsh-im 账号都要列出来');
    const other = result.targets.find((target) => target.botId === 'wx_other');
    const me = result.targets.find((target) => target.botId === 'wx_me');
    assert.equal(other.isConfigured, true, '配置里的账号要标成当前默认');
    assert.equal(me.isConfigured, false);
    assert.match(other.label, /dsh-im/u, 'label 要带后端名（两套 id 体系不同，光看 botId 分不清）');
    assert.match(other.label, /主人 user-other/u, 'label 要带主人，用户才认得出是哪个微信');
    assert.equal(other.enabled, true);
    // im-connect 包不在临时 HOME 下 → 不该整体失败，而是进 notices
    assert.ok(
      result.notices.some((notice) => notice.backend === 'im-connect'),
      `缺后端要降级成 notice，而不是抛错：${JSON.stringify(result.notices)}`,
    );
    // 完全没有账号时也不抛
    const empty = listImTargets({});
    assert.ok(Array.isArray(empty.targets));
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
}));

check('listImConnectTargets：只列微信渠道、保留停用标记、读不到返回空数组', async () => {
  const { listImConnectTargets } = await import('../src/host/im-connect.js');
  const dir = mkdtempSync(join(tmpdir(), 'hp-ic-targets-'));
  try {
    writeFileSync(join(dir, 'channels.json'), JSON.stringify({
      version: 2,
      channels: {
        weixin_a: { platform: 'weixin', name: '微信账号 1', enabled: true, config: { allowedUserId: 'u1' } },
        weixin_b: { platform: 'weixin', name: '微信账号 2', enabled: false, config: { allowedUserId: 'u2' } },
        qq_c: { platform: 'qq', name: 'QQ', enabled: true },
      },
    }), 'utf8');
    const targets = listImConnectTargets(dir);
    assert.equal(targets.length, 2, '非微信渠道不该出现在清单里');
    assert.equal(targets[0].botId, 'weixin_a', 'im-connect 的 botId 就是 channels 的 key');
    assert.equal(targets[0].ownerUserId, 'u1');
    assert.equal(targets[1].enabled, false, '停用账号要保留标记（清单负责说清楚，不负责过滤掉）');
    assert.deepEqual(listImConnectTargets(join(dir, 'nope')), [], '读不到就返回空数组，不抛');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

check('账号解析：显式点名的账号落空要报错，配置默认值落空才回退第一个', async () => {
  // 这条是"发错人"的正面防线：explicit 与 config 必须区别对待。
  // 两套 id 体系（im-connect 用 channels key / dsh-im 用 wx_…）让"配置里的默认值属于另一个后端"
  // 成为常态，那种情况静默拿它发就是发错人；而点名不存在的账号必须报错，不许猜。
  const { resolveImConnectAccount } = await import('../src/host/im-connect.js');
  const { pickDshImAccount } = await import('../lib/index.js');

  const store = {
    channels: {
      first: { platform: 'weixin', enabled: true, config: { allowedUserId: 'u1' } },
      second: { platform: 'weixin', enabled: true, config: { allowedUserId: 'u2' } },
    },
  };
  assert.equal(resolveImConnectAccount(store, { explicitBotId: 'second' }, {}).id, 'second', '显式命中');
  assert.throws(
    () => resolveImConnectAccount(store, { explicitBotId: 'wx_not_here' }, {}),
    /没有名为 wx_not_here/u,
    '显式点名的账号不存在 → 必须报错，绝不静默换人',
  );
  const icWarns = [];
  assert.equal(
    resolveImConnectAccount(store, { botId: 'wx_another_backend' }, { warn: (line) => icWarns.push(line) }).id,
    'first',
    '配置默认值不属于本后端 → 回退第一个可用账号',
  );
  assert.ok(icWarns.some((line) => line.includes('已改用第一个可用账号')), `回退要出声：${icWarns.join(' | ')}`);
  assert.equal(
    resolveImConnectAccount(store, { explicitBotId: 'second', botId: 'first' }, {}).id,
    'second',
    '显式参数压过配置默认值',
  );

  const accounts = [{ botId: 'wx_me' }, { botId: 'wx_other' }];
  assert.equal(pickDshImAccount(accounts, { explicitBotId: 'wx_other' }).botId, 'wx_other');
  assert.throws(() => pickDshImAccount(accounts, { explicitBotId: 'wx_nope' }), /没有名为 wx_nope/u);
  assert.equal(
    pickDshImAccount(accounts, { inferredBotId: 'wx_me', configuredBotId: 'wx_other' }).botId,
    'wx_me',
    '会话推断压过配置默认值（"谁在跟我说话"比"设置里填过谁"更精确）',
  );
  const imWarns = [];
  assert.equal(
    pickDshImAccount(accounts, { configuredBotId: 'weixin_a50' }, { warn: (line) => imWarns.push(line) }).botId,
    'wx_me',
    '配置默认值属于另一个后端 → 回退第一个账号',
  );
  assert.ok(imWarns.length === 1, `回退要记一条 warn：${imWarns.join(' | ')}`);
  assert.equal(pickDshImAccount([], {}), undefined, '一个账号都没有时返回 undefined，由调用方报"没有可用账号"');
});

/* ------------------------------------------ 已投递文件的会话卡片（0.19.0） */

check('已投递文件卡片：事件形状符合客户端契约，缺条件时安静跳过', async () => {
  // 需求（2026-11-11 用户提）：投递完成后对话里要能看到"发了哪些文件、发到哪儿、成没成"。
  // 实现是复用官方交付物事件（与 present 工具同一个），客户端 ui-deliverables 会渲染成文件卡片。
  // 这里钉两件事：① 事件形状必须满足客户端 isPresentedData（turn 是 >=1 的整数、callId 非空、
  // files 是数组）；② 任何前提缺失都必须安静跳过 —— 卡片是锦上添花，不能把成功投递翻成失败。
  const { appendDeliveryCard } = await import('../lib/index.js');
  const appended = [];
  const session = { append: (type, data) => { appended.push({ type, data }); return { seq: 1 }; } };
  const agents = { turnBoundaryOf: () => ({ lastTurn: 7, openTurnStartSeq: 3 }) };
  const result = {
    sent: true, fileName: 'a.pdf', bytes: 12, toUserId: 'wxid_me', botId: 'b1',
    hadContextToken: true, via: 'file', absolutePath: '/tmp/a.pdf',
  };

  assert.equal(appendDeliveryCard({ session, callId: 'call-1', agents, result, recipient: 'wxid_me' }), true);
  assert.equal(appended.length, 1, '正常情形只登记一次');
  const { type, data } = appended[0];
  assert.equal(type, 'deliverables/presented', '必须与 present 用同一个官方事件（客户端只认它）');
  assert.ok(Number.isSafeInteger(data.turn) && data.turn >= 1, 'turn 必须是 >=1 的整数（否则客户端不渲染）');
  assert.equal(data.callId, 'call-1');
  assert.equal(data.files.length, 1);
  assert.equal(data.files[0].path, '/tmp/a.pdf');
  assert.match(data.files[0].description, /已投递到微信/u);
  assert.match(data.files[0].description, /wxid_me/u, '卡片说明里要有收件人');
  assert.match(data.files[0].description, /平台已受理/u, '卡片说明里要有投递结果');

  // turn 优先用调用方在 execute 时取好的那个（与官方 present 同步取数）
  appended.length = 0;
  assert.equal(
    appendDeliveryCard({
      session, callId: 'call-2', agents: { turnBoundaryOf: () => ({ lastTurn: 99 }) }, result, turn: 5,
    }),
    true,
  );
  assert.equal(appended[0].data.turn, 5, '显式 turn 要压过现场从 agents 取到的 99');

  const skipCases = [
    ['没有会话', { session: undefined }],
    ['会话没有 append', { session: {} }],
    ['没有 callId', { session, callId: '' }],
    ['投递没成功', { session, result: { ...result, sent: false } }],
    ['缺绝对路径', { session, result: { ...result, absolutePath: '' } }],
    ['拿不到 agents', { session, agents: undefined }],
    ['turn 为 0', { session, agents: { turnBoundaryOf: () => ({ lastTurn: 0 }) } }],
    ['turnBoundaryOf 抛错', { session, agents: { turnBoundaryOf: () => { throw new Error('boom'); } } }],
    ['append 抛错', { session: { append: () => { throw new Error('disk full'); } } }],
  ];
  const logs = [];
  const originalWarn = console.warn;
  console.warn = (...args) => { logs.push(args.map(String).join(' ')); };
  try {
    for (const [label, patch] of skipCases) {
      const call = { session, callId: 'call-1', agents, result, recipient: 'wxid_me', ...patch };
      assert.equal(appendDeliveryCard(call), false, `${label}：应当安静跳过`);
    }
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(appended.length, 1, '跳过的情形不该往会话里写事件');
  assert.ok(!logs.some((line) => line.includes('TypeError')), `日志不该是 TypeError 原文：${logs.join(' | ')}`);
});

check('工具回执文案带收件人与投递方式（用户要能一眼看出发到哪儿了）', () => withDshHome(async () => {
  const { apply } = await import('../lib/index.js');
  const home = mkdtempSync(join(tmpdir(), 'hp-receipt-'));
  const previousHome = process.env.DSH_HOME;
  try {
    process.env.DSH_HOME = home;
    const tools = [];
    const listeners = {};
    const ctx = {
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      get: () => undefined,
      effect: (fn) => { const inner = typeof fn === 'function' ? fn() : undefined; return typeof inner === 'function' ? inner : () => {}; },
      inject: (_n, cb) => cb({
        webServer: { register: () => {} },
        effect: (fn) => { const inner = fn(); return typeof inner === 'function' ? inner : () => {}; },
        credentials: {},
        tools: { register: (definition) => { tools.push(definition); return () => {}; } },
        systemPrompt: { section: () => {} },
      }),
      on: (event, handler) => { listeners[event] = handler; },
      plugin: () => () => {}, reflect: { provide: () => {} },
    };
    apply(ctx);
    const tool = tools.find((entry) => entry.name === 'send_file_to_im');
    assert.ok(tool, 'send_file_to_im 应当已注册');
    // 交付卡片登记必须挂在 tools/result 上（与官方 present 同一时序：失败/中断不留"已投递"卡片）
    assert.equal(typeof listeners['tools/result'], 'function', '要订阅 tools/result 事件');
    for (const args of [[undefined, { isError: false }], [{}, { isError: false }], [{}, { isError: true }]]) {
      listeners['tools/result'](...args);   // 未知 exec / 失败结果都必须安静跳过
    }
    // 回执 schema 必须包含 absolutePath（卡片要用它定位文件，多一个未声明键会被宿主拒整个调用）
    assert.ok(tool.output.schema.properties.absolutePath, '回执 schema 要有 absolutePath');
    // 只读工具不许有写盘副作用：一次查询不该把 config.json 造出来（0.20.1 第 4 条修复的回归）
    const listTool = tools.find((entry) => entry.name === 'list_im_targets');
    assert.ok(listTool, 'list_im_targets 应当已注册');
    await listTool.execute({});
    assert.equal(
      existsSync(join(home, 'integrations', 'dsh-helper', 'config.json')),
      false,
      'list_im_targets 是只读的：调用后不该创建 config.json',
    );

    const text = tool.output.render({}, {
      sent: true, fileName: '报告.pdf', bytes: 2048, toUserId: 'wxid_me', botId: 'b1',
      hadContextToken: true, via: 'file', absolutePath: '/tmp/报告.pdf',
    })[0].text;
    assert.match(text, /报告\.pdf/u);
    assert.match(text, /wxid_me/u, '回执要说出发到哪个微信');
    assert.match(text, /平台已受理/u);
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
}));

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
