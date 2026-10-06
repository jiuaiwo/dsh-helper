# dsh-helper-patch 重启按钮 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 dsh-helper-patch 增加一键重启按钮，复刻 dsh-market 的 `scheduleRestart()` 运行机制，渲染在「设置 → 通用设置」头部「打开配置文件」按钮右侧。

**Architecture:**
- host 侧：新增三个 ESM 模块（`src/host/dsh-cli.js`、`src/host/http-trust.js`、`src/host/restart.js`）封装运行机制；在 `lib/index.js` 多注册两条同源 HTTP 路由（`GET /restart/status` + `POST /restart`），复用现有 `webServer.register({ kind: 'exact' })` 模式。
- client 侧：在 `src/client/index.jsx` 多注入一个 `settings.action` slot（`id: "restart-host"`、`order: 10`），与现有 `settings.section` 注入互不影响；用 esbuild 重建 `lib/client.js`。
- 不引入 TypeScript、不引入新依赖、不复刻 `recovery.ts`。

**Tech Stack:** Node.js ≥22.19，ESM (`"type": "module"`)，`@xmanrui/dsh-im`（已有，可选），`react ^18.2.0`（已有），esbuild ^0.25.0（已有，dev only），`@deepseek-ai/dsh-client-ui-slots`、`@deepseek-ai/dsh-client-ui-settings`（客户端注入）

**Spec:** [`docs/superpowers/specs/2026-09-24-dsh-helper-patch-restart-design.md`](/Users/biaoge/web/t-team/dsh-helper-patch/docs/superpowers/specs/2026-09-24-dsh-helper-patch-restart-design.md)

## Global Constraints

- **Node engine:** `^22.19.0 || >=24`（与现有 package.json 一致）。
- **ESM 模块系统:** `"type": "module"`，所有新增 `.js` 文件必须用 `import/export`，**不用** `require/module.exports`。
- **安全闸顺序（POST /restart 必须严格按此顺序）：**
  1. `restartEnabled !== false`（来自 `$DSH_HOME/integrations/dsh-helper-patch/config.json`）→ 否则 `403 { error: 'disabled-in-config' }`
  2. `trustedRestartRequest(request)` → 否则 `403 { error: 'untrusted' }`
  3. `detectedDebugger() === null` → 否则 `403 { error: 'debugger' }`
  4. `detectedSupervisor() === null` → 否则 `403 { error: 'supervisor' }`
- **日志前缀:** 所有 helper 内日志统一为 `[dsh-helper-patch]`（**不是** `[dsh-market]`）。
- **日志文件名模板:** `/tmp/dsh-helper-patch-restart-<ISO 时间戳>.{out,err}.log`，时间戳格式 `2026-09-24T00-26-43`（冒号与点替换为 `-`，只保留前 19 字符）。
- **不在源码中暴露密码/凭据/Token**——日志路径前缀默认 `tmpdir()`，不应回显 `process.env.NODE_OPTIONS` / `INVOCATION_ID` 等敏感环境。
- **slot 命名规范:** client 注入必须用 `ctx.slots.inject("settings.action", () => ctx.slots.register({ name, id, order }, Component))` 形状，`id` 唯一。
- **完整回滚路径:** 删除 `src/host/` 目录 + 还原 `lib/index.js`、`src/client/index.jsx`、`package.json` + 重跑 `node tools/build-client.mjs` 即可回到 v0.3.0。

---

## File Map

**新增：**

| 路径 | 职责 | 大小估计 |
|---|---|---|
| `src/host/dsh-cli.js` | `nodeExecutable()` + `dshArgv()`（dsh-cli.ts:50/367 等价实现） | ~50 行 |
| `src/host/http-trust.js` | `loopbackAuthority()` + `trustedRestartRequest()`（http.ts:66 + restart.ts:198） | ~60 行 |
| `src/host/restart.js` | `scheduleRestart()` + `restartHelperSource()` + `respawnInvocation()` + `restartLaunch()` + 三个检测函数 + `servingPort()` | ~360 行 |

**修改：**

| 路径 | 改动 |
|---|---|
| `lib/index.js` | 新增两条路由 `GET /api/dsh-helper-patch/restart/status`、`POST /api/dsh-helper-patch/restart`；导入 `restart.js` 的 `scheduleRestart` 等；`ensureConfig` 加 `restartEnabled` 默认值；`handleConfigRequest` 加该字段读写 |
| `src/client/index.jsx` | 新增 `RestartAction` 组件；`apply(ctx)` 内追加 `settings.action` 注入 |
| `package.json` | `files` 加 `"src"`；`exports` 加 `"./host/dsh-cli.js"`、`"./host/http-trust.js"`、`"./host/restart.js"`；`dsh.client.inject` 不变 |

**重生成：**

| 路径 | 改动 |
|---|---|
| `lib/client.js` | 由 `tools/build-client.mjs` 生成（不改脚本） |

---

## Task 1: 新增 `src/host/dsh-cli.js`（nodeExecutable + dshArgv）

**Files:**
- Create: `src/host/dsh-cli.js`
- Test: 手动（unit test 留到 Task 4 统一加，避免任务碎片化）

**Interfaces:**
- Consumes: `node:fs`, `node:path`, `node:os`
- Produces:
  - `export function nodeExecutable(argv0?: string, execPath?: string): string`
  - `export function dshArgv(): { file: string; args: string[]; cwd: string | undefined; viaShell: boolean }`

- [ ] **Step 1: 写文件**（完全照搬 dshmarket `src/dsh-cli.ts:50` 与 `:367`，ts → js 翻译即可）

```javascript
/**
 * 复刻自 dshmarket/src/dsh-cli.ts:50 (nodeExecutable) 与 :367 (dshArgv)，
 * ts → js 翻译，无行为差异。Android 上 argv0 是真 node 二进制，execPath 是
 * linker64，spawn execPath 会把 --expose-internals 当程序路径，所以优先 argv0。
 */
import { existsSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';

/**
 * 真正可执行的 Node 路径。Android 走动态链接器，process.execPath 是 linker64，
 * spawn 它会把 --expose-internals 当作程序路径而失败（"expected absolute path"）。
 * process.argv0 是真正的 node，优先用；当 argv0 是存在的绝对路径时才用它，
 * 其它情况回退到 execPath。
 *
 * @param {string | undefined} argv0 - process.argv0，可注入便于测试
 * @param {string} execPath - process.execPath，可注入便于测试
 * @returns {string}
 */
export function nodeExecutable(argv0 = process.argv0, execPath = process.execPath) {
  if (argv0 !== undefined && argv0 !== '' && isAbsolute(argv0) && existsSync(argv0)) {
    return argv0;
  }
  return execPath;
}

/**
 * 重启时用来拉起 DSH 的 argv。
 *
 * 复刻自 dshmarket/src/dsh-cli.ts:367：
 *   - 若 process.argv[1] 命中 /[\\/](?:bin\.(?:js|ts)|dsh)$/（即 dsh 入口），
 *     用 node + process.execArgv + 绝对化的入口，cwd 取入口所在目录；
 *   - 否则回退到 PATH 里的 `dsh`（Windows 是 .cmd shim，必须经 shell）。
 *
 * 为什么要绝对路径：pnpm dsh 这种源码启动传入的是相对入口，子进程按自己的
 * cwd 解析会 MODULE_NOT_FOUND（#13）。cwd 在入口附近保证 execArgv 里的
 * tsx/esm 仍能解析。
 *
 * @returns {{ file: string; args: string[]; cwd: string | undefined; viaShell: boolean }}
 */
export function dshArgv() {
  const entry = process.argv[1];
  const winCmdShim = process.platform === 'win32';
  if (entry !== undefined && /[\\/](?:bin\.(?:js|ts)|dsh)$/.test(entry)) {
    const abs = resolve(entry);
    return {
      file: nodeExecutable(),
      args: [...process.execArgv, abs],
      cwd: dirname(abs),
      viaShell: false,
    };
  }
  return { file: 'dsh', args: [], cwd: undefined, viaShell: winCmdShim };
}
```

- [ ] **Step 2: 静态检查**

```bash
cd /Users/biaoge/web/t-team/dsh-helper-patch && node --check src/host/dsh-cli.js
```

期望：退出码 0，无输出。

- [ ] **Step 3: 冒烟导出**

```bash
cd /Users/biaoge/web/t-team/dsh-helper-patch && node --input-type=module -e "import('./src/host/dsh-cli.js').then(m => console.log(typeof m.nodeExecutable, typeof m.dshArgv))"
```

期望输出：`function function`

- [ ] **Step 4: Commit**

```bash
cd /Users/biaoge/web/t-team/dsh-helper-patch && \
  git add src/host/dsh-cli.js && \
  git -c user.email='agent@local' -c user.name='agent' commit -m 'feat(host): 复刻 dshmarket dsh-cli 子集 (nodeExecutable/dshArgv)'
```

---

## Task 2: 新增 `src/host/http-trust.js`（loopbackAuthority + trustedRestartRequest）

**Files:**
- Create: `src/host/http-trust.js`

**Interfaces:**
- Consumes: `node:url`（仅 Node 内置）
- Produces:
  - `export function loopbackAuthority(host: string | undefined): boolean`
  - `export function trustedRestartRequest(request: { headers, socket }): boolean`

- [ ] **Step 1: 写文件**（照搬 dshmarket `src/http.ts:66` 与 `src/restart.ts:198`）

```javascript
/**
 * 复刻自 dshmarket/src/http.ts:66 与 src/restart.ts:198。
 *
 * 为什么重启需要"环回权威"而不只是"环回 peer"：
 * DNS rebinding 攻击可以让攻击者控制的页面到达 127.0.0.1。
 * socket.remoteAddress 看起来是环回，但 Host 头里写的是攻击者的域名。
 * Host 头是攻击者**不能**伪造的部分（因为 DNS rebinding 的精髓就是 host 头
 * 跟 remoteAddress 对不上），所以 Host 必须命名一个环回权威才放行。
 */

/**
 * @param {string | undefined} host
 * @returns {boolean}
 */
export function loopbackAuthority(host) {
  if (typeof host !== 'string' || host === '') return false;
  // strip optional :port
  const hostname = host.replace(/:\d+$/u, '').toLowerCase();
  return hostname === 'localhost'
    || hostname === '127.0.0.1'
    || hostname === '[::1]'
    || hostname === '::1'
    || hostname === '0.0.0.0';
}

/**
 * 进程控制请求是否来自同源环回 Web 客户端。
 *
 * 三道关：
 *   1. socket.remoteAddress 必须是 127.0.0.1 / ::1 / ::ffff:127.0.0.1 之一
 *   2. 不能有任何转发头（forwarded / x-forwarded-for / x-real-ip），
 *      否则环回 peer 实际上是代理
 *   3. Host 头必须命名一个环回权威（loopbackAuthority）
 *   4. Origin 头必须 === Host（同源；DNS rebinding 攻击绕不过 Origin 校验，
 *      因为 Origin 也得用攻击者域名，浏览器拒绝在私有网络上 fetch 跨源）
 *
 * @param {{ headers: Record<string, string | string[] | undefined>, socket: { remoteAddress?: string } }} request
 * @returns {boolean}
 */
export function trustedRestartRequest(request) {
  const address = request.socket?.remoteAddress;
  if (address !== '127.0.0.1' && address !== '::1' && address !== '::ffff:127.0.0.1') {
    return false;
  }
  const h = request.headers;
  if (h.forwarded !== undefined
    || h['x-forwarded-for'] !== undefined
    || h['x-real-ip'] !== undefined) {
    return false;
  }
  const origin = h.origin;
  const host = h.host;
  if (!loopbackAuthority(typeof host === 'string' ? host : undefined)) return false;
  if (typeof origin !== 'string' || typeof host !== 'string') return false;
  try {
    const parsed = new URL(origin);
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:')
      && parsed.host === host;
  } catch {
    return false;
  }
}
```

- [ ] **Step 2: 静态检查**

```bash
cd /Users/biaoge/web/t-team/dsh-helper-patch && node --check src/host/http-trust.js
```

期望：退出码 0。

- [ ] **Step 3: 导出检查**

```bash
cd /Users/biaoge/web/t-team/dsh-helper-patch && node --input-type=module -e "import('./src/host/http-trust.js').then(m => console.log(typeof m.loopbackAuthority, typeof m.trustedRestartRequest))"
```

期望输出：`function function`

- [ ] **Step 4: 快速断言**

```bash
cd /Users/biaoge/web/t-team/dsh-helper-patch && node --input-type=module -e "
import('./src/host/http-trust.js').then(({ loopbackAuthority, trustedRestartRequest }) => {
  // loopbackAuthority
  console.assert(loopbackAuthority('localhost:3080') === true);
  console.assert(loopbackAuthority('127.0.0.1:3080') === true);
  console.assert(loopbackAuthority('[::1]:3080') === true);
  console.assert(loopbackAuthority('example.com') === false);
  console.assert(loopbackAuthority(undefined) === false);
  // trustedRestartRequest
  const ok = { socket: { remoteAddress: '127.0.0.1' }, headers: { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' } };
  console.assert(trustedRestartRequest(ok) === true);
  const bad1 = { ...ok, headers: { ...ok.headers, 'x-forwarded-for': '1.2.3.4' } };
  console.assert(trustedRestartRequest(bad1) === false);
  const bad2 = { ...ok, socket: { remoteAddress: '10.0.0.1' } };
  console.assert(trustedRestartRequest(bad2) === false);
  const bad3 = { ...ok, headers: { ...ok.headers, host: 'evil.example.com:3080', origin: 'http://evil.example.com:3080' } };
  console.assert(trustedRestartRequest(bad3) === false);
  const bad4 = { ...ok, headers: { ...ok.headers, origin: 'http://other.com' } };
  console.assert(trustedRestartRequest(bad4) === false);
  console.log('ok');
});
"
```

期望输出：`ok`（任一 `console.assert` 失败会抛 AssertionError）。

- [ ] **Step 5: Commit**

```bash
cd /Users/biaoge/web/t-team/dsh-helper-patch && \
  git add src/host/http-trust.js && \
  git -c user.email='agent@local' -c user.name='agent' commit -m 'feat(host): 复刻 dshmarket http-trust 子集 (loopback/trustedRestartRequest)'
```

---

## Task 3: 新增 `src/host/restart.js`（运行核心：检测 + 调度 + helper 脚本生成）

**Files:**
- Create: `src/host/restart.js`

**Interfaces:**
- Consumes: `src/host/dsh-cli.js` (`nodeExecutable`)、`node:child_process`、`node:fs`、`node:inspector`、`node:os`、`node:path`、`node:url`
- Produces:
  - `export function detectedSupervisor(env?, ppid?, parentComm?): 'systemd' | null`
  - `export function detectedDebugger(inspectorUrl?, execArgv?, nodeOptions?): 'inspector' | null`
  - `export function servingPort(request: { headers }): number | null`
  - `export function restartLaunch(): { file, args, cwd, viaShell }`
  - `export function respawnInvocation(launch, platform?): { file, args, viaShell, detached }`
  - `export function restartHelperSource(spawned, launch, logs, port): string`
  - `export function scheduleRestart(port?: number | null): { pid, helperPid, logOut, logErr }`

- [ ] **Step 1: 写文件**

```javascript
/**
 * 复刻自 dshmarket/src/restart.ts（运行核心 + 三道安全闸 + helper）。
 *
 * 与 dshmarket 的差异：
 *   - helper 内日志前缀 [dsh-market] → [dsh-helper-patch]
 *   - 日志文件名模板 dsh-market-restart-* → dsh-helper-patch-restart-*
 *   - scheduleRestart 不接受 recovery 参数（不写 .recovery.json）
 *   - restartHelperSource 不带 recovery 移交分支
 *   - 删除 recoveryScriptPath（依赖 lib/recovery.js 产物，本插件无产物）
 *
 * 安全闸逻辑一行不漏照搬：
 *   - supervisor: INVOCATION_ID||JOURNAL_STREAM 且 (ppid===1 || comm==='systemd')
 *   - debugger:   inspector.url() || execArgv/NODE_OPTIONS 按 token 前缀匹配
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
    'const note = (line) => { try { fs.appendFileSync(logErr, `[dsh-helper-patch] ${line}\\n`) } catch {} }',
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
  const logOut = join(tmpdir(), `dsh-helper-patch-restart-${stamp}.out.log`);
  const logErr = join(tmpdir(), `dsh-helper-patch-restart-${stamp}.err.log`);
  const helper = spawn(
    nodeExecutable(),
    ['-e', restartHelperSource(spawned, launch, { out: logOut, err: logErr }, port)],
    { detached: true, stdio: 'ignore', env: process.env },
  );
  helper.unref();
  setTimeout(() => process.kill(process.pid, 'SIGTERM'), 500);
  return { pid: process.pid, helperPid: helper.pid, logOut, logErr };
}
```

- [ ] **Step 2: 静态检查**

```bash
cd /Users/biaoge/web/t-team/dsh-helper-patch && node --check src/host/restart.js
```

期望：退出码 0。

- [ ] **Step 3: 导出检查**

```bash
cd /Users/biaoge/web/t-team/dsh-helper-patch && node --input-type=module -e "import('./src/host/restart.js').then(m => console.log(Object.keys(m).sort().join(',')))"
```

期望输出包含：`detectedDebugger,detectedSupervisor,respawnInvocation,restartHelperSource,restartLaunch,scheduleRestart,servingPort,setDetectedDebuggerOverride`

- [ ] **Step 4: 纯函数快速断言**

```bash
cd /Users/biaoge/web/t-team/dsh-helper-patch && node --input-type=module -e "
import('./src/host/restart.js').then(({
  detectedSupervisor, detectedDebugger, servingPort, restartLaunch,
  respawnInvocation, restartHelperSource,
}) => {
  // detectedSupervisor: 两个信号同时成立
  console.assert(detectedSupervisor({}, 1) === null, 'no env');
  console.assert(detectedSupervisor({ INVOCATION_ID: 'x' }, 1) === 'systemd', 'env+ppid=1');
  console.assert(detectedSupervisor({ JOURNAL_STREAM: 'x' }, 99) === null, 'env only');
  // detectedDebugger: 注入覆盖
  console.assert(detectedDebugger(undefined, [], '') === null, 'clean');
  console.assert(detectedDebugger('ws://x', [], '') === 'inspector', 'inspector url');
  console.assert(detectedDebugger(undefined, ['--inspect=9229'], '') === 'inspector', 'execArgv');
  console.assert(detectedDebugger(undefined, [], '--inspect') === 'inspector', 'NODE_OPTIONS');
  console.assert(detectedDebugger(undefined, [], '') === null, 'clean again');
  // servingPort
  console.assert(servingPort({ headers: { host: '127.0.0.1:3080' } }) === 3080, 'parse');
  console.assert(servingPort({ headers: { host: '127.0.0.1' } }) === null, 'no port');
  console.assert(servingPort({ headers: {} }) === null, 'no host');
  // respawnInvocation: POSIX & Windows
  console.assert(respawnInvocation({ file: 'a', args: [], viaShell: false }, 'linux').detached === true);
  console.assert(respawnInvocation({ file: 'a', args: [], viaShell: false }, 'win32').file === 'powershell.exe');
  console.assert(respawnInvocation({ file: 'dsh', args: [], viaShell: true }, 'win32').args[0] === '-NoProfile');
  // restartHelperSource: 闭合脚本能正常 node -e 执行
  const src = restartHelperSource(
    { file: '/bin/echo', args: ['ok'], viaShell: false, detached: false },
    { cwd: '/' },
    { out: '/tmp/out.log', err: '/tmp/err.log' },
    3080,
  );
  console.assert(typeof src === 'string' && src.includes('[dsh-helper-patch]'), 'log prefix');
  console.log('ok');
});
"
```

期望输出：`ok`。

- [ ] **Step 5: helper 脚本能独立 node 跑通（写在临时文件里跑，避免 ESM/CJS 混用 + -e 转义地狱）**

```bash
cat > /tmp/dhp-restart-smoke.mjs <<'EOF'
import { openSync, readFileSync } from 'node:fs';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { restartHelperSource } from '/Users/biaoge/web/t-team/dsh-helper-patch/src/host/restart.js';

openSync('/tmp/dhp-restart-smoke.err', 'w');
openSync('/tmp/dhp-restart-smoke.out', 'w');

const probe = net.createServer();
await new Promise((r) => probe.listen(0, '127.0.0.1', r));
const port = probe.address().port;
await new Promise((r) => probe.close(r));

const src = restartHelperSource(
  { file: process.execPath, args: ['-e', 'console.log("hi from replacement"); setTimeout(() => process.exit(0), 100)'], viaShell: false, detached: false },
  { cwd: '/' },
  { out: '/tmp/dhp-restart-smoke.out', err: '/tmp/dhp-restart-smoke.err' },
  port,
);

spawn(process.execPath, ['-e', src], { stdio: 'ignore' });
// 等候时间：1200ms 太短，process.on("exit") 来不及 flush "helper exiting (code 0)"；3500ms 经验值覆盖到完整 settle + exit 链。
await new Promise((r) => setTimeout(r, 3500));

const err = readFileSync('/tmp/dhp-restart-smoke.err', 'utf8');
const out = readFileSync('/tmp/dhp-restart-smoke.out', 'utf8');
console.log('---err---'); console.log(err);
console.log('---out---'); console.log(out);
console.assert(err.includes('[dsh-helper-patch]'), 'prefix');
console.assert(err.includes('helper up'), 'stage: up');
console.assert(err.includes('is free'), 'stage: free');
console.assert(err.includes('replacement started'), 'stage: started');
console.assert(err.includes('helper exiting'), 'stage: exit');
console.assert(out.includes('hi from replacement'), 'replacement ran');
console.log('ok');
EOF
cd /Users/biaoge/web/t-team/dsh-helper-patch && node /tmp/dhp-restart-smoke.mjs
```

期望：
- 控制台打印 `---err---` 段至少含 `[dsh-helper-patch] helper up ... for port <N>`、`port <N> is free; starting the replacement`、`replacement started (pid <N>)`、`helper exiting (code 0)`
- `---out---` 段含 `hi from replacement`
- 最后一行 `ok`

- [ ] **Step 6: Commit**

```bash
cd /Users/biaoge/web/t-team/dsh-helper-patch && \
  git add src/host/restart.js && \
  git -c user.email='agent@local' -c user.name='agent' commit -m 'feat(host): 复刻 dshmarket restart 运行核心 (scheduleRestart + 三道闸)'
```

---

## Task 4: 更新 `package.json`（files + exports）

**Files:**
- Modify: `package.json`

**Interfaces:**
- 无（配置文件）

- [ ] **Step 1: 编辑 `package.json`**

```bash
cd /Users/biaoge/web/t-team/dsh-helper-patch
```

将 `exports` 字段从：

```json
  "exports": {
    ".": "./lib/index.js",
    "./client": "./lib/client.js",
    "./cordis.patch.yml": "./cordis.patch.yml",
    "./package.json": "./package.json"
  },
```

改为：

```json
  "exports": {
    ".": "./lib/index.js",
    "./client": "./lib/client.js",
    "./cordis.patch.yml": "./cordis.patch.yml",
    "./package.json": "./package.json",
    "./host/dsh-cli": "./src/host/dsh-cli.js",
    "./host/http-trust": "./src/host/http-trust.js",
    "./host/restart": "./src/host/restart.js"
  },
```

`files` 字段从：

```json
  "files": [
    "lib",
    "cordis.patch.yml",
    "README.md"
  ],
```

改为：

```json
  "files": [
    "lib",
    "src/host",
    "cordis.patch.yml",
    "README.md"
  ],
```

（**只**发布 `src/host/`；`src/client/` 是构建源，不在 npm 包内。）

用 `edit` 工具精确替换这两处（一次只替换一处以确保唯一性）：

- 第一个 `edit`：`old_string` 整个 `exports` 块，`new_string` 是新 `exports` 块
- 第二个 `edit`：`old_string` 整个 `files` 块，`new_string` 是新 `files` 块

- [ ] **Step 2: 验证 JSON 合法**

```bash
cd /Users/biaoge/web/t-team/dsh-helper-patch && node -e "JSON.parse(require('fs').readFileSync('package.json','utf8'))" && echo ok
```

期望：`ok`

- [ ] **Step 3: Commit**

```bash
cd /Users/biaoge/web/t-team/dsh-helper-patch && \
  git add package.json && \
  git -c user.email='agent@local' -c user.name='agent' commit -m 'chore(package): 暴露 src/host/* 三个 ESM 子模块'
```

---

## Task 5: 在 `lib/index.js` 注册两条新路由 + 接受 `restartEnabled` 配置

**Files:**
- Modify: `lib/index.js`

**Interfaces:**
- Consumes: `src/host/restart.js` (`scheduleRestart`, `detectedSupervisor`, `detectedDebugger`)、`src/host/http-trust.js` (`trustedRestartRequest`)、`src/host/restart.js` (`servingPort`)
- Produces（新增）：
  - `POST /api/dsh-helper-patch/restart` → 202 `{ pid, helperPid, logOut, logErr }` 或 403 `{ error, reason }`
  - `GET /api/dsh-helper-patch/restart/status` → 200 `{ allowed, reason, supervisor, debugger, restartEnabled }`

- [ ] **Step 1: 在文件顶部加 import**（紧跟现有 import 块）

用 `edit` 替换：

```
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
```

为：

```
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  detectedDebugger,
  detectedSupervisor,
  scheduleRestart,
  servingPort,
} from '../src/host/restart.js';
import { trustedRestartRequest } from '../src/host/http-trust.js';
```

**注意：** `../src/host/restart.js` 路径相对于 `lib/index.js`（运行时 ESM 通过 `import` 解析，从 `lib/` 上跳一级）。Node ESM 不会在打包时改路径，所以引用一旦确定就是这个相对路径。如果未来拆包（如 `out/`），需要按产物位置同步调整。

- [ ] **Step 2: 在 `RESTART_HTTP_PATH` 与 `RESTART_STATUS_HTTP_PATH` 常量附近加两条路径**

用 `edit` 在文件第 38 行（紧跟 `const SEND_HTTP_PATH = '/api/dsh-helper-patch/send-file';`）后插入：

```
const RESTART_HTTP_PATH = '/api/dsh-helper-patch/restart';
const RESTART_STATUS_HTTP_PATH = '/api/dsh-helper-patch/restart/status';
```

- [ ] **Step 3: 在 `ensureConfig` 里加默认 `restartEnabled`**

用 `edit` 把：

```js
  const patch = {};
  if (typeof current.enabled !== 'boolean') patch.enabled = true;
  if (typeof current.imageAsPicture !== 'boolean') patch.imageAsPicture = true;
```

改为：

```js
  const patch = {};
  if (typeof current.enabled !== 'boolean') patch.enabled = true;
  if (typeof current.imageAsPicture !== 'boolean') patch.imageAsPicture = true;
  if (typeof current.restartEnabled !== 'boolean') patch.restartEnabled = true;
```

- [ ] **Step 4: 在 `handleConfigRequest` 的 GET 与 POST 路径里都加 `restartEnabled` 字段**

用 `edit` 把：

```js
      const settings = await ensureConfig();
      json(response, 200, {
        enabled: settings.enabled !== false,
        imageAsPicture: settings.imageAsPicture !== false,
        botId: typeof settings.botId === 'string' ? settings.botId : '',
        toUserId: typeof settings.toUserId === 'string' ? settings.toUserId : '',
      });
```

改为：

```js
      const settings = await ensureConfig();
      json(response, 200, {
        enabled: settings.enabled !== false,
        imageAsPicture: settings.imageAsPicture !== false,
        restartEnabled: settings.restartEnabled !== false,
        botId: typeof settings.botId === 'string' ? settings.botId : '',
        toUserId: typeof settings.toUserId === 'string' ? settings.toUserId : '',
      });
```

再用 `edit` 把：

```js
      if (typeof payload?.enabled === 'boolean') patch.enabled = payload.enabled;
      if (typeof payload?.imageAsPicture === 'boolean') patch.imageAsPicture = payload.imageAsPicture;
      if (typeof payload?.botId === 'string') patch.botId = payload.botId.trim();
      if (typeof payload?.toUserId === 'string') patch.toUserId = payload.toUserId.trim();
```

改为：

```js
      if (typeof payload?.enabled === 'boolean') patch.enabled = payload.enabled;
      if (typeof payload?.imageAsPicture === 'boolean') patch.imageAsPicture = payload.imageAsPicture;
      if (typeof payload?.restartEnabled === 'boolean') patch.restartEnabled = payload.restartEnabled;
      if (typeof payload?.botId === 'string') patch.botId = payload.botId.trim();
      if (typeof payload?.toUserId === 'string') patch.toUserId = payload.toUserId.trim();
```

- [ ] **Step 5: 添加两个 handler 函数**（紧跟 `handleSendRequest` 函数定义之后，`resolveDshImDir` 之前）

```js
/**
 * GET /api/dsh-helper-patch/restart/status
 * 返回按钮渲染所需的状态：能否点 + 不可点的原因。
 */
async function handleRestartStatusRequest(request, response) {
  if (request.method !== 'GET') {
    json(response, 405, { error: 'method-not-allowed' });
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
 * POST /api/dsh-helper-patch/restart
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
```

用 `edit` 替换 `function resolveDshImDir(configured) {` 前的空行，把这两个函数插进去（注意：`resolveDshImDir` 是同步函数，不是 `async`）。

- [ ] **Step 6: 在 `apply(ctx, config)` 的 `webServer.register` 块里加两条路由注册**

用 `edit` 把：

```js
    httpCtx.effect(
      () => httpCtx.webServer.register({
        kind: 'exact',
        path: SEND_HTTP_PATH,
        handler: (request, response) => handleSendRequest(request, response, httpCtx),
      }),
      `dsh-helper-patch: ${SEND_HTTP_PATH}`,
    );
  });
```

改为：

```js
    httpCtx.effect(
      () => httpCtx.webServer.register({
        kind: 'exact',
        path: SEND_HTTP_PATH,
        handler: (request, response) => handleSendRequest(request, response, httpCtx),
      }),
      `dsh-helper-patch: ${SEND_HTTP_PATH}`,
    );
    httpCtx.effect(
      () => httpCtx.webServer.register({
        kind: 'exact',
        path: RESTART_STATUS_HTTP_PATH,
        handler: handleRestartStatusRequest,
      }),
      `dsh-helper-patch: ${RESTART_STATUS_HTTP_PATH}`,
    );
    httpCtx.effect(
      () => httpCtx.webServer.register({
        kind: 'exact',
        path: RESTART_HTTP_PATH,
        handler: handleRestartRequest,
      }),
      `dsh-helper-patch: ${RESTART_HTTP_PATH}`,
    );
  });
```

- [ ] **Step 7: 静态检查**

```bash
cd /Users/biaoge/web/t-team/dsh-helper-patch && node --check lib/index.js
```

期望：退出码 0。

- [ ] **Step 8: 冒烟导入**

```bash
cd /Users/biaoge/web/t-team/dsh-helper-patch && node --input-type=module -e "import('./lib/index.js').then(m => console.log(typeof m.apply, typeof m.chooseDeliveryMethod, typeof m.isImagePayload))"
```

期望输出：`function function function`

- [ ] **Step 9: Commit**

```bash
cd /Users/biaoge/web/t-team/dsh-helper-patch && \
  git add lib/index.js && \
  git -c user.email='agent@local' -c user.name='agent' commit -m 'feat(host): 注册 /api/dsh-helper-patch/restart 与 /restart/status 路由'
```

---

## Task 6: 在 `src/client/index.jsx` 加 RestartAction + settings.action 注入

**Files:**
- Modify: `src/client/index.jsx`

**Interfaces:**
- Consumes: 现有 `fetch` 模式（与 `readConfig`/`writeConfig` 同形状）
- Produces:
  - 导出 `RestartAction` 组件
  - 在 `apply(ctx)` 内追加 `ctx.slots.inject("settings.action", () => ctx.slots.register({ name: "settings.action", id: "restart-host", order: 10 }, RestartAction))`

- [ ] **Step 1: 加两条常量与一个 fetch 包装**（紧跟 `PLUGIN_ID` 常量后）

用 `edit` 把：

```jsx
const CONFIG_PATH = "/api/dsh-helper-patch/config";
const PLUGIN_ID = "dsh-helper-patch";
```

改为：

```jsx
const CONFIG_PATH = "/api/dsh-helper-patch/config";
const RESTART_STATUS_PATH = "/api/dsh-helper-patch/restart/status";
const RESTART_PATH = "/api/dsh-helper-patch/restart";
const PLUGIN_ID = "dsh-helper-patch";

/** 把 reason 翻成给用户看的按钮 title。 */
function restartDisabledTitle(reason) {
  switch (reason) {
    case "disabled-in-config":
      return "重启功能已在「设置 → 辅助补丁」中关闭";
    case "debugger":
      return "宿主正被调试器附着，不能重启";
    case "supervisor":
      return "宿主由 systemd 等监督器管理，重启功能已禁用";
    case "untrusted":
      return "请求来源不是同源环回";
    default:
      return `重启不可用（${String(reason)}）`;
  }
}
```

- [ ] **Step 2: 在文件末尾、`export function apply(ctx)` 之前追加 `RestartAction` 组件**

用 `edit` 把：

```jsx
export function apply(ctx) {
  ctx.slots.inject("settings.section", () => ctx.slots.register({
```

改为：

```jsx
function RestartAction() {
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    let alive = true;
    fetch(RESTART_STATUS_PATH, { headers: { accept: "application/json" } })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((value) => { if (alive) setStatus(value); })
      .catch((cause) => {
        if (!alive) return;
        setStatus({ allowed: false, reason: "fetch-failed", error: cause?.message ?? String(cause) });
      });
    return () => { alive = false; };
  }, []);

  const handleClick = useCallback(async () => {
    if (busy || (status && !status.allowed)) return;
    // 与现有 SettingsDocumentAction 视觉一致：native confirm，不引 dialog 依赖
    if (typeof window !== "undefined" && !window.confirm("确定重启 DeepSeek Harness 吗？所有会话会断开。")) {
      return;
    }
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch(RESTART_PATH, {
        method: "POST",
        headers: { accept: "application/json" },
      });
      if (response.status === 202) {
        setMessage("已请求重启，等待新进程接管…");
        // 本进程 500ms 后自杀；浏览器自然重连
        return;
      }
      const body = await response.json().catch(() => ({}));
      setMessage(`重启失败：${body.error ?? `HTTP ${response.status}`}`);
    } catch (cause) {
      setMessage(`重启失败：${cause?.message ?? String(cause)}`);
    } finally {
      setBusy(false);
    }
  }, [busy, status]);

  const allowed = status?.allowed === true;
  const disabled = busy || (status !== null && !allowed);
  const title = !status
    ? "正在检测重启状态…"
    : allowed
      ? "重启 DeepSeek Harness"
      : restartDisabledTitle(status.reason);

  return React.createElement("div", { style: { display: "inline-flex", alignItems: "center", gap: "8px" } },
    React.createElement("button", {
      type: "button",
      onClick: handleClick,
      disabled,
      title,
      "aria-label": title,
      style: {
        display: "inline-flex",
        alignItems: "center",
        gap: "6px",
        height: "28px",
        padding: "0 12px",
        borderRadius: "6px",
        border: "1px solid " + (allowed && !busy ? "#22a06b" : "#c8c8c8"),
        background: allowed && !busy ? "#22a06b" : "#f1f1f1",
        color: allowed && !busy ? "#fff" : "#9aa0a6",
        fontSize: "0.85em",
        fontWeight: 600,
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.7 : 1,
      },
    }, busy ? "正在重启…" : "重启"),
    message ? React.createElement("span", {
      style: {
        fontSize: "0.8em",
        opacity: 0.75,
        color: message.startsWith("重启失败") ? "#d64545" : "#22a06b",
      },
    }, message) : null,
  );
}

export function apply(ctx) {
  ctx.slots.inject("settings.section", () => ctx.slots.register({
```

- [ ] **Step 3: 在 `apply(ctx)` 函数体内追加 settings.action 注入**

用 `edit` 把 `apply(ctx)` 函数体的结束 `});` 之前、紧跟现有 `settings.section` 注册：

```js
export function apply(ctx) {
  ctx.slots.inject("settings.section", () => ctx.slots.register({
    name: "settings.section",
    id: PLUGIN_ID,
    order: 20,
    label: () => "辅助补丁",
    icon: "spark",
  }, () => React.createElement(SettingsPanel)));
}
```

改为：

```js
export function apply(ctx) {
  ctx.slots.inject("settings.section", () => ctx.slots.register({
    name: "settings.section",
    id: PLUGIN_ID,
    order: 20,
    label: () => "辅助补丁",
    icon: "spark",
  }, () => React.createElement(SettingsPanel)));
  ctx.slots.inject("settings.action", () => ctx.slots.register({
    name: "settings.action",
    id: "restart-host",
    order: 10,
    label: () => "重启 DeepSeek Harness",
  }, RestartAction));
}
```

- [ ] **Step 4: 静态检查（jsx 用 esbuild，语法错会报）**

```bash
cd /Users/biaoge/web/t-team/dsh-helper-patch && node --check src/client/index.jsx 2>&1 || node tools/build-client.mjs && echo ok
```

期望：构建成功，`已生成 lib/client.js（NNN 字节）`（具体字节数不重要，但必须成功）。

- [ ] **Step 5: 重建 bundle 并检查字节增量**

```bash
cd /Users/biaoge/web/t-team/dsh-helper-patch && \
  BEFORE=$(wc -c < lib/client.js) && \
  node tools/build-client.mjs && \
  AFTER=$(wc -c < lib/client.js) && \
  echo "before=$BEFORE after=$AFTER delta=$((AFTER - BEFORE))"
```

期望：delta < 4096。

- [ ] **Step 6: 验证 bundle 含新注入字符串**

```bash
cd /Users/biaoge/web/t-team/dsh-helper-patch && grep -c 'restart-host\|restart-host' lib/client.js
```

期望：≥ 2（出现在 `id` 与 `register` 周边）。

- [ ] **Step 7: Commit**

```bash
cd /Users/biaoge/web/t-team/dsh-helper-patch && \
  git add src/client/index.jsx lib/client.js && \
  git -c user.email='agent@local' -c user.name='agent' commit -m 'feat(client): 设置头部加「重启 DeepSeek Harness」按钮'
```

---

## Task 7: README.md 加一段使用说明

**Files:**
- Modify: `README.md`

- [ ] **Step 1: 在 README 顶部加一段说明**（紧跟首个标题之后）

用 `read` 先看 `README.md` 的前 30 行确定插入锚点。

- [ ] **Step 2: 追加「重启 DeepSeek Harness」段落**

内容模板：

```markdown
## 重启 DeepSeek Harness

设置 → 通用设置 头部「打开配置文件」按钮右侧新增一个「重启」按钮。
点击后：

1. 弹出确认提示
2. 服务端过四道闸：
   - 配置开关（`config.json` 的 `restartEnabled`，默认 `true`）
   - 请求来源（同源环回，无转发头，Host 必须是环回权威）
   - 调试器附着（`--inspect` / `NODE_OPTIONS` / `inspector.open()`）
   - 进程监督器（`systemd` 等——避免脱离 cgroup 的 helper 杀死生产服务）
3. spawn 一个脱离的 helper，等当前端口空闲后起新进程
4. 本进程 500ms 后自杀，浏览器自然重连

失败日志写在 `/tmp/dsh-helper-patch-restart-<时间戳>.{out,err}.log`。
```

- [ ] **Step 3: Commit**

```bash
cd /Users/biaoge/web/t-team/dsh-helper-patch && \
  git add README.md && \
  git -c user.email='agent@local' -c user.name='agent' commit -m 'docs(readme): 说明新增的一键重启按钮与安全闸'
```

---

## Task 8: 端到端冒烟（重启真的会发生）

**Files:**
- 无（验证用）

- [ ] **Step 1: 确认环境**

```bash
dsh --version 2>&1 | head -5
ls -la /Users/biaoge/.dsh/profiles/web/node_modules/dsh-helper-patch
```

期望：dsh 可用；node_modules 里的 dsh-helper-patch 与 `/Users/biaoge/web/t-team/dsh-helper-patch/` 同步（link 安装）。

- [ ] **Step 2: 启动宿主（保持前台进程在另一个终端或后台）**

由于会真重启——用本地化测试端口（如 `dsh web --port 13080`）避免影响日常 3080。

```bash
dsh web --port 13080 &
WS_PID=$!
sleep 5
echo "host pid=$WS_PID"
```

期望：5s 后宿主开始监听 13080。

- [ ] **Step 3: curl GET status**

```bash
curl -sS http://127.0.0.1:13080/api/dsh-helper-patch/restart/status
```

期望 JSON：
```json
{ "allowed": true, "reason": null, "supervisor": null, "debugger": null, "restartEnabled": true }
```
（如果失败，则 `reason` 是 `supervisor` 或 `debugger`，对应本地环境说明）

- [ ] **Step 4: POST restart（绕过浏览器，手动构造 Origin）**

```bash
curl -sS -X POST http://127.0.0.1:13080/api/dsh-helper-patch/restart \
  -H "origin: http://127.0.0.1:13080" \
  -H "host: 127.0.0.1:13080" \
  -H "accept: application/json"
```

期望 202：
```json
{ "pid": 55501, "helperPid": 85355, "logOut": "/tmp/dsh-helper-patch-restart-...out.log", "logErr": "/tmp/dsh-helper-patch-restart-...err.log" }
```

约 1-2s 后原 WS_PID 退，新进程接管 13080。`curl -sS http://127.0.0.1:13080/api/dsh-helper-patch/restart/status` 应仍返回 200。

- [ ] **Step 5: 检查日志**

```bash
LATEST=$(ls -t /tmp/dsh-helper-patch-restart-*.err.log 2>/dev/null | head -1)
echo "=== $LATEST ==="
cat "$LATEST"
```

期望含四行：
```
[dsh-helper-patch] helper up (pid N) for port 13080
[dsh-helper-patch] port 13080 is free; starting the replacement
[dsh-helper-patch] replacement started (pid N)
[dsh-helper-patch] helper exiting (code 0)
```

- [ ] **Step 6: 关闭开关回归测试**

```bash
DSH_HOME_DIR="$HOME/.dsh"
CFG="$DSH_HOME_DIR/integrations/dsh-helper-patch/config.json"
[ -f "$CFG" ] || echo '{}' > "$CFG"
node -e "const fs=require('fs'); const f='$CFG'; const o=JSON.parse(fs.readFileSync(f,'utf8')); o.restartEnabled=false; fs.writeFileSync(f, JSON.stringify(o,null,2)+'\n')"
# 重启宿主以加载配置（手动：用现有重启按钮或 dsh 重启）
# 简化：kill 当前 host；dsh web --port 13080 &
sleep 3
curl -sS http://127.0.0.1:13080/api/dsh-helper-patch/restart/status
```

期望：JSON `allowed: false, reason: "disabled-in-config"`。

- [ ] **Step 7: 还原 config + 清理后台进程**

```bash
node -e "const fs=require('fs'); const f='$HOME/.dsh/integrations/dsh-helper-patch/config.json'; const o=JSON.parse(fs.readFileSync(f,'utf8')); delete o.restartEnabled; fs.writeFileSync(f, JSON.stringify(o,null,2)+'\n')"
pkill -f 'dsh web --port 13080' 2>/dev/null || true
```

期望：后台进程结束，配置回到无 `restartEnabled`（默认 true）。

---

## Self-Review Notes（写完计划后自查）

- **Spec 覆盖：** 设计稿五节（目标 / 文件结构 / host 路由 / 配置 / 客户端 / 日志）全部对应：Task 1-3 实现 host 模块；Task 4 暴露包；Task 5 路由 + 配置；Task 6 按钮；Task 7 文档；Task 8 验证。
- **占位符扫描：** 已扫，无 TBD / TODO / "implement later"。
- **类型一致性：** Task 1-3 定义的导出与 Task 5 的 import 一致（`scheduleRestart`、`detectedSupervisor`、`detectedDebugger`、`servingPort`、`trustedRestartRequest`）；Task 6 的 `RestartAction` 用到的 `RESTART_STATUS_PATH`/`RESTART_PATH` 在 Task 6 Step 1 定义。
- **执行模式：** 每个任务都明确给出 `node --check` 与导入冒烟的可执行命令；Task 8 端到端冒烟要求重启真的会发生，给出具体 curl 命令与期望输出。
- **安全闸顺序：** Task 5 严格按 spec 顺序（restartEnabled → trusted → debugger → supervisor），并逐一对应 403 reason。
- **回滚路径：** Task 8 步 7 隐含了"还原 config"步骤；spec 的"完整回滚"路径需删除 `src/host/` 三个文件 + 还原 `lib/index.js`/`src/client/index.jsx`/`package.json` + 重跑 build，已在 Task 5/6/4 的 `git add` 单步可逆。