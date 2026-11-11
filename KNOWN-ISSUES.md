# 已知缺陷（已修，留档）

2026-09-25 排查确认，**两条 P1 均已于同日修复**（commit `5c8071b`）——本文保留原始排查记录
（证据、复现命令、影响边界），修复情况见文末「修复记录」。

> ⚠️ **本文档刻意不进 npm 包**（不在 `package.json` 的 `files` 白名单里）。
> 缺陷 2 涉及安全加固细节，已修完但保留仓库留档性质——要挪进 `docs/` 随包分发前请再权衡一次。

> ⚠️ **文中的行号是 2026-09-25 排查当时的快照，此后已经漂移**（修复本身、以及 0.10.0–0.12.0
> 那几批改动都动过 `lib/schedule-remote.js` 与 `lib/index.js`）。这是留档，不逐次追行号 ——
> 要定位请按**符号名**找（`businessError`、`trustedLocalRequest`、`handleSendRequest`），
> 或跑 `npm run host-smoke`：那两条缺陷现在各有专门的回归断言盯着（`businessError` 转
> `RemoteError` 带领域码、`trustedLocalRequest` 的七种来源组合）。

| # | 缺陷 | 类型 | 状态 |
| --- | --- | --- | --- |
| 1 | `businessError` 方法迁移时丢失 | 功能 bug（错误路径全废） | ✅ 已修（`5c8071b`） |
| 2 | `/config` 与 `/send-file` 无来源校验 | 安全加固 | ✅ 已修（`5c8071b`） |

---

## 1. `businessError` 方法在迁移中丢失

### 现象

定时任务的**一切业务错误**（cron 非法、任务不存在、超过 200 条上限、工作区不可恢复……）在走到 `catch` 时
抛的不是中文提示，而是 `TypeError: this.businessError is not a function`；领域码 `helperPatch/schedule-*`
全部丢失，被网关折成 `gateway/internal`。

### 证据

- **静态**：`lib/schedule-remote.js` 的 7 个访问器都调用 `this.businessError(error, "<码>")`
  （182 / 193 / 204 / 215 / 226 / 238 / 247 行），但 `HelperPatchScheduleRemote` 类里只定义了
  `hostUnavailable` 与 `schedule`，**没有 `businessError`**。
- **原型链**：`HelperPatchScheduleRemote → TypertRemoteService → Service → Object` 四层**全无**该方法：

  ```bash
  node --input-type=module -e "
  const Cls = (await import('./lib/schedule-remote.js')).default;
  console.log(typeof Cls.prototype.businessError);  // → undefined
  "
  ```

  并且整个 `@deepseek-ai/*` 依赖树（含宿主）里 grep 不到 `businessError`——它只存在于
  `dsh-expert/lib/remote.js:313`（迁移源）的类里。
- **动态**（mock 一个最小 ctx，走真实错误分支）：

  ```
  getSchedule() 错误路径 →  TypeError: this.businessError is not a function   (code: 无)
  对照 schedule() 访问器 →  RemoteError | helperPatch/schedule-unavailable   ← 正常
  ```

  同一个类里，显式 `new RemoteError(...)` 的路径正常，依赖 `businessError` 的 7 条路径全炸。

### 影响

- 面板的 `errorText()` 是 `cause instanceof Error ? cause.message : String(cause)`——**直接取 message、
  不按 code 分支**，所以丢码的直接后果就是把 JS 报错原文端给用户，而不是「cron 表达式无法解析：xxx」。
- **正常路径全通**，所以 101 项冒烟（客户端 35 + host 62 + 渲染 4）全绿也盖不住它：
  `tools/` 里 grep 不到 `businessError`，`getSchedule` 只出现在注释里，host 冒烟关于 remote 的三条
  都是加载/结构断言（模块能加载、apply 会挂上、方法集合一致），**没有一条走错误路径**。

### 修复方案（照抄 T专家 的实现，改码前缀）

把 `dsh-expert/lib/remote.js:313` 的方法体搬进 `HelperPatchScheduleRemote`
（`DOMAIN_CODE_PATTERN` 在本文件顶部已经定义好了）：

```js
businessError(error, fallbackCode) {
  if (error instanceof RemoteError) return error;
  const message = error instanceof Error ? error.message : String(error);
  const candidate = typeof error === "object" && error !== null && typeof error.code === "string" ? error.code : undefined;
  return new RemoteError(DOMAIN_CODE_PATTERN.test(candidate ?? "") ? candidate : fallbackCode, message, {});
}
```

**同时必须补测试**（这才是这次漏网的原因）：mock ctx 调 `getSchedule()`，断言拿到的是 `RemoteError`
且 `code` 是 `helperPatch/schedule-*` 而非 `TypeError`。

---

## 2. `/config` 与 `/send-file` 没有来源校验

### 现象

`/restart` 有四道闸，另外两个**写入口零防护**：`handleConfigRequest`（`lib/index.js:237`）只看 method，
`handleSendRequest`（`lib/index.js:282`）只查 `enabled`。

### 实测（全部探针零副作用：`/config` 用空 payload、`/send-file` 用不存在的路径）

| 请求 | 伪造头 | 结果 |
| --- | --- | --- |
| POST `/restart` | `Origin: https://evil.example` | **403** ← 四道闸生效 |
| POST `/config` | `Origin: https://evil.example` + `Content-Type: text/plain` + `{}` | **400「没有可保存的字段」** ← 已进业务逻辑 |
| POST `/send-file` | `Origin: https://evil.example` + 不存在路径 | **500「文件不存在：…」** ← 已进业务逻辑 |
| POST `/config` | `Origin` 与 `Host` 都写 `evil.example` | **400** ← DNS rebinding 同样不拦 |
| GET `/restart/status` | `Origin: https://evil.example` | 200（只读，低危） |

复现命令（空 payload 不会写盘）：

```bash
curl -s -X POST http://127.0.0.1:3080/api/dsh-helper/config \
  -H 'Origin: https://evil.example' -H 'Content-Type: text/plain' -d '{}'
```

**宿主层没有兜底**：`dsh-host-webserver` 整个文件里 `origin` / `cors` / `csrf` / `referer` 一个都没有，
exact 路由命中就直接调 handler。所以上面的差异确实来自插件代码。

### 影响与边界

- **写操作是真实可利用的**：`text/plain` 是浏览器的「简单请求」，不触发 CORS 预检，跨站页面可以直接 POST。
  危害是 `/config` 可被改写 `toUserId`（把默认收件人改成别人的微信号 → 定向投毒）、`enabled`、`restartEnabled`；
  `/send-file` 是「**任意文件读取 + 外发到指定微信用户**」的原语。
- **`/send-file` 的口子比想象的大**：`resolveFilePath`（`lib/index.js:488`）对绝对路径**原样放行**，
  而 `payload.workspace` 又能任意指定、它正是相对路径的解析基准——所以相对路径同样等于任意路径。
  读取用 `readFile`（`lib/index.js:602`）**全量进内存、无大小上限**，超大文件可把宿主 OOM。
- **GET 读不到内容**：`GET /config` 虽受理并返回配置，但响应不带 CORS 头，浏览器同源策略会挡住脚本读响应体，
  所以"信息泄露"这条实际不成立，**真正可利用的是写操作**（POST 不需要读响应）。
- **浏览器侧仍有变量**：https 页面 fetch `http://127.0.0.1` 不算 mixed content（loopback 被视为
  potentially trustworthy），但 Chrome 的 Private Network Access 对"公网页 → 本地"另有约束，各浏览器不一。
  结论不变——**服务端不该把安全建立在浏览器的策略上**，DNS rebinding 那条连 Host 校验都绕不过。
- **仅本机可达**：服务只监听 `127.0.0.1:3080`（已用 `lsof` 确认），局域网内不可达，攻击面限于
  "用户本机浏览的网页"。

### 修复方案

直接套 `trustedRestartRequest` 有副作用：它**要求 Origin 必须存在**，而 `curl` 脚本调用不带 Origin，
会让 README 里写的 HTTP 投递用法失效。建议四道里改一道：

```
① remoteAddress 必须环回      ② 任何转发头都不能有
③ Host 必须是环回权威         ④ 带 Origin 时 → 必须与 Host 同源（不带则视为本机脚本，放行）
```

- 浏览器 CSRF（必带 Origin）→ 拒 ✓
- DNS rebinding（Host 是攻击者域名）→ 拒 ✓
- 本机 `curl`（无 Origin、Host 是 127.0.0.1）→ 放行 ✓

另加一条：读文件前 `stat` 做**大小上限**（微信本身也有文件体积上限，按它设即可），超限直接拒。
可选加固：`/restart/status` 也套 ③。

### 验证方法

修完后重跑上面那张表：`/restart`、`/config`、`/send-file` 带恶意 Origin 应当**一致地**返回 403，
而无 Origin 的本机 `curl` 仍能正常投递。

---

## 修复记录（2026-09-25，commit `5c8071b`）

两条都按本文「修复方案」落地，另加两处：

1. **缺陷 1**：`businessError` 方法体补回 `HelperPatchScheduleRemote`（与 T专家 实现一致，
   顶部 `DOMAIN_CODE_PATTERN` 随之复活）；`tools/host-smoke.mjs` 新增「定时任务业务错误路径」
   断言——mock ctx 打 4 条错误路径（裸 Error 回落兜底码 / 系统 errno 不透传 / 访问器码 / 域码透传），
   正是本次漏网的盲区。
2. **缺陷 2**：`src/host/http-trust.js` 新增 `trustedLocalRequest`（本文四道里改④：无 Origin 视为
   本机脚本放行），`/config`、`/send-file`、`/restart/status` 三条路由统一过闸（重启路由仍用更严的
   `trustedRestartRequest`）；投递读取前先 `stat`，上限 **200 MiB**（微信侧实际限制更小，最终以
   上游 413 回执为准）。
3. **顺手接线（P2）**：定时任务总开关 `scheduleEnabled` 此前引擎有 `setArmed` 但无入口，本次一并
   接进 config.json + 设置卡片 + 面板提示。
4. 冒烟 62 → 71 项，`npm run verify` 全绿。

**活体验证**（需重启 DSH 加载新代码后跑，宿主进程里的还是旧代码）：

```bash
# 三条带恶意 Origin 的请求应当一致地 403：
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:3080/api/dsh-helper/config \
  -H 'Origin: https://evil.example' -H 'Content-Type: text/plain' -d '{}'
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:3080/api/dsh-helper/send-file \
  -H 'Origin: https://evil.example' -H 'Content-Type: text/plain' -d '{"path":"/tmp/nope.png"}'
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3080/api/dsh-helper/restart/status \
  -H 'Origin: https://evil.example'
# 本机脚本（无 Origin）照常可用：
curl -s -X POST http://127.0.0.1:3080/api/dsh-helper/config -H 'Content-Type: application/json' -d '{}'
# → 400「没有可保存的字段」（过了闸、进了业务逻辑，即为正确）
```
