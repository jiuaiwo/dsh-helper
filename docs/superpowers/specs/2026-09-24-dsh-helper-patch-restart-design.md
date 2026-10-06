# dsh-helper-patch 增加「重启 DeepSeek Harness」按钮

- 日期：2026-09-24
- 范围：仅复刻 dsh-market `restart.ts` 的运行核心（不含 SSR 恢复面板）。
- 触发：用户在 DSH 会话里要求把 dshmarket 的重启能力搬到 dsh-helper-patch，并在「设置 → 通用设置」头部「打开配置文件」按钮右侧加一个一键重启按钮。

## 目标

1. 在 `dsh-helper-patch`（已经在跑）的 host 端增加一条同源 HTTP 路由 `POST /api/dsh-helper-patch/restart`，调用 dshmarket 的 `scheduleRestart()` 等价实现，**自洽、可独立启用**。
2. 在客户端 `settings.action` 槽位（`kind: "list"`、`scope: "root"`）注册一个新动作 `id: "restart-host"`、`order: 10`，渲染在 `id: "open-document"`（`order: 0`）右侧。
3. 默认启用；通过 `config.json` 的 `restartEnabled: false` 可关闭（与现有 `enabled`/`imageAsPicture` 同形状）。
4. **不**复刻 `recovery.ts`（1146 行，跟 dshmarket 的 plugin inventory 和 cordis.patch 改写深度耦合）。启动失败时浏览器刷新即回到正常状态——对辅助补丁这个使用场景够用。

## 背景与约束

- `dsh-helper-patch` 已 link 安装到 `~/.dsh/profiles/web/node_modules/dsh-helper-patch/`，源码在 `/Users/biaoge/web/t-team/dsh-helper-patch/`。
- 当前 host 侧只有 `lib/index.js`（导出 `apply(ctx, config)`），通过 `ctx.inject(['webServer', 'credentials'], ...)` 注册两条路由。
- 客户端 `src/client/index.jsx` 通过 `ctx.slots.inject("settings.section", ...)` 注册了「辅助补丁」分区。
- `settings.action` slot 由 `@deepseek-ai/dsh-client-ui-settings-general`（0.1.7-rc.1）声明为 `kind: "list"` / `scope: "root"`，仅渲染在「通用设置」面板的 `SettingsRoot.header.actions` 区域内（同区块还有「关闭」按钮）。
- 同 slot 内 `order` 小的排在前面（`open-document` 是 0），新动作用 `order: 10` 即落在它右侧。

## 设计

### 1. 文件结构

新增三个 host 文件（不引入 TypeScript——和现有 `lib/index.js` 一致）：

```
dsh-helper-patch/
├── lib/
│   ├── index.js              ← 改：新增 restart 路由
│   └── client.js             ← 重生成
├── src/
│   ├── client/index.jsx      ← 改：新增 RestartAction 组件 + settings.action 注入
│   └── host/
│       ├── dsh-cli.js        ← 新：nodeExecutable() + dshArgv()
│       ├── http-trust.js     ← 新：loopbackAuthority() + trustedRestartRequest()
│       └── restart.js        ← 新：scheduleRestart() + restartHelperSource() + respawnInvocation() + restartLaunch() + 检测函数
└── tools/build-client.mjs    ← 不改
```

`src/host/` 目录与现有 `src/client/` 对称，也避免和 DSH 通用 `src/` 命名冲突。host 文件用 `.js` 后缀、不做打包（运行时由 DSH cordis 直接 `import`）。

**`package.json` 改动**：在 `files` 数组加入 `"src"`，并新增 `"./src/*": "./src/*"` 的 export（仅 host 三个文件；client 走 `tools/build-client.mjs` 出 `lib/client.js`，不暴露 `src/` 内部结构）。

**ESM 一致性**：现有 `package.json` 已声明 `"type": "module"`，新建的 `src/host/*.js` 全部用 `import/export` 语法（与 `lib/index.js` 保持一致），**不**写 `require`。DSH cordis 通过 ESM loader 加载。

### 2. 服务端 host：路由与调度

新增两条路由（沿用现有 `webServer.register({ kind: 'exact', path, handler })` 写法）：

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/api/dsh-helper-patch/restart/status` | 返回 `{ allowed, reason, supervisor, debugger }`，供按钮在调用前判断能否点击 |
| POST | `/api/dsh-helper-patch/restart` | 调用 `scheduleRestart(port)`，本进程 500ms 后自杀 |

POST 处理器按顺序过四道闸：

1. `settings.restartEnabled !== false`（`config.json` 关闭则 403 `disabled-in-config`）
2. `trustedRestartRequest(request)` —— `src/host/http-trust.js` 的 `trustedRestartRequest`，等价于 dshmarket `restart.ts:198`：`remoteAddress ∈ {127.0.0.1, ::1, ::ffff:127.0.0.1}` 且无任何转发头且 `loopbackAuthority(Host)` 且 `Origin === Host`
3. `detectedDebugger() === null` —— dshmarket `restart.ts:146`，覆盖 `inspector.url()` + `execArgv` + `NODE_OPTIONS` 按 token 前缀匹配
4. `detectedSupervisor() === null` —— dshmarket `restart.ts:101`，要求 `INVOCATION_ID||JOURNAL_STREAM` **且** (`ppid===1` || 父进程 `comm===systemd`)

任一不过即返回 403 + `reason`。全部通过则从 `request.headers.host` 解析端口（`servingPort(request)`，等价 dshmarket `restart.ts:188`），调用 `scheduleRestart(port)`（不带 `recovery` 参数，**不**写 recovery.json）。

成功响应 202：

```json
{ "pid": 55501, "helperPid": 85355,
  "logOut": "/tmp/dsh-helper-patch-restart-2026-09-24T00-26-43.out.log",
  "logErr": "/tmp/dsh-helper-patch-restart-2026-09-24T00-26-43.err.log" }
```

GET `/api/dsh-helper-patch/restart/status` 返回（`allowed` 为 true 当且仅当全部闸默认通过且 `restartEnabled !== false`）：

```json
{ "allowed": false, "reason": "supervisor", "supervisor": "systemd", "debugger": null }
```

复刻源对照（核心逻辑一行不漏，只改日志前缀和文件名模板）：

| dshmarket 源 | dsh-helper-patch 新文件 | 改了什么 |
|---|---|---|
| `src/dsh-cli.ts:50` `nodeExecutable` | `src/host/dsh-cli.js` | 完全照搬 |
| `src/dsh-cli.ts:367` `dshArgv` | `src/host/dsh-cli.js` | 完全照搬 |
| `src/http.ts:66` `loopbackAuthority` | `src/host/http-trust.js` | 完全照搬 |
| `src/restart.ts:39-55` `INSPECT_ARG_PREFIXES` + `tokenHasInspectFlag` + `argvHasInspectFlag` | `src/host/restart.js` | 完全照搬 |
| `src/restart.ts:101` `detectedSupervisor` + `readParentComm` | `src/host/restart.js` | 完全照搬 |
| `src/restart.ts:146` `detectedDebugger` | `src/host/restart.js` | 完全照搬 |
| `src/restart.ts:188` `servingPort` | `src/host/restart.js` | 完全照搬 |
| `src/restart.ts:198` `trustedRestartRequest` | `src/host/http-trust.js` | 完全照搬 |
| `src/restart.ts:250` `restartLaunch` | `src/host/restart.js` | 完全照搬 |
| `src/restart.ts:271` `respawnInvocation` | `src/host/restart.js` | 完全照搬 |
| `src/restart.ts:350` `restartHelperSource` | `src/host/restart.js` | 日志前缀 `[dsh-market]` → `[dsh-helper-patch]`；`.recovery.json` 部分删除（无 recovery 移交） |
| `src/restart.ts:513` `scheduleRestart` | `src/host/restart.js` | 不传 `recovery` 参数；日志模板前缀同上；`recoveryScriptPath` 删除 |

### 3. 配置

`$DSH_HOME/integrations/dsh-helper-patch/config.json`：

```jsonc
{
  "enabled": true,           // 已有：IM 投递总开关
  "imageAsPicture": true,    // 已有
  "restartEnabled": true     // 新增：重启功能开关，默认 true
}
```

`ensureConfig()` 启动时补默认值；`handleConfigRequest` 的 POST 处理里加上对该字段的接受与回显（保持与现有字段完全同形状：trim boolean，不接受非布尔）。

### 4. 客户端：按钮

`src/client/index.jsx` 在末尾 `export function apply(ctx)` 内追加（**不**改现有 settings.section 注入）：

```jsx
ctx.slots.inject("settings.action", () => ctx.slots.register({
  name: "settings.action",
  id: "restart-host",
  order: 10,
  label: () => "重启 DeepSeek Harness",
}, RestartAction));
```

`RestartAction` 组件：

- 挂载时 `GET /api/dsh-helper-patch/restart/status`，根据返回：
  - `allowed === false` → 按钮置灰，`title` 属性显示原因（「宿主在 systemd 下运行，重启功能已禁用」「调试器已附着」或「设置 → 辅助补丁 → 允许重启已关闭」）
  - `allowed === true` → 按钮可点
- 点击：`window.confirm('确定重启 DeepSeek Harness 吗？当前所有会话会断开。')`，确认后 `POST /api/dsh-helper-patch/restart`
- POST 期间按钮文案变「正在重启…」且 disabled
- POST 成功后**不**主动刷新页面——helper 接班完成后浏览器自然重连；显示一行「已请求重启，等待新进程接管…」的提示行
- POST 失败：恢复可点状态 + 错误提示（用现有 `S.error` 样式）

样式尽量贴近现有 `SettingsDocumentAction` 的视觉（同样位于 `SettingsRoot.header.actions`）。具体做法：复用相同的 CSS 类名约定（`@deepseek-ai/dsh-client-ui-settings-general` 未导出 CSS 类名），采用更保守的内联样式，仅包含颜色/间距/边框/圆角四类属性，颜色与现有 `Row` / `Switch` 一致（绿 `#22a06b` / 灰 `#9aa0a6`）。

### 5. 日志与可观测性

- helper 启动时写一条 `helper up (pid N) for port N`
- 端口释放后写 `port N is free; starting the replacement`
- 替代进程退出码、SETTLE_MS 未达成等失败信息写进 `logErr`
- helper 自身 `exit` / `uncaughtException` / `unhandledRejection` 全挂
- 日志路径：`/tmp/dsh-helper-patch-restart-<ISO 时间戳>.{out,err}.log`

## 数据流（重启一次）

```
用户点按钮
  └─ confirm('确定重启？')
       └─ POST /api/dsh-helper-patch/restart
            ├─ trustedRestartRequest ✓
            ├─ detectedDebugger === null ✓
            ├─ detectedSupervisor === null ✓
            ├─ scheduleRestart(port)
            │   ├─ respawnInvocation(launch)   ← Windows 包 powershell Hidden
            │   ├─ spawn('node', ['-e', restartHelperSource(...)], detached, unref)
            │   ├─ setTimeout(kill(SIGTERM), 500ms)
            │   └─ return { pid, helperPid, logOut, logErr }
            ├─ 202 { pid, helperPid, logOut, logErr }
            └─ 500ms 后本进程被 SIGTERM
helper（detached，独立进程）
  ├─ 等端口 free（net.connect 探测，30s 上限）
  ├─ sleep(300) 让 TIME_WAIT 收敛
  ├─ spawn(替代进程, { detached, unref, windowsHide })
  ├─ 持续监听 8s 端口无中断 = 接班成功
  └─ 若超时：写日志后退出（不再 handOff 给 recovery）
```

## 边界与不做的事

- **不**做 SSR 恢复面板——失败时浏览器刷新即回到正常状态。
- **不**解析 DSH 启动日志、不写 `cordis.patch.yml` 的 disabled 行、不写 `dsh.profile.bundles`。
- **不**做 cancel 机制——一旦 helper spawn 出去，浏览器只能等。
- **不**暴露 `dsh-market/api/v1/restart` 等向后兼容端点——只暴露 `/api/dsh-helper-patch/restart` 一条。

## 测试与验证

1. **静态编译**：`node --check lib/index.js src/host/dsh-cli.js src/host/http-trust.js src/host/restart.js`（模块系统是 ESM）。
2. **客户端 bundle**：`node tools/build-client.mjs` 生成 `lib/client.js`，比对改动前后字节增量 < 2KB。
3. **路由可访问**：宿主演示环境下 `curl -sS http://127.0.0.1:3080/api/dsh-helper-patch/restart/status` 应返回 JSON。
4. **点击后**：按钮变「正在重启…」 → 1-2 秒后页面请求被新进程接管 → 「重启完成」提示出现。
5. **安全闸**：用 `INVOCATION_ID=test node ./bin.js` 启动宿主 → status 应返回 `allowed: false, reason: "supervisor"`；按钮置灰且 `title` 提示「宿主在 systemd 下运行…」。
6. **关闭开关**：编辑 `config.json` 加 `"restartEnabled": false"` → 重启宿主（手动重启一次以加载配置）→ status 应返回 `allowed: false, reason: "disabled-in-config"`。
7. **回滚**：本次改动只新增 `src/host/*.js`、改 `lib/index.js`、`src/client/index.jsx`、`package.json`，删 `lib/client.js` 与 `src/client/index.jsx` + `node tools/build-client.mjs` 即可完整回到 v0.3.0。