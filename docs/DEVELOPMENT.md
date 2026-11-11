# 开发与实现笔记

面向改这个插件的人。用户向的安装与使用看 [README](../README.md)，发布流程看 [PUBLISHING](./PUBLISHING.md)。

## 目录结构

```
tools/preview-settings.mjs   把设置卡片渲染成静态 HTML（改版面时先看图，不必重启宿主）
src/host/           host 侧子模块（进 npm 包，exports 暴露）
  dsh-cli.js          找 node 可执行文件、拼 dsh 启动参数
  http-trust.js       环回 + Host 权威校验（重启路由的第一道闸）
  restart.js          脱离父进程的 helper 重启 + 调试器/监督器探测
src/client/         浏览器侧源码（不进 npm 包，只进仓库）
  index.jsx           槽位注册、设置卡片（六张卡片的分组都在这里）、重启按钮、host 配置读写
  ui.jsx              设置卡片的卡片容器 / 开关行 / 选项组（官方 primitives 优先，缺了退回自绘）
  prefs.js            浏览器偏好的极简外部 store（localStorage）
  sidebar-glow.jsx    活动呼吸灯（原 dsh-sidebar-glow）
  attention.jsx       活跃指示：标题栏那枚心电图 + 会话清单（2026-09-28 从 dsh-expert 迁来）
  attention-css.js    活跃指示的样式表（注入 <style>）
  session-nav.js      会话跳转（定时任务「关联会话」与活跃指示共用；原 schedule-jobs.js）
  appearance.jsx      界面外观：盖掉 macOS 桌面端的原生窗口毛玻璃（纯 CSS 覆盖）
  sound.jsx           对话完成提示音：观察组件 + 合成音 + 设置组
  sound-core.js       提示音纯逻辑（边沿/去抖/音色数据），无 JSX，可被 Node 单测
  schedule.jsx        定时任务面板（列表 + 表单 + CronPicker）
  schedule-cron.js    cron 五/六段的解析与拼装（纯函数）
  schedule-css.js     面板样式表（注入 <style>）
  schedule-remote.js  客户端侧 remote 描述符与挂载
lib/                 host 侧运行代码 + 构建产物（全部入库，进 npm 包）
  index.js            插件入口：路由、工具、槽位装配、配置读写
  schedule.js         定时任务引擎（croner 调度 + JSON 持久化）
  schedule-remote.js  host 侧 Typert remote 服务（wire 名 helperPatch，7 个方法）
  schedule-schemas.js 线格式 schema 的单一源（host 与客户端共用）
  client.js           ← npm run build 的产物，入库
tools/               构建与自检脚本（不进 npm 包）
docs/                图片与文档
```

`lib/` 入库是刻意的：从 git tag 重建时必须能直接跑，不必先装 devDependencies 再构建。

## 构建

```bash
npm run build     # tools/build-client.mjs → lib/client.js（esbuild）
```

- **改 `src/client/**` 之后必须重新构建**，否则改的是源码、跑的是旧产物。
- **改 `lib/index.js`、`lib/schedule.js` 等 host 侧文件不需要构建**——它们是纯 JS，直接生效。
- 构建后工作树应当干净（发布预检把「构建改动了已提交文件」当作硬闸）。

## 自检

| 命令 | 覆盖 | 规模 |
| --- | --- | --- |
| `npm run typecheck` | `tsc -p tsconfig.json`：只检查标了 `// @ts-check` 的自研 Host 文件（`lib/schedule*.js`），不碰构建产物 | 见下 |
| `npm run smoke` | 模拟 `__ModuleLoader__` + 假 React/DOM 跑客户端逻辑：打标、未读判定、cron 模型往返、样式表结构、布局度量、remote 方法集合、提示音、界面外观覆盖规则、设置卡片分组与投递加固两项的呈现、apply 分阶段降级 | 81 项 |
| `npm run host-smoke` | host 侧纯函数与真实引擎：图片嗅探、投递方式、错误翻译、投递加固（口令 / 目录白名单）、重启安全闸、平台适配 spawn、文案表、来源闸，以及用真实调度引擎跑的定时任务用例（执行窗口并发变更、迁移诊断自动合并 / 仍搁浅、合并幂等性 = 删任务后提示消失 / migration 字段穿过 persist、损坏文件留存、改名迁移与幂等） | 118 项 |
| `npm run render-smoke` | 客户端组件真实渲染断言（配置卡片、定时任务面板、界面外观组、标题栏刷新按钮） | 10 项 |
| `npm run preview` | 把呼吸灯样式抽成预览页，调动画参数用 | — |
| `npm run verify` | `typecheck` + `build` + 上面三个冒烟 | — |

上表三个数字**由自检自己核对**：三套冒烟各自在收尾处读这份文档、比对自己的实际项数，
所以"改了测试忘了改文档"会直接红（退出码 1）。这三个数字曾经长期写着 58/72/6，
而实际早就是 77/103/9 —— 没有任何机制发现它，直到 2026-09-28 那次审计逐条数了一遍。
核对放在输出段而不是包成一条 `check()`：`check` 的计数本身正是被核对的对象，
用它去核对它会陷入"自己算不算一项"的绕圈子。

关于 `typecheck`：`tsconfig.json` 的 `include` 必须列出每一个标了 `// @ts-check` 的文件，
否则那个标记是**死的**（tsc 根本不读它）。`host-smoke` 里有一条断言递归扫 `lib/` 与 `src/`
双向核对这件事（T专家 那份同类自检用的是非递归 `readdirSync`，于是 `lib/skill-gate/` 整个
子目录都不在它视野内 —— 同一个坑这里不再踩）。补上 typecheck 之后第一次跑就抓出两个真问题：
`createScheduleEngine` 漏写 `migrationNotice` 的 `@param`；`businessError` 的 `fallbackCode`
缺类型标注，导致整个三元表达式退化成 `any`、那道「上游类型缺口」的 `@ts-expect-error`
从来没生效过（tsc 报它 unused）。

同一套门禁也在 CI 上跑（`.github/workflows/ci.yml`，0.12.0 起 —— 此前这个仓库连 `.github/`
都没有，自检全靠维护者手跑），CI 另加两条本地容易忘的：

- **客户端产物可复现**：`npm run build` 之后 `git diff --exit-code -- lib/client.js`。
  改了 `src/client/` 却忘记构建时，仓库里那份产物会悄悄落后于源码，而装到宿主上跑的正是产物
  —— 表现是"改了没生效"且没有任何报错。
- **发布包形态**：`npm pack --dry-run`，确认 `files` 白名单没漏东西、也没多带东西。

CI 的步骤名称里刻意**不写断言条数**：那会变成又一处"改了测试就得记得同步"的地方
（T专家 那边就为此专门写了一条自检去对齐 README 与 ci.yml 里的数字）。要防文档腐烂，
就用上面那种"自检自己读文档核对"的办法 —— 它比对两处手写的数字更不容易失效。

验证优先级（踩坑后定的）：

1. **样式表结构**要有静默断言（「CSS 孤儿注释体吃掉规则」那次就是没断言兜住，整页布局错到用户先发现）。
2. **布局度量**要对齐官方那一页（内容列 / 滚动层 / 详情栏逐字比对）。
3. **remote 方法集合**要 host 与客户端两侧一致（少一个就是运行期「调不到」，且只在浏览器 console 报错）。
4. 能写进冒烟的就别留给手工点。

## 客户端槽位与注入约定

`package.json` 的 `dsh.client.inject` 必须包含：

```
@deepseek-ai/dsh-client-ui-layout      ← shell.overlay 槽位所在，缺了呼吸灯观察组件起不来
@deepseek-ai/dsh-client-ui-settings    ← settings.action（重启按钮）
@deepseek-ai/dsh-client-ui-slots       ← slots 服务本体
@deepseek-ai/dsh-api-remotes           ← remote 挂载
@deepseek-ai/dsh-client-connection
```

`src/client/index.jsx` 的静态 `inject` 必须是 `["slots", "remote", "typert"]`：

- `remote` 不写进 inject，`ctx.get("remote.helperPatch")` 恒为 `undefined`；
- `typert` 是 `ctx.remote.$mount(...)` 内部要用的注册表，**缺它时异常只出现在浏览器 console**，界面仅显示
  「定时任务服务暂时不可用」——2026-09-25 实测确认，别再删。

本插件用到的槽位：

| 槽位 | 用途 |
| --- | --- |
| `plugins.bundle.config` | 设置卡片。`key` **必须**填包名 `dsh-helper`——宿主拿这个键判断 bundle 有没有可展示的配置，对不上卡片就不出现 |
| `sidebar.panellist` | 侧栏「定时任务」入口 |
| `main` | 定时任务面板内容区，key = `helper-patch-schedule` |
| `settings.action` | 设置页头部的「重启 DeepSeek Harness」按钮 |
| `shell.overlay` | 呼吸灯观察组件（只读状态快照，不渲染可见内容） |

设置卡片挂在**插件信息页**（描述与「包含的组件」之间），不另建「设置」分区——DSH 官方要求插件设置落在自己的信息页。

## 排版与 CSS 约定

- **卡片字号一律写死 px**（分组标题与开关标题 13.5px、说明 12px、按钮 12px），跟随插件详情页正文。别改回
  `em` 继承：宿主根字号 16px，继承得到的字会明显比同页「包含的组件」大一圈。
- **DSH 客户端 UI 没有全局 `box-sizing` reset**（默认 content-box）。所以官方 `.pageContent` 的
  `max-width: 960px` 限的是**内容盒**——自己加 `border-box` + `width: 100%` 会窄 96px；官方 `.row` 的
  `width: 100%` + `padding: 8px` 会右出血 16px，落在内容列 padding 里不出横向滚动条。照抄官方写法，别「顺手修掉」。
- 定位细节差异的有效办法：把**官方 DOM + 官方 CSS** 与**本插件 primitives** 并排渲染，逐元素比 computed style。
- 样式表里别留半截注释体（`/* ... */` 少个闭合）——它会吃掉紧随其后的规则，而 CSS 不报错。

## 设置卡片

- **分组靠卡片，不靠分隔线**：一个用途一张卡片，标题在卡内。此前是一个灰标题 + 一条 0.5px 分割线，
  在浅色主题下几乎看不见，用户看那行长列表时找不到边界（2026-09-28 报「有点乱」）。
- **控件用官方 primitives**：`Switch` / `Button` 从 `@deepseek-ai/dsh-client-ui-primitives` 取
  （产物里是外部 require，已写进 `package.json` 的 `dsh.client.inject`）。取不到时逐个退回自绘实现 ——
  客户端 entry 一抛错，整个 Web GUI 会停在 "Failed to load plugins"，一张设置卡片不值得有这种后果。
- **选项组不用官方 `SegmentedControl`**：它 `inline-grid` + `white-space: nowrap`、每段 `padding: 0 16px`，
  8 个音色横向必然溢出卡片。`ui.jsx` 里的 `ChoiceGroup` 照它的观感自绘（底槽 + 选中项浮起，token 同源），
  但允许折行。哪天官方那个组件支持换行，这里可以换回去。
- **改版面先看图**：`npm run preview-settings` 会把六张卡片渲染成一张 HTML（渲染的是
  `src/client/index.jsx` 里真实的 `SettingsCards`，官方 primitives 用替身顶替），
  再用 headless Chrome 截一张图即可。CSS 变量取的是宿主主题的真实值，宿主改 token 时要回来核对。
- 冒烟里的假 React 是**有状态**的（`tools/client-smoke.mjs` 的 hookStates）：设置卡片要先读 host 配置，
  断言得"渲染 → 让 Promise 落地 → 再渲染"才能看到就绪那一版。改动它时注意 hook 顺序约定与
  `renderTree` 的嵌套数组摊平 —— 少一样，卡片里的行就会整块消失而断言看不出原因。

## 活动呼吸灯

- 只动工作区行的**文件夹图标**，不碰行背景、不做缩放。
- 光晕一律用 `drop-shadow` **贴图标轮廓**，不要退回圆形伪元素：文件夹在展开/折叠是**两种形状**，写死轮廓必错一种。
- 「彩色流转」的**边缘光**是两层 `drop-shadow`，去掉会让图标在深色主题下发闷。
- 判定走状态快照（`useSessionStatus` / `useWorkspaces`），不爬 DOM；标记用官方行自带的 `data-row-key` 与
  `aria-expanded`（语义属性，非 CSS Modules 哈希类名）。
- 折叠与否**不写进标记**：`aria-expanded` 随折叠在 DOM 上自己变，CSS 跟着重算。
- 偏好存 `localStorage`，键名沿用并入前的 `dsh-sidebar-glow:*`——改键名等于把现有选择重置回默认。
- 未读 = 会话行绿点（`SessionStatus.completionUnread`），折叠时绿点看不见就染橙色顶上，橙色优先于活动呼吸。

## 活跃指示

会话标题栏（`conversation.session.header.utilities`）那枚心电图，逻辑与在 T专家 里逐行一致，只有三处搬家改动（类名前缀、文案来源、偏好存储）。几条不能改的约束：

- **快照引用必须稳定**：`useSyncExternalStore` 每次渲染都调 getSnapshot，每次 new 一个数组会让 React 认为快照一直在变，
  直接重渲染死循环 —— 所以按 key 缓存那份清单（`attentionCache`）。
- **「在跑的子代理」要自己聚合**：宿主投影里没有「在跑的子代理数」这个字段（`byId` 只有 id/displayTitle/running/
  completed/blank/updatedAt/title/cwd/parentId/origin），侧栏那枚状态点是 UI 层按 `parentId` 上溯算出来的，这里照同一口径算一份。
- **`sessions` 用 `ctx.get("sessions")` 惰查**，不写进客户端 cordis inject：注入的服务在某个宿主版本上不存在时，
  客户端 entry 会变成 FAILED，宿主的启动审计会让**整个 Web GUI** 停在 "Failed to load plugins"。
- **槽位是 list，注册一次就够**：偏好关掉时组件自己 `return null`，不要去注销注册（那是宿主画的行才需要的做法，
  见侧栏定时任务入口）。样式仍由 `installAttention` 注入第 4 份 `<style>`，client-smoke 按下标断言，插到中间会张冠李戴。
- 展开侧栏工作区分组走 `ctx.slots.hostFace().storeOf(entry)` 取侧栏正在用的 store 实例（插件没有公开写入口），
  认槽认的是 store 声明本身（`spec.actions.setGroupExpanded`），不认注册顺序。

## 完成提示音

读的是**同一份**会话状态快照，不需要 host 侧钩子。三条约束都来自宿主源码，改动前先看一遍：

- **不能用 `completionUnread` 当触发信号。** `UiSession.observeRunning()` 只在 `!isMain(sessionId)` 时置位
  ——那是给「主视图之外」画绿点用的，主视图里的会话跑完**永远**不进未读。
- **`running` 在 turn 之间会抖动，必须去抖。** `AgentLoop.kick()` 收尾时若
  `wakeRequested && inbox.hasPending` 会立刻重新 `wakeDriver()`；`goal-round-driver` 在 idle 上直接续下一轮。
  所以「停下来」要等 300ms 再确认。
- **只认顶层会话**：`row.parentSessionId === undefined`。子代理与 Agent Teams 队友都有 `parentSessionId`，一条判据全排除。

工程约定：

- 纯逻辑放 `sound-core.js`（无 JSX），组件放 `sound.jsx`——前者能被 `client-smoke.mjs` 直接 import 逐条断言。
- 跨渲染状态（上一帧 running 集合、待确认批次）放**模块级**，不用 `useRef`：冒烟里的假 React 每次渲染都新建 ref。
- 定时器与时钟一律可注入（`createDetector({ schedule, cancel })`），测试推假时钟而非真等去抖窗口。
- 音色写成**数据**（`TONES[].notes`），这样「三连音有三个音」这类性质可直接断言，不必 mock Web Audio。
- **IndexedDB 与 `decodeAudioData` 冒烟验不了**（假环境没有库和解码器），只能进真实浏览器：esbuild 把
  `sound.jsx` 打成 IIFE 页面跑「清除 → 读空库 → 选文件 → 落库 → 模拟刷新 → 播放 → 移除 → 超限拦截」，
  结果 POST 回本地 HTTP 服务收口。**别用 `--dump-dom`**（`--timeout` 在 `headless=new` 下不生效）。
  为此 `sound.jsx` 导出了 `customSound` / `loadCustomSound` / `importCustomSound` / `clearCustomSound`
  四个内部符号（宿主只调 `apply`，多导出无副作用）。

## IM 只读复用

投递能力全靠**只读复用**所装 IM 插件的实现，本插件自己不含协议。两个后端并存，`deliverFile()` 先
`resolveDeliveryBackend()` 选一个（`auto`：装了 im-connect 就用它，否则退回 dsh-im），再走各自的投递。

### 后端 A：`@michengai/dsh-im-connect`（默认）

```
import <pkg>/lib/channels/weixin.js        ← createWeixinChannel() 工厂：通道自带 sendFile()
import <pkg>/lib/engine/credentials.js     ← credentialRef() 拼凭据名
ctx.credentials.resolve('im_connect_<账号id>_botToken')   ← DSH 公共凭据服务
```

- **自己造一个「只发不收」的通道实例**：`createWeixinChannel({ stateDir: 账号目录, botToken }, log, 账号目录)`
  之后只调 `sendFile(chatId, { name, data }, signal)`。**绝不调 `start()`** —— 那会起第二个长轮询，
  和宿主里真正在跑的 `ChannelManager` 抢同一个微信账号。出站路径只需要 botToken 与
  `wechat-state.json` 里的 `contextTokens`，构造时就已读好，与轮询无关。
- 账号：`$DSH_HOME/dsh-im-connect/channels.json` 里 `platform === 'weixin' && enabled !== false`。
  账号目录规则复刻自上游 `ChannelManager.accountStateDir`：`accountId === platform` 时用
  `stateDir/<platform>`，否则 `stateDir/accounts/<accountId>`（传错了它就读不到 context_token）。
- 收件人：配置的 `toUserId` → 账号 `config.allowedUserId` → `wechat-state.json` 的 `allowedUserId`。
- 图片/视频/文件由上游按**文件名后缀**分流，我们只按同样的口径回填 `via`；`imageAsPicture` 开关在这条路上不生效。
  发送前有一道**纠偏**（`src/host/image-sniff.js` 的 `correctOutgoingImageName`，两个后端共用同一份
  魔数嗅探）：真图片叫错名字 → 纠正后缀按图片发；文本改名 `.jpg` → 换 `.bin` 按文件发。只动发送名
  （上游拿它既分流又当显示名，两者绑死），磁盘原文件不动；名字与内容同属图片类（如 `.jpeg`）不纠，
  视频不纠偏（格式头复杂、场景少）。
- 上游有对外服务面吗？**没有**：不注册 agent 工具、不 `provide`、HTTP API 只有渠道/账号管理；
  它的文件回传只发生在它接管的 IM 会话回合结束时。所以这里只能走内部模块，和当年复用 dsh-im 是同一性质。

### 后端 B：`@xmanrui/dsh-im`（旧）

```
ctx.credentials.resolve(account.tokenRef)            ← DSH 公共凭据服务
import dsh-im/src/channels/weixin/weixin-api.mjs     ← 上传 + AES 加密 + 发送
import dsh-im/src/channels/weixin/state-store.mjs    ← 读 contextToken
import dsh-im/src/channels/weixin/config-store.mjs   ← 读账号配置
```

读 `contextToken` 只用只读的 `contextTokenFor(userId)`，**绝不调 `bindContextTokens()`**——后者在凭据哈希
不匹配时会清空 users 表，把已有上下文弄丢。

### 两个后端的共同约定

候选顺序（`imConnectCandidates()` / `resolveDshImDir()`）：**显式配置 → 当前 profile → 其它 profile**
（web / desktop 在前）。「当前 profile」从宿主 argv 里的 profile 路径认出来（`currentProfileDir()`）；
本 profile 优先是为了不让宿主拿另一个 profile 装的副本（版本可能与运行时不一致）。

全部只读 import，不写上游一个字节。为什么不 patch 上游、也不复刻协议：

| 场景 | patch 源码 | 本插件 |
| --- | --- | --- |
| 上游升级 | 手动合并 diff | 零影响 |
| `git pull` 上游 | 冲突 | 干净 |
| 上游修了协议 bug | 要重新 patch | 自动受益 |

dsh-im 的 `weixin-api.mjs` 有 948 行、`weixin-bridge.mjs` 有 1544 行；im-connect 的 `weixin.js` 949 行。
复刻一份等于给自己埋一个会跟着上游腐烂、且烂得静默的副本。**唯一残留的耦合**是那些模块的路径与导出名，
变了由 `loadWeixinModules()` / `loadImConnectModules()` 抛明确错误（不是静默失效）。

## 定时任务（host 侧）

- 与 `@weibaohui/dsh-tasks` **零共享**：数据落 `$DSH_HOME/integrations/dsh-helper/schedule.json`，
  服务名 `helperPatchSchedule`、错误码前缀 `helperPatch/schedule-*` 独立，两边任务互不可见。
- 持久化：单 JSON 文件 + **原子写**（临时文件 + `rename`），写盘走串行链。
- 调度：每个启用项一个 croner job，宿主启动 `load()` 之后**立刻** `rescheduleAll()`——少了这句，表现是
  「任务在、但永远不触发」（自检有对应断言）。
- `new Cron(expr, { unref: true }, cb)`：`unref` 是 **croner 的构造选项**，不是 job 方法（写成
  `job.unref()` 会静默无效）。不 unref 会把宿主事件循环钉住。
- 执行：新建 agent 会话 → **挂部署默认 preset**（不挂 preset 的新会话没有任何工具）→
  `workspace.attachSession` → 钉标题「事项标题 · MM-DD HH:mm」→ 提交提示词。
- 提示词用 `source.kind: "user"` **原样提交**（DSH 聊天把非 user 源收成左侧 inject/context），也**不做模板改写**
  ——同一份提示词在手动会话是 `@专家名`，被改写成模板会让两条入口观感不一致。
- 同一事项不并发：`running` 集合里有它就跳过本轮。
- 工作区：默认建标题固定「定时任务」的工作区（按标题复用），也可绑自定义目录；目录不见时按
  `workspacePath` 自动 `mkdir` 重建。
- 上限：事项 200 条、单事项记录 20 条、标题 200 字符、提示词 20000 字符。
- **总开关**：config.json 的 `scheduleEnabled` 持久化偏好；`/config` 路由在它变更时立即调
  `engine.setArmed(next)`（**不经 remote 方法**，`setArmed` 未暴露成 remote，`lib/schedule-remote.js` 只有
  7 个方法）。`setArmed(false)` 只改运行态（停全部触发 + 拒手动执行，任务与记录保留），**不写数据文件**。
- 数据迁移闸门 `SCHEDULE_MIGRATION_ENABLED`：一次性把 T专家 的 `~/.t-team/schedule.json` 复制过来
  （**只复制不删除**，目标已存在就跳过）。闸门必须在「T专家 那边还在调度」时保持 `false`，否则同一条任务被两边各触发一次。
- 线格式 schema 的**单一源**是 `lib/schedule-schemas.js`，host 是生产方与校验方。领域错误码形态
  `<domain>/<reason>`（如 `helperPatch/schedule-invalid`）才允许当 wire code 透传——系统 errno（`EACCES`…）
  不是领域码，透传会让客户端把「文件权限」误认成业务失败。

## 已知的宿主差异

- 宿主 `reflect` 缺失时（老版本），定时任务降级返回 `helperPatch/schedule-unavailable`，面板显示「服务暂时不可用」。
- `ctx.inject([...])` 是拿到可选服务的唯一方式：cordis 里直接读 `ctx.tools` 是 `undefined`，工具就**静默**注册失败。
- remote 服务用 `ctx.plugin(HelperPatchScheduleRemote)` **自注册**，不靠包内 `cordis.patch.yml`：
  安装时生成的 `~/.dsh/profiles/web/cordis.patch.yml` 才是宿主真正读的那份，只改包内那份而不重装，宿主不会加载服务。

## 已知缺陷（未修）

两条已确认的 P1（一个错误路径 bug、一个安全加固项）记在**仓库根**的 `KNOWN-ISSUES.md`，含完整证据、
复现命令与修复方案。它刻意不在 `files` 白名单里、不随 npm 包分发（安全项修完前不宜公开披露）。
**动 `lib/schedule-remote.js` 或那两条 HTTP 路由之前先看它。**
