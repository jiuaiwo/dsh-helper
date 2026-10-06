/**
 * 复刻自 dshmarket/src/restart.ts（运行核心 + 三道安全闸 + helper）。
 *
 * 与 dshmarket 的差异：
 *   - helper 内日志前缀 [dsh-market] → [dsh-helper]
 *   - 日志文件名模板 dsh-market-restart-* → dsh-helper-restart-*
 *   - scheduleRestart 不接受 recovery 参数（不写 .recovery.json）
 *   - restartHelperSource 不带 recovery 移交分支
 *   - 删除 recoveryScriptPath（依赖 lib/recovery.js 产物，本插件无产物）
 *   - 新增 detectedDesktopHost：dshmarket 靠配置里的 desktopHost 标记达成同一件事，
 *     本插件没有那份配置，改成从宿主环境自己认
 *
 * 安全闸逻辑一行不漏照搬：
 *   - supervisor: INVOCATION_ID||JOURNAL_STREAM 且 (ppid===1 || comm==='systemd')
 *   - debugger:   inspector.url() || execArgv/NODE_OPTIONS 按 token 前缀匹配
 *   - desktop:    DSH_CLIENT_VERSION 非空（Electron 主进程只发给桌面端宿主）
 *   - 请求来源:   trustedRestartRequest（独立文件）
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import inspector from 'node:inspector';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { nodeExecutable, dshArgv } from './dsh-cli.js';

/** 用于测试覆盖的内部 hook。生产代码请直接用 detectedDebugger()。 */
let debuggerOverride;

/** @param {'inspector' | null | undefined} value */
export function setDetectedDebuggerOverride(value) {
  debuggerOverride = value;
}

/** 检查 argv token 是否带 --inspect-family 标记。 */
const INSPECT_ARG_PREFIXES = ['--inspect', '--inspect-brk', '--inspect-port', '--inspect-wait'];

function tokenHasInspectFlag(token) {
  for (const prefix of INSPECT_ARG_PREFIXES) {
    if (token === prefix || token.startsWith(`${prefix}=`)) return true;
  }
  if (token === '--debug-brk' || token.startsWith('--debug-brk=')) return true;
  if (token === '--debug' || token.startsWith('--debug=')) return true;
  return false;
}

function argvHasInspectFlag(tokens) {
  for (const token of tokens) {
    if (tokenHasInspectFlag(token)) return true;
  }
  return false;
}

/**
 * 返回 `pid` 的 /proc comm，读取失败时返回 null。
 * Linux-only（systemd 也只在这上面存在）。
 * @param {number} pid
 * @returns {string | null}
 */
function readParentComm(pid) {
  try {
    return readFileSync(`/proc/${String(pid)}/comm`, 'utf8').trim();
  } catch {
    return null;
  }
}

/**
 * 进程监督器检测。需要两个信号同时成立：
 *   - INVOCATION_ID 或 JOURNAL_STREAM 非空（systemd 标志）
 *   - 父进程是 PID 1 或 comm 为 'systemd'（避免普通终端 / CI runner 误报）
 *
 * @returns {'systemd' | null}
 */
export function detectedSupervisor(
  env = process.env,
  ppid = process.ppid,
  parentComm = readParentComm,
) {
  const set = (name) => (env[name] ?? '') !== '';
  if (!set('INVOCATION_ID') && !set('JOURNAL_STREAM')) return null;
  if (ppid === 1 || parentComm(ppid) === 'systemd') return 'systemd';
  return null;
}

/**
 * 桌面端宿主检测（DSH Desktop）。
 *
 * 判据取 `DSH_CLIENT_VERSION`：Electron 主进程在 spawn 宿主进程时注入它
 * （app.asar/lib/main.js 里构造 DesktopHostProcess 的那处 env），`dsh web`、
 * 内置 CLI、headless 都不会有。比 `ELECTRON_RUN_AS_NODE` 精确 —— 后者是所有
 * "把 Electron 当 Node 用"的通用标记，别的 Electron 应用里跑 dsh 也会命中。
 *
 * 为什么桌面端要单独判一档（2026-10-06 实测定案）：桌面窗口跑在 `dsh-app://app`，
 * 请求由 Electron 主进程的 forwardWebRequest 转发给宿主，而它**转发前会删掉
 * origin / host / cookie / sec-fetch-site**。于是重启闸（trustedRestartRequest
 * 要求 Origin 存在且与 Host 同源）在桌面端恒为 false，用户点按钮只会拿到
 * `403 untrusted`；而 status 走的是松一档的 trustedLocalRequest（放行无 Origin），
 * 按钮反倒显示成"可点"——两者不一致，就成了"看起来能用、一点就报错"。
 * 上游 dshmarket 在 routes.ts 里把桌面端的 restart 直接标成
 * `supported: false` / `managedBy: 'desktop-host'`，本插件补上同一档。
 *
 * 桌面端也确实不该自己重启：宿主一退出，Electron 主进程立刻
 * `fail("dsh desktop host stopped")` 进 fatal 恢复；插件另起的替代进程还拿不到
 * 主进程持有的 hostCookie（窗口会 401）。正确做法是让用户从 App 侧退出后重开。
 *
 * @returns {'desktop' | null}
 */
export function detectedDesktopHost(env = process.env) {
  const version = env.DSH_CLIENT_VERSION;
  if (typeof version !== 'string' || version.trim() === '') return null;
  return 'desktop';
}

/**
 * 检测器附着检测。按以下优先级：
 *   1. inspector.url() 已设置（覆盖 --inspect 启动 / inspector.open() / SIGUSR1 attach）
 *   2. execArgv 含 inspect-family token
 *   3. NODE_OPTIONS 含 inspect-family token
 * token 匹配按前缀，不做 /inspect/ 子串（避免 .../inspect-tool.js 误判）。
 *
 * @returns {'inspector' | null}
 */
export function detectedDebugger(
  inspectorUrl = inspector.url(),
  execArgv = process.execArgv,
  nodeOptions = process.env.NODE_OPTIONS ?? '',
) {
  if (debuggerOverride !== undefined) return debuggerOverride;
  if (inspectorUrl !== undefined && inspectorUrl !== '') return 'inspector';
  if (argvHasInspectFlag(execArgv)) return 'inspector';
  const trimmed = nodeOptions.trim();
  if (trimmed !== '' && argvHasInspectFlag(trimmed.split(/\s+/u))) return 'inspector';
  return null;
}

/**
 * 从 Host 头解析端口。默认端口（无 :port）返回 null。
 * 不解析启动 argv——配置/环境变量绑定的端口解析不了；Host 头是浏览器实际
 * 命中的端口，是替代进程必须接管的端口。
 *
 * @param {{ headers: Record<string, string | string[] | undefined> }} request
 * @returns {number | null}
 */
export function servingPort(request) {
  const host = request.headers.host;
  if (typeof host !== 'string') return null;
  const match = /:(\d{1,5})$/u.exec(host);
  if (match === null) return null;
  const port = Number(match[1]);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : null;
}

/** 重启时拉起 DSH 的精确命令，复用 dshArgv + process.argv[2..]。 */
export function restartLaunch() {
  const launch = dshArgv();
  return {
    ...launch,
    args: [...launch.args, ...process.argv.slice(2)],
    cwd: launch.cwd ?? process.cwd(),
  };
}

/**
 * 平台适配的 spawn 形式。
 *   POSIX:  用 launch.file 直接 detached spawn
 *   Win32:  包一层 powershell -WindowStyle Hidden；launch.viaShell 且
 *           launch.file 不是 .cmd/.bat 时把文件名后缀改为 .cmd
 *           （否则 powershell 优先选 dsh.ps1，被 Restricted 策略拒，#397）
 *
 * @returns {{ file: string; args: string[], viaShell: boolean, detached: boolean }}
 */
export function respawnInvocation(launch, platform = process.platform) {
  if (platform !== 'win32') {
    return { file: launch.file, args: launch.args, viaShell: launch.viaShell, detached: true };
  }
  const quote = (part) => `'${part.replace(/'/g, "''")}'`;
  const file = launch.viaShell && !/\.(?:cmd|bat)$/iu.test(launch.file)
    ? `${launch.file}.cmd`
    : launch.file;
  return {
    file: 'powershell.exe',
    args: ['-NoProfile', '-WindowStyle', 'Hidden', '-Command',
      [`& ${quote(file)}`, ...launch.args.map(quote)].join(' ')],
    viaShell: false,
    detached: false,
  };
}

/**
 * detached helper 脚本源码（由 helper 进程用 node -e 执行）。
 * 解决 #177：旧实现固定 sleep 1500ms，端口还没释放就被秒死，错误还被 catch {} 吞了。
 * 现在：探测端口真正空闲、等替代进程连续 8s 端口稳定、写诊断日志。
 *
 * @param {{ file: string, args: string[], viaShell: boolean, detached: boolean }} spawned
 * @param {{ cwd: string }} launch
 * @param {{ out: string, err: string }} logs
 * @param {number | null} port
 * @returns {string}
 */
export function restartHelperSource(spawned, launch, logs, port) {
  return [
    "const { spawn } = require('node:child_process')",
    "const fs = require('node:fs')",
    "const net = require('node:net')",
    `const file = ${JSON.stringify(spawned.file)}`,
    `const args = ${JSON.stringify(spawned.args)}`,
    `const cwd = ${JSON.stringify(launch.cwd)}`,
    `const viaShell = ${JSON.stringify(spawned.viaShell)}`,
    `const detached = ${JSON.stringify(spawned.detached)}`,
    `const logOut = ${JSON.stringify(logs.out)}`,
    `const logErr = ${JSON.stringify(logs.err)}`,
    `const port = ${JSON.stringify(port)}`,
    'const sleep = (ms) => new Promise(r => setTimeout(r, ms))',
    'const note = (line) => { try { fs.appendFileSync(logErr, `[dsh-helper] ${line}\\n`) } catch {} }',
    // helper 自己如何结束——失败时这是唯一的现场记录
    'process.on("exit", (code) => note("helper exiting (code " + code + ")"))',
    'process.on("uncaughtException", (error) => note("helper crashed: " + (error && error.stack ? error.stack : error)))',
    'process.on("unhandledRejection", (error) => note("helper rejection: " + (error && error.stack ? error.stack : error)))',
    // 用 net.connect 探测端口是否被监听（不绑——绑会自己占住端口）
    'const listening = () => new Promise((resolve) => {',
    '  const probe = net.connect({ host: "127.0.0.1", port })',
    '  const done = (value) => { probe.destroy(); resolve(value) }',
    '  probe.on("connect", () => done(true))',
    '  probe.on("error", () => done(false))',
    '  setTimeout(() => done(false), 500)',
    '})',
    'let exited = null',
    'const main = async () => {',
    '  note(`helper up (pid ${process.pid}) for port ${port}`)',
    '  if (port) {',
    '    const until = Date.now() + 30000',
    '    while (Date.now() < until && await listening()) await sleep(250)',
    '    if (await listening()) note(`port ${port} was still in use after 30s; starting anyway`)',
    // TIME_WAIT 收敛
    '    await sleep(300)',
    '    note(`port ${port} is free; starting the replacement`)',
    '  } else {',
    '    await sleep(1500)',
    '  }',
    '  let child',
    '  try {',
    '    const out = fs.openSync(logOut, "a")',
    '    const err = fs.openSync(logErr, "a")',
    // windowsHide：helper 自身 detached 没有 console，会传给替代进程一个新可见 console
    '    child = spawn(file, args, { cwd, detached, stdio: ["ignore", out, err], env: process.env, shell: viaShell, windowsHide: true })',
    // spawn 异步报告 ENOENT 等错误，必须挂 error
    '    child.on("error", (error) => note(`could not start the replacement: ${error && error.message ? error.message : error}`))',
    '    child.on("exit", (code) => { exited = code === null ? -1 : code })',
    '    child.unref()',
    '    note(`replacement started (pid ${child.pid})`)',
    '  } catch (error) {',
    '    note(`could not start the replacement: ${error && error.message ? error.message : error}`)',
    '    return',
    '  }',
    // 没端口也至少活 3s，避免带替代进程一起死（Windows 现象）
    '  if (!port) { await sleep(3000); return }',
    // 单次答端口不算成功——DSH 启动失败时端口已经 bind 过一次才退出。连续稳定 8s 才算。
    '  const SETTLE_MS = 8000',
    '  const upBy = Date.now() + 20000 + SETTLE_MS',
    '  let steadySince = null',
    '  while (Date.now() < upBy) {',
    '    if (await listening()) {',
    '      if (steadySince === null) steadySince = Date.now()',
    '      else if (Date.now() - steadySince >= SETTLE_MS) return',
    '    } else {',
    '      steadySince = null',
    '      if (exited !== null) break',
    '    }',
    '    await sleep(500)',
    '  }',
    '  note(`the replacement never came up on port ${port}${exited === null ? "" : ` (it exited with code ${exited})`} — see the output log beside this one`)',
    '}',
    'main()',
  ].join('\n');
}

/**
 * 调度一次重启。流程：
 *   1. 还原当初启动宿主的那条命令
 *   2. 平台适配（Windows 包 powershell Hidden）
 *   3. spawn 一个 detached helper（node -e restartHelperSource(...)）
 *   4. 本进程 500ms 后自杀
 *
 * helper 会等端口 free、起替代进程、监测稳定后退出；本进程 SIGTERM 让
 * 替代进程接管所有端口。**不**写 recovery.json——失败时浏览器刷新即恢复。
 *
 * @param {number | null} port
 * @returns {{ pid: number, helperPid: number | undefined, logOut: string, logErr: string }}
 */
export function scheduleRestart(port = null) {
  const launch = restartLaunch();
  const spawned = respawnInvocation(launch);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const logOut = join(tmpdir(), `dsh-helper-restart-${stamp}.out.log`);
  const logErr = join(tmpdir(), `dsh-helper-restart-${stamp}.err.log`);
  const helper = spawn(
    nodeExecutable(),
    ['-e', restartHelperSource(spawned, launch, { out: logOut, err: logErr }, port)],
    { detached: true, stdio: 'ignore', env: process.env },
  );
  helper.unref();
  setTimeout(() => process.kill(process.pid, 'SIGTERM'), 500);
  return { pid: process.pid, helperPid: helper.pid, logOut, logErr };
}