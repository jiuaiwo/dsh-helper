# 更新日志

本项目遵循[语义化版本](https://semver.org/lang/zh-CN/)与 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

> **关于版本号**：`0.4.0` 及更早的版本只存在于本地 git 历史，从未发布到 npm。
> 首个 npm 发布版本是 **0.5.0**。早期版本曾用包名 `dsh-imsend`，`0.3.0` 起更名为 `dsh-helper-patch`。
> 规矩（2026-09-28 起）：**每次 git 提交都升一级版本号** —— 改 `package.json` 的 `version`
> （`package-lock.json` 根节点跟齐）与本文件顶部段落，两者连同提交一起走；发布只补 annotated tag，
> 不再用 `npm version` 升版。

## [0.16.1] — 未发布

**修交叉引用，以及一条真的会坏的路径** —— 两个仓库互相引用对方的包名/目录名，这次改名各改各的。

### 修复

- **`tools/preview.mjs`（真的会坏）**：硬编码了 `join(REPO, "../dsh-plugin-t-expert/node_modules/
  @deepseek-ai/dsh-client-ui-primitives/lib/index.js")` —— 本地目录改名后这条路径直接指向不存在的
  目录，预览工具一启动就炸。已改为 `../dsh-expert/`。
- 15 个文件里注释的迁移来源旧名（`lib/{index,schedule,schedule-schemas}.js`、
  `src/client/{attention,attention-css,schedule-cron,schedule-css,schedule-remote,session-nav}.js`
  等）改成当前名：留着旧名，后来的人会去找一个已经不存在的东西。
- `tsconfig.json`（与 T专家 保持同一套取值的说明）、`KNOWN-ISSUES.md`、`docs/DEVELOPMENT.md` 同步。
- `lib/client.js` 重新构建：esbuild 生成的 sourcemap 路径注释跟着更新。

## [0.16.0] — 未发布

**改名为 `dsh-helper`**（原 `dsh-helper-patch`），并**自动迁移老用户的运行时数据**。

### 变更

- **npm 包名**：`dsh-helper-patch` → `dsh-helper`；插件 id、设置卡片 key、槽位 id
  （`-pulse` / `-refresh` / `-glow` / `-sound`）一律跟随包名。
- **HTTP 路由**：`/api/dsh-helper-patch/*` → `/api/dsh-helper/*`；请求头
  `x-dsh-helper-patch-token` → `x-dsh-helper-token`。
  ⚠️ **用过 HTTP 端点或投递口令的脚本需要跟着改**（本版不做双路由兼容）。
- **浏览器偏好键**：`dsh-helper-patch:*` → `dsh-helper:*` —— 呼吸灯开关、提示音音色与音量
  会重置为默认值。
- **工具名不变**：`send_file_to_im` 照旧。

### 迁移：这次做了（上次没做）

运行时数据按包名落盘（`$DSH_HOME/integrations/<包名>/`），改名等于换门牌号。
`ensureDataDirMigrated()` 在 `apply()` 最开头执行：把 `integrations/dsh-helper-patch/` 整体搬到
`integrations/dsh-helper/`（配置与定时任务一起），**目标已存在就什么都不做**。搬运优先 `rename`
（同文件系统上是原子的），跨设备时退回复制 + 删源；失败只记一条 warn，不让插件起不来。

之所以强调「上次没做」，是有前车之鉴：上一个名字 `dsh-imsend` 的目录至今还留在用户机器上
（`~/.dsh/integrations/dsh-imsend/`），正是当年改名没写迁移的后果。

### 测试

`host-smoke` 112 → 114 项，新增两条：整体搬迁、以及「目标已存在不覆盖 / 两边都没有不凭空建目录」。

## [0.15.16] — 未发布

**README 的安装只讲用户怎么装** —— 去掉本机开发那套。

### 变更

- 「安装」不再教用户 `cd ~/.dsh/profiles/web` + `pnpm add` 与手改 `dsh.profile.bundles`
  （那是维护者在本机装插件的方式，且只对 web profile 成立），改为 **DSH Web / CLI**
  （`dsh plugin --profile web add …`）与 **DSH Desktop**（插件市场）两条路。
- 删掉「开发时用 `pnpm add link:/path/to/dsh-helper-patch` 从源码装」这句 —— 源码安装属于
  贡献者文档，README 只保留指向 [docs/DEVELOPMENT.md](./docs/DEVELOPMENT.md) 的链接。
- 「兼容性」表的 DSH 宿主一栏由枚举 `0.1.5-rc.1 / 0.1.6-alpha.2 / 0.1.7-rc.1` 改为与
  package.json 的 peerDependencies 一致的 `>=0.1.5-rc.1`。

## [0.15.15] — 未发布

**发布不再把开发历史推上 GitHub** —— 与 T专家 0.4.69 同一套做法。

背景（2026-10-06 实测）：远端 `main` 只有一条无父快照，而 `git push --follow-tags` 会把 tag
指向的提交连同**整条父链**推上去；分支推送虽被 non-fast-forward 拒绝、退出码非 0（脚本打印
「推送失败」），**tag 却已经推成功了** —— 从远端 clone 顺着它就能看到全部 44 条开发提交。

### 变更

- `ops/tz.sh`：3/6 末尾新增「发布快照」步骤（`git commit-tree` 造无父快照 + tag 重指 + 更新
  `refs/heads/github`），4/6 改为只推快照与 tag；`--no-push` 逃生口保留，跳过时打印补推命令。
- `ops/git-hooks/pre-push`（新增）：pre-push 保险闸，拒收带父链的 `main` 推送与 tag 推送，
  提示里报出沿父链回溯的提交条数。安装：`git config core.hooksPath ops/git-hooks`。
- `docs/PUBLISHING.md`：发布步骤改成「推快照」版，并**修掉原第 53 行未闭合的单引号**
  （`V="$(node -p 'require("./package.json").version")"` 在 bash 下直接语法报错，照抄必失败）；
  失败回滚表里「`git push` 失败」的处置同步更新。

## [0.15.14] — 未发布

**读盘改判那段的错误路径收口** —— 落盘/日志不该和"文件损坏"共用一条 catch。

### 修复

- 读盘时"旧默认目录改判"的告警与落盘从解析的 try 里**移出来**。原来它俩在同一个 try 里，
  而那个 catch 的语义是"JSON 解析失败 → 把文件改名成 `.corrupt-<时间戳>` 留存" —— 一旦
  persist / logger（与本函数无关的环节）同步抛错，就会把一个**好文件**误判成坏文件：
  用户看到的是"任务全没了"，还只能在一个陌生后缀里找回。两件事现在各走各的错误路径，
  落盘失败只记一条 warn（内存里的改判已经生效，下次启动再改一遍而已）。
- load 路径上的日志改走 `safeWarn`：load 跑在 **apply 期**，那里抛一个错 = 整个插件没挂上
  （用户看到"定时任务功能整体消失"，而报错来自一句本该无关紧要的 warn）。宿主的 logger
  实现各异，有的在日志管道断开时会抛。
- 修正一处自己写错的作用域：`revisedCount` 曾声明在 try 内、却在 try 外使用
  （块级作用域，外面根本看不见）。

### 自检

- host-smoke 112 项不变，新增两条门禁：**logger 一 warn 就抛**时仍要完成改判、且目录里
  不许出现 `.corrupt-*`；**反向验证**：把 `safeWarn` 的 try/catch 去掉 → 报红「logger 炸了」。
- typecheck / build / client-smoke（81）/ render-smoke / host-smoke（112）全绿。
- **真实宿主实测**（隔离开的 `DSH_HOME` + App 自带 runtime，不碰本机正在用的环境）：
  - 从模板初始化独立 profile，`dsh plugin add <repo>` 以 `link:` 装入本仓库源码；
  - `dsh <profile> "用 create_schedule_task 建一条任务…"`（headless app）：**真实模型真的调到了
    这个工具**，回执里的工作目录是 `$HOME/定时任务` —— 而进程 cwd 是另一个目录，正是这个 bug
    的原始症状（旧版这里会是 `<cwd>/tesk`）；建任务时磁盘上没有多出任何目录、注册表里也没有
    多出工作区（推迟创建仍然成立）；
  - 真实模型再用 `update_schedule_task` 把 cron 改成每分钟，随后启动真实 web 宿主常驻：
    到点**真的** mkdir 出 `$HOME/定时任务`、注册出同名工作区、开出一个新会话（会话目录名就是
    该路径）、`runs` 记到 `ok: true`；
  - 手工把数据改成旧版形态（`workspacePath = /usr/local/bin/tesk` + 保留坏 `workspaceId`）后
    重启宿主：启动即改判回默认目录、丢掉坏 id、结果落盘，后续执行照常 `ok`；
    真实 registry 对同路径**幂等复用**（`workspaceId` 被写回原来那个），侧栏里没有出现第二条
    同名工作区 —— 这条只有真宿主能验，mock 里是 `throw`。

## [0.15.13] — 未发布

**端到端自检抓出的一个边界**：判"这条任务是不是被改判过"只比了字符串。

### 修复

- 读盘时判"改判过"改成比 **resolve 之后的语义路径**。原实现比的是原始字符串，于是路径里
  一个无意义的尾斜杠（`/Users/你/keep/`，宿主或手工编辑都可能留下）也会被当成"改判过"，
  跟着把**健康的 `workspaceId` 一起丢掉** —— 任务退化成"执行时按路径重建"，白多一次 create
  调用（功能不坏，但属于无谓退化）。真改判（`…/tesk`、`~` 展开）照旧会判出来并丢掉坏 id。
- 这条不是猜的：写端到端自检时按 TDD 先复现 —— 造一条 `workspacePath` 带尾斜杠、id 有效的
  记录，跑出来 `workspaceId` 确实是 `undefined`，修完才过。

### 自检

- **新增端到端自检**（一次性脚本，不进仓库）：临时 HOME + 真实文件系统的工作区注册表 +
  真实 mkdir + 真实 `apply()`，把「对话建任务 → 执行 → 建工作区」整条链路真跑一遍
  （host-smoke 里 `registry.create` 是直接 throw 的 mock，这条唯一会 mkdir 的路径从没被端到端跑过）。
  10 步：默认目录与 cwd 无关、建任务不建目录、执行时真的 mkdir 出 `~/定时任务` 且会话 cwd 落在那里、
  cwd 下没有 `tesk`、读盘改判 + 落盘、坏工作区不复用、`~` 展开、相对路径基准、尾斜杠不误判、真改判仍丢坏 id。
  **反向验证**：把 `scheduleDefaultDir()` 改回 `join(process.cwd(), 'tesk')` → 第一步就报红，
  实际值正是 `<cwd>/tesk`（用户在真实环境里看到的就是这个）。
- host-smoke 112 项不变，新增"尾斜杠不算改判"门禁；**反向验证**：把语义比较改回字符串比较 → 报红。
- typecheck / build / client-smoke（81）/ render-smoke / host-smoke（112）全绿。

## [0.15.12] — 未发布

**定时任务的默认目录改到 `~/定时任务`** —— 它此前跟着**宿主进程的 cwd** 走。

### 修复

- **默认工作区目录不再是 `<宿主进程 cwd>/tesk`，而是用户目录下的「定时任务」。**
  用户报：「在新电脑上装了插件，以对话的方式建立任务时还是会自动乱建目录」，实测建出的是
  `/usr/local/bin/tesk`。根因是默认目录写死成 `join(process.cwd(), 'tesk')`，而宿主进程的 cwd
  与「用户目录」毫无关系：桌面端 App 从 Finder 启动时 cwd 是 `/`，命令行从哪个目录起来就是哪个
  目录 —— 于是同一句"默认目录"在不同机器上解析成 `/tesk`、`/usr/local/bin/tesk`、`~/tesk`
  三种样子（`tesk` 还是 `task` 的错拼）。
  旧机器之所以一直"看着是对的"：`~/.dsh/storages/workspace.json` 里已经有一个标题「定时任务」、
  路径 `~/定时任务` 的工作区，解析时按标题复用了它 —— cwd 那条分支从来没被执行过
  （0.15.2 那句"实测绑定正确"就是这么得出的结论），直到换新电脑才暴露。
- **旧版默认目录 `…/tesk` 会被改判回 `~/定时任务`**（不搬运、不删除原目录里的文件，只换绑定）：
  - 建/改任务时：解析到 `…/tesk` 一律视为"未指定"，回到默认工作区分支；
  - **读盘时**（引擎 load）：数据里记着 `…/tesk` 的老任务就地改判，并**丢掉那条坏的 workspaceId**
    （留着的话执行时 `registry.get` 又把它捞回来），改判结果落盘；
  - 执行时再兜一次：已绑的工作区路径若是 `…/tesk`，丢掉绑定、按新路径建 `~/定时任务`；
  - 注册表里那个标题「定时任务」、路径却是 `…/tesk` 的工作区**不再被复用**（否则改判白做）——
    找默认工作区改成"先按目录、再按标题"，并跳过路径是旧默认目录的条目。
- **显式目录里的 `~` 不再被吞掉**：`resolve("~/定时任务")` 原会得到 `<cwd>/~/定时任务`，
  `mkdir -p` 真会建出一个名叫 `~` 的目录。现在统一先 `expandTilde`，且相对路径以**家目录**为基准
  （与默认目录同一条理由：cwd 不稳定）。面板那三句提示文案同步说明支持 `~`。
- **不绑定工作区的任务，会话 cwd 从 `process.cwd()` 改为家目录**：桌面端 cwd 是 `/`，
  在根目录下开出来的会话做任何文件操作都会撞权限。

### 变更

- 面板「新建任务」选「定时任务（执行时创建）」时，下方会显示**将来会建在哪**
  （`目录：/Users/你/定时任务`）。以前这一档是一片空白 —— 用户只有在任务跑过一次、发现目录不对时
  才看得出问题，这次那个 `/usr/local/bin/tesk` 正是这么被埋了很久。

### 自检

- host-smoke 112 项不变（新断言落在既有的定时任务断言块内）：
  ①「默认工作区还不存在」那条断言从"路径非空"改成**钉死 `join(homedir(), '定时任务')`**
  —— 旧写法 `…/tesk` 也能过，正是它放过了这个 bug；
  ② 旧默认目录改判：显式传入与读盘 load 两条路径 + 坏 workspaceId 必须丢掉 + 结果要落盘；
  ③ `~` 展开与相对路径基准；④ 路径是旧默认目录的注册表条目不许复用、路径正确的仍要复用。
- **两条都做了反向验证**：把默认目录改回 `join(process.cwd(), 'tesk')` → 断言报红
  （"默认目录必须是用户目录下的「定时任务」，不许跟着宿主进程的 cwd 走"）；把 load 的改判短路成
  `pathRevised = false` → 断言报红。两处恢复后全绿。
- typecheck / build / client-smoke（81）/ render-smoke / host-smoke（112）全绿。

## [0.15.11] — 2026-09-29

**「刷新」挪到标题栏，紧挨心电图右边** —— 放在浮层面板里点不动，不折腾了。

### 变更

- 刷新按钮从「心电图点开的面板」里**挪到标题栏**，与心电图并排（order 2 = 排在它右边），
  24×24 图标式，与心电图同尺寸、同一排的观感。
- 原因：那面板是 `position: fixed` 浮层，视觉上落在宿主 `header` 的**窗口拖动带**
  （`-webkit-app-region: drag`）里。拖动带拦的是 Chromium 浏览器层的事件 —— 鼠标按下那一刻
  就被系统拿去拖窗口，**根本不会派进页面**；DOM 层没有任何遮挡物，所以
  `document.elementFromPoint` 查不出来，给浮层补 `no-drag` 实测也救不回来（0.15.10 试过）。
- 标题栏这一排按钮由宿主罩在 `no-drag` 容器里、又不脱离文档流，事件正常 —— 心电图本身能点
  就是证明。
- 面板里那枚刷新按钮及其 `data-reloading` 状态一并移除。

## [0.15.10] — 未发布

**修好「刷新按钮只有边缘一小块能点」** —— 面板落在了宿主的窗口拖动区里。

### 修复

- 给心电图徽章、面板与刷新按钮补 `-webkit-app-region: no-drag`。宿主布局层用
  `app-region: drag` 划了窗口拖动区，**落在其中的元素收不到鼠标事件**；官方各客户端包
  都给自己的交互元素补了 no-drag，本插件此前漏了。症状正是按钮大部分点不动、只有露出
  拖动区的那一小条能点。

## [0.15.9] — 未发布

**「刷新」改用 mousedown 触发** —— 用户报按钮点了「毫无反应」，加固触发时机。

### 修复

- 刷新按钮的处理器从 `onClick` 换成 `onMouseDown`：面板在 window 的 capture 阶段注册了
  「点外部即关闭」，一旦它在 click 到达之前把面板卸掉，click 就永远落不到按钮上；
  mousedown 更早，那时按钮必定还在 DOM 里。

## [0.15.8] — 未发布

**「刷新」按钮不再看着像禁用** —— 初版的低对比配色被读成「灰的点不动」。

### 修复

- 「刷新」按钮改成 `--dsw-alias-label-primary` 文字 + 实底 + 描边（初版用 `label-secondary` + 8% 透明底，
  视觉上就是禁用态），hover / active 都有明确反馈。
- 点击后按钮先变「刷新中…」（1.5 秒后自动复原）：页面若真的开始重载，这一帧立刻被替换掉；
  它若一直停在那里，就说明重载没生效 —— 把静默失败变成看得见的信号。
- `reloadPage()` 不再静默吞异常：`location.reload()` 抛错时打印到控制台，并退一步试 `location.replace()`。
- 点击加 `stopPropagation()`，避免这次点击被面板的其它处理顺带消费。

## [0.15.7] — 未发布

**心电图面板右上角多了一个「刷新」** —— 新装的技能、插件不必重启客户端就能生效。

### 新增

- 「活跃指示」面板（会话标题栏那枚心电图点开后的清单）标题行右侧新增**刷新**按钮：点一下整页重载，
  新装的技能随即出现在输入框的 `/` 菜单里。
- 背景：`dsh-client-ui-skill` 把技能目录**按会话永久缓存**（只有 `connection/reset` 与切换 agent preset
  会让它失效），所以在已经打开的会话里新装的技能搜不到；而 DSH 没有对外暴露「只刷新当前会话」的接口，
  整页重载是最省事且确定的做法。
- 代价写在按钮的悬停提示里：界面状态（打开的面板、滚动位置）重置，**会话本身不丢**（在宿主侧）。
  预览 / 冒烟环境没有真实 `location` 时静默跳过，不影响面板的其它动作。

## [0.15.6] — 未发布

**投递开关的报错不再谎称「整个插件已关闭」** —— `enabled` 只管「允许把文件投递到 IM」，
报错却以插件名开头，读者会以为定时任务、呼吸灯、提示音也一起停了。

### 修复

- `send_file_to_im` 在 `enabled: false` 时抛出的文案，从
  「dsh-helper-patch 已在 config.json 里关闭（enabled: false），把开关改回 true 即可恢复。」
  改为「文件投递当前是关闭状态（config.json 的 enabled: false）：在「插件列表 → 辅助补丁」的
  设置卡片里打开「允许把文件投递到 IM」即可恢复。」—— 说清**关的是哪一项**、**去哪儿打开**，
  并且直接复用设置卡片第一行的标题原文，用户照着念就能在界面上对上号。
- `enabled` 的语义**只覆盖投递**：定时任务（`scheduleEnabled`）、一键重启（`restartEnabled`）、
  呼吸灯与提示音都不受它影响，原文案把这件事说反了。

### 说明

- **行为零改动，这是刻意的**：工具照旧**不按后端探测摘表**。未检测到 IM 插件时 `send_file_to_im`
  仍留在工具表里，只在调用时报可操作的错（「找不到 dsh-im 的位置…可在 config.json 里设置 dshImDir」）。
  定时任务那 4 个工具需要 gate，是因为两个建任务工具同时在表里会让模型弹「选哪种」的问题（选择歧义）；
  投递工具是单例、无歧义，而探测只是廉价快照（profile 目录靠 argv 推断、判据是某个内部文件是否存在）——
  真按它摘表，就变成「补装 IM 插件 / 手填 `imConnectDir`·`dshImDir` 之后还得重启才挂得回来」，
  而现在的探测是**每次投递实时重算**的（config.json 无缓存，改完文件下一次调用即成功）。
- `/send-file` 这条 HTTP 端点的 403 文案「dsh-helper-patch 已关闭（enabled: false）」**保持原样**：
  它面向本机脚本调用、不经过模型转述，本次只按用户口径改工具那条。

### 自检

- 这句文案在全仓库只有它自己一处（没有测试断言、没有别的引用），改它不会连带改坏其它提示。
- typecheck / host-smoke（112）全绿。

## [0.15.5] — 未发布

**空态也摆出筛选标签与搜索框** —— 用户口径：「没有任务的时候也能显示这些元素吗」
（附的是官方「自动化任务」页空态那一段的截图：三档筛选 + 搜索框照样在）。

### 变更

- 面板的三档筛选（全部 / 已启用 / 已停用）与搜索框**改成无条件渲染**。此前它们包在
  `items.length > 0` 里，理由是「空页面上摆一排没法用的控件只是噪音」；但用户是拿这一页与官方
  「自动化任务」逐块比对的，官方无论有没有任务都摆着这两行，切换页面时位置也不跳。
  空态下筛选点了没有效果，仍保留可点（不给 `disabled`）—— 与官方一致：一个灰掉的控件比一个
  点了没反应的更像坏了。
- 空态提示（「还没有定时任务。」）位置不变，仍在搜索框下方居中。

### 自检

- render-smoke 9 项不变，但**从"只验不炸"升级为带内容断言**：`SchedulePanel` 渲染出来的
  一律是初始态（`renderToString` 不跑 effect ⇒ 还在取数据、items 为空），也就是天然的空态
  那一路 —— 现在断言这份 HTML 里必须有 `dsh-helper-sched-filterTab` 与
  `dsh-helper-sched-search`。此前这条用例只 `renderToString` 不看结果，**空态分支等于没有任何
  断言覆盖**（正是它能被藏起来的原因）。
  **做过反向验证**：`git checkout HEAD -- src/client/schedule.jsx` 退回旧实现 → 该断言报出
  「空态里没有 filterTab / search」两条 → 恢复后通过。
- typecheck / build / client-smoke（81）/ render-smoke（9/9）/ host-smoke（112）全绿。

## [0.15.4] — 未发布

**定时任务页的标题不再贴着窗口顶部** —— 用户口径：「把定时任务的 UI 换成自动化任务一样，
主要是离顶部的距离」（附了我们这一页与官方「自动化任务」页各一张截图）。

### 修复

- 面板标题行的上边距补上宿主的**窗口框架避让**：写死的 `28px` 改成
  `calc(28px + var(--dsh-frame-top-clearance, 0px))`。
  桌面端（macOS 无边框窗口、Windows 那套自绘标题栏）宿主的 `html` 上定义了
  `--dsh-frame-top-clearance`（`[data-platform=darwin]` 下是 **48px**），官方「自动化任务」页
  在 `[data-platform=darwin]` 下把 `pageHeading` 的 `padding-top` 加成同一个值 —— 当初照抄那一页
  时只抄到写死的 28px，于是我们的标题整整高出 48px，还压在窗口红绿灯那一带的框架留白里。
  这个值取自宿主客户端包 `@deepseek-ai/dsh-client-ui-schedule` 的 `lib/client.js`
  （asar 内 `/dsh/node_modules/...`），不是我猜的：官方那条规则原文就是
  `[data-platform=darwin] .lNsnGq_pageHeading{padding-top:calc(28px + var(--dsh-frame-top-clearance,0px))}`。
- 选择器**不**套 `[data-platform=darwin]`：这个变量只在需要避让的框架下才有值，浏览器里取不到
  就走 `0px` 兜底（与官方在网页版的表现一致），顺带也不会漏掉 Windows 标题栏那一路。
- 右栏（新建 / 编辑详情）**不动**：官方那一页同样没给它加避让，两边保持一致。

### 自检

- client-smoke 81 项不变，在既有的「布局度量与官方那一页逐字一致」那条里加两条断言：
  标题行的 `padding-top` 必须叠上 `--dsh-frame-top-clearance`；不许退回写死 `28px`。
  **做过反向验证**：临时把 CSS 改回 `padding-top:28px` → 该条断言报红 → 恢复后通过。
- typecheck / build / client-smoke（81）/ render-smoke（9/9）/ host-smoke（112）全绿。

## [0.15.3] — 未发布

**把「建工作区」从创建时推迟到第一次执行时** —— 用户口径：「为什么任务还没执行，都已经把工作区
建立了？不用这样，他执行的时候应该会自动建立工作区」。

### 变更

- **两条创建路径都不再当场建工作区**，只解析「将来会用到哪个目录」：
  - `create_schedule_task`（提示词建的）：原先省略 workspacePath 时立刻
    `ensureWorkspace('', '')`（mkdir + 注册表建条目），显式给了目录时同理；
  - 面板「新建任务」：原先**打开表单就** `ensureScheduleWorkspace('')`，保存自定义目录时又建一次
    —— 用户只是点开看一眼、或填完又取消，磁盘上已经多了一个空目录、侧栏里已经多了一个工作区。
  现在两边都只调用新增的**只读** `resolveScheduleWorkspace`（不 mkdir、不建条目）：
  默认工作区**已经存在**就直接复用（与以前完全一样）；**还不存在**就只记下路径，工作区留到任务
  第一次真正执行时由引擎的 `tryAutoRecoverWorkspace` 建。
  理由：这条任务可能**永远不执行**（建完忘了、cron 排在很久以后、建错了随手删掉），
  而副作用是立即且持久的。

- **引擎的执行路径相应放宽**：原先只在「`workspaceId` 有值却查不到」时才按路径恢复；现在
  「有 `workspacePath` 但没有 `workspaceId`」也走同一条恢复 —— 那正是上面推迟创建留下的状态。
  两个字段都没有 = 这条任务本来就不绑定，仍走 `defaultCwd`，不会被误建。
  若「有路径但建不出来」（宿主没给能力 / 目录不可写），退化成不绑定并 warn，不让任务失败。

- **面板下拉新增哨兵项「定时任务（执行时创建）」**。这一步不能省：默认工作区还不存在时，
  若只把表单留成空 id，而空 id 在下拉里的语义是「不绑定工作区」，界面就会显示成"不绑定"、
  执行时却绑到默认工作区 —— 属于骗用户。

- remote 新增只读方法 `resolveScheduleWorkspace`（客户端信封同步，描述符 7 → 8 个）。

### 自检

- client-smoke 80 → **81 项**（`docs/DEVELOPMENT.md` 的自检表同步），新增一条：面板源码里
  不能再出现 `remote.ensureScheduleWorkspace(` 调用。判据取**调用形式**而非裸名字 ——
  `DEFAULT_WORKSPACE` 的注释里正当地提到了它（解释为什么不用它），裸 `includes` 会把注释
  误判成违规（第一版就是这么红的，改成调用形式才准）。
- host-smoke 112 项不变，但在定时任务断言块里新增一段「默认工作区**还不存在**时，建任务
  **不许**创建工作区」；mock 的 registry 加了 `mockWorkspaceExists` 开关与 create 调用计数。
- **两条新断言都做了反向验证**：把行为改回旧样子 → 断言报红 → 恢复后通过。
  只写正向断言不算门禁。
- typecheck / build / client-smoke（81）/ render-smoke（9/9）/ host-smoke（112）全绿。

## [0.15.2] — 未发布

定时任务工具的两个「能不能用」问题：一个让模型**拿不到任务 id**，一个让任务**跑偏到别的工作区**。

### 修复

- **`create_schedule_task` / `list_schedule_tasks` 的回执不显示任务 id**。两个工具的 output
  schema 里都有 `id`、`execute` 也确实返回了它，但 **`render` 没渲染出来** —— 而模型拿到的
  正是 render 的文本。后果很具体：systemPrompt 明确写着「update / delete 都要先用
  list_schedule_tasks 拿到 id」，模型却拿不到，只能拿标题去猜，`delete_schedule_task` 直接报
  「找不到定时任务「xxx」」（本次实测踩到，最后是去数据文件里挖的 id）。
  现在 create 的回执带 `任务 id：…`，list 每行末尾带 `[id=…]`，与 delete 回执的格式一致。
  ⚠️ host-smoke 里原先那条 `assert.ok(createdByTool.id)` **覆盖不到这件事**：它断言的是
  execute 的返回值，而模型看的是 render 的输出。两者是两条路。

- **`workspacePath` 的描述从"可选"改成明确劝阻自选目录**。用户报「提示词建立的定时任务不在
  「定时任务」工作区下面」：任务绑哪个工作区，执行出来的会话就落在哪个 cwd（引擎的
  `meta.cwd = workspace.path`），所以模型一旦按任务主题自己挑目录（例如给"每日热点"配
  `~/Temp/news-daily`），任务就会在「定时任务」之外另建工作区，会话散落在那边，用户在侧栏的
  「定时任务」下找不到。
  证据链：`~/.dsh/sessions/--Users-biaoge-Temp-news-daily--` 与 `--Users-biaoge-Temp-hotspots--`
  下的会话 cwd 正是这两个目录，而这两个目录是**建任务那一刻**才 mkdir 出来的
  （news-daily 的创建时间与该会话的 createdAt 同分钟）—— 任何配置文件里都搜不到它们，
  说明来自**运行时传入的参数**，不是配置。
  现在参数描述与 systemPrompt 都写明：**通常必须省略**，只有用户明确说了某个目录才填，
  并说明自选目录的后果（会话散落到「定时任务」之外）。
  顺带确认：省略 workspacePath 时绑定是**正确**的（实测 `/Users/biaoge/定时任务`），
  host-smoke 原有那条断言也一直在钉它 —— 问题只出在模型没有省略。

### 自检

- host-smoke 新增两条（112 项不变，落在既有的定时任务工具断言块内）：create / list 的**回执
  文本**必须含 id、`workspacePath` 的描述必须写明「通常省略」且劝阻自选目录。
  两条都做过**反向验证**：临时去掉 id 渲染 → 断言报出「list 的每一行都必须带 id，实际：
  · T（0 9 * * *）」→ 恢复后通过。只写正向断言不算数，能红才算门禁。
- typecheck / build / client-smoke / render-smoke / host-smoke（112 项）全绿。

## [0.15.1] — 未发布

对宿主版本的 peer 范围收敛为**只保留下限**：内核以后升级，这一行不用再改。

### 变更

- **`@deepseek-ai/dsh-typert-protocol` 的 peer 范围由四段 caret 改为 `>=0.1.5-rc.1`**。
  原文 `^0.1.5-rc.1 || ^0.1.6-alpha.2 || ^0.1.7-rc.1 || ^0.2.0-rc.1` 是每来一个内核
  版本补一段的清单；实测 `dshmarket` 的 `deriveHostCompatibility` 后确认这些分段
  不构成门禁 —— `classifyPeer` 只对「低于下限」与「超出**显式**上界」报 `risk`，
  超出 caret 的**隐式**上界只算 `warning` 并放行（宿主 `0.5.0` 上三段写法也是
  `compatible`）。改成 `>=0.1.5-rc.1` 后下限照旧拦截更老的宿主，上限则彻底放开，
  `0.2.3-rc.4` / `0.3.0` / `1.0.0` 实测全部 `compatible`。
  与 T专家 0.4.9 同一批改动、同一套实测依据。
  ⚠️ 同样只解决装机门禁：内核有破坏性 API 变更时，插件仍要改代码并重新发布。

## [0.15.0] — 未发布

定时任务迁移幂等性：合并成功后写入"已迁移"标记，删任务后提示自然消失。

### 修复

- **「合并完任务再删，迁移提示却还在」的根治**。`migrateScheduleFile` 的合并分支在 0.14.0
  改成自动合并 + 报 `merged` 提示，但提示对象是 apply 时算一次就缓存到 schedule engine 里的；
  用户在面板里把合并过去的任务删掉之后，引擎内存里的 `migrationNotice` 不会跟着更新，
  **面板会一直挂着那条 merged 提示** —— 用户问"我都删了为什么还显示"，根源就在这。
  0.15.0 加一个**幂等性标记**：合并成功后给 target 顶层写 `migration.legacy` 字段；
  schedule engine 的 `load()` 读成 `migrationTag`，`persist()` 每次落盘**原样保留**；
  `snapshot()` 据此判断"已经迁移过那个旧文件" → 不再透传提示。
  端到端走一遍：apply 时合并 + 写标记 → 用户删任务（target.items 清空）→ 标记仍在 target 顶层
  → snapshot 不再带 migrationNotice → 面板不显示任何提示。重启宿主也安全：
  启动时看到标记就跳过整段迁移逻辑，不二次合并、不二次报提示。
- `lib/schedule.js` 加了 `import { join } from "node:path"` 与 `import { homedir } from "node:os"`
  —— 引擎需要 `legacyPath` 自己算一遍（之前只在 host 里算），host 改了 env 后忘了同步引擎是
  常见 bug；两边用同一份路径表达式才不会脱钩。
- `lib/index.js` 加了 `writeFileSync` 的导入（`writeMigrationTag` 用到 —— 这是这次踩到的小坑：
  函数写完了但忘了加 import，host-smoke 第一遍跑就炸在 `writeFileSync is not defined`）。

### 自检

- host-smoke 110 → 112，新增两条：
  - **迁移幂等性**：`target` 顶层有 `migration.legacy` 字段时，snapshot 不再返回
    `migrationNotice`（即使内存里还有那条诊断），并且 `migrationNotice` 字段不会凭空出现。
    这正是用户报的现状 —— "我删了任务，提示还在" 在这条断言下没法发生。
  - **migration 字段穿过 persist**：用户在面板里增删改任务后，文件顶层的 `migration.legacy`
    必须仍在。⚠️ 这是 zod `z.object` 默认 strip 的又一个必填字段 —— 漏声明就是这种静默回归。
    （注：migration 字段本身在文件顶层、没经过任何 zod schema，但 persist 用 `JSON.stringify`
    会**主动**丢掉所有不在 payload 里的字段 —— 不在 persist 里显式带上就是会被清掉。）
- docs/DEVELOPMENT.md 自检表同步：host-smoke 110 → 112，描述里加"合并幂等性 = 删任务后提示消失 / migration 字段穿过 persist"。

## [0.14.0] — 未发布

定时任务数据迁移：自动合并「目标已存在但为空」的搁浅情况。

### 修复

- **迁移被「目标已存在」跳过时不再只是出声** —— 现在会**自动把旧文件合并到空的目标文件**。
  0.10.0 那版把"目标已存在就跳过"从静默 return 改成出声 + 面板提示，但那版只告警不动数据；
  结果是用户看到「还有 N 条没迁」的提示，可任务依旧不会被调度 —— 这正是用户报的现状。
  典型场景：本插件在迁移闸门打开之前先启动过一次（那次把空表写进目标文件），
  之后旧文件里的任务就永远没迁过来，面板是空的、任务不再触发。
  现在 `migrateScheduleFile` 把这条分支细化：
  - **目标文件存在但为空** = 没有用户数据可破坏 → 自动 `copyFileSync` 旧文件到目标，
    回 `merged` 诊断让面板告诉用户「已帮你迁了 N 条」，旧文件保留作备份（与首次迁移同口径）；
  - **目标文件已有任务** = 用户已经在新数据根里建过东西 → 仍不覆盖，
    回 `stranded` 诊断让用户手动处理（面板里"照旧文件重建"或"关掉总开关、移走目标文件后重启"）。
  合并失败时退化为 `stranded` 诊断 + warn 日志，保留 0.10.0 那套「出声但不动用户数据」的兜底语义。
- `migrateScheduleFile` 的返回值类型从 `{ stranded?: ... }` 扩到
  `{ stranded?: ..., merged?: ... }`，二者不会同时出现。JSDoc 与运行时都对齐。
- `migrationNotice` 线格式加必填的 `kind: 'merged' | 'stranded'` 字段，
  决定面板走 `sched.merged`（友好告知，已自动处理）还是 `sched.stranded`（仍搁浅，含恢复办法）。
  这是 zod 的 `z.object` 默认 strip 的又一个必填字段 —— 漏声明会被静默剥掉，
  于是客户端会把两种情况都按 stranded 渲染。
- 0.10.0 那段 `sched.stranded` 文案补一句"目标文件里已有任务，迁移不会覆盖你的现有数据"，
  让恢复办法的语境更清晰（之前只说"目标已存在"，用户要猜为什么）。
- 新增 `sched.merged` 文案：友好告知「已自动从旧文件合并 N 条过来，现在按正常调度触发；
  旧文件保留作备份，想清掉可以手动删」。
- 修复一处旧文案疏漏：英文版的"移走后重启宿主让它自动迁移"现在写"让它自动**合并**"
  （与新的实现一致：旧文件存在 + 目标为空 = 合并而非首次迁移）。

### 自检

- host-smoke 110 项（原 109 → 110）：
  - **改写**：「迁移被「目标已存在」跳过时必须出声」拆成两条 —— 一条验证「目标为空时自动合并
    」（断言目标内容已等于旧文件、旧文件保留、回报 `merged` 含三要素、日志只有一条 info），
    一条验证「目标非空时仍不覆盖」（断言 `merged` 为 undefined、`stranded` 有、目标内容未变）；
  - **改写**：「搁浅诊断要能走到面板」改为同时验证 `stranded` / `merged` 两种 kind
    都能穿过 `scheduleSnapshotSchema`（zod 漏声明 `kind` 会被 strip，被这条抓到）。
- docs/DEVELOPMENT.md 自检表同步：host-smoke 109 → 110，描述里把"迁移诊断"换成"自动合并 / 仍搁浅"。

## [0.13.0] — 未发布

工程化：这个仓库此前**没有 typecheck、没有 CI、没有发布钩子**，四套自检全靠维护者手跑。

### 新增

- **`tsconfig.json` + `npm run typecheck`**，并挂进 `verify` 的第一步。
  仓库里原本有 4 个文件标了 `// @ts-check`，但既没有 tsconfig 也没有 typecheck 脚本 ——
  **那些标记一直是死的**（tsc 根本不读它们）。上线后第一次跑就抓出两个真问题：
  - `createScheduleEngine` 漏写 `migrationNotice` 的 `@param`（TS2339）—— 0.10.0 加字段时漏的；
  - `businessError` 的 `fallbackCode` 缺类型标注 → 整个三元表达式退化成 `any` →
    那道写着「上游类型缺口」的 `@ts-expect-error` **从来没生效过**（tsc 报 TS2578 unused）。
    补上 `{string}` 之后抑制指令才名副其实；临时删掉它会立刻报
    `TS2345: Argument of type 'string' is not assignable to parameter of type 'keyof RemoteErrorDetailsMap'`
    —— 也就是说注释里描述的那个上游缺口是真的，只是此前没有任何东西在检查它。
  - `include` 与 `@ts-check` 标记的一致性由 `host-smoke` 的一条断言**递归**双向核对
    （T专家 那份同类自检用非递归 `readdirSync`，于是 `lib/skill-gate/` 整个子目录都不在视野内）。
- **`.github/workflows/ci.yml`**（此前连 `.github/` 都没有）：typecheck → 三套冒烟 →
  **客户端产物可复现**（`npm run build` 后 `git diff --exit-code -- lib/client.js`）→
  `npm pack --dry-run`。步骤名里刻意**不写断言条数**，免得又多一处要手工同步的数字。
- **`prepublishOnly`**（= `npm run verify && npm pack --dry-run`）。`docs/PUBLISHING.md` 里那句
  "本包没有把 build/verify 挂到发布钩子，所以必须手动跑" 就是这个缺口的自白 ——
  它意味着「改了但忘了跑自检」可以一路走到发布。
- **`.npmrc`（`legacy-peer-deps=true`）**：`@deepseek-ai/dsh-typert-protocol` 现在同时是
  peerDependency（运行期由宿主提供）与 devDependency（开发期要它的类型，否则 typecheck 里
  全是 `any`、抑制指令形同虚设），这种组合最容易触发 peer 解析冲突。
- **三套冒烟各自核对 `docs/DEVELOPMENT.md` 里写的项数**（收尾处直接比，不包成 `check()`：
  `check` 的计数本身正是被核对的对象）。文档里那三个数字曾经长期写着 **58 / 72 / 6**，
  而实际早已是 77 / 103 / 9，没有任何机制发现。现在改测试不改文档会直接红（已实测：
  把文档数字改错 → exit 1，改回 → exit 0）。

### 修复

- **客户端 `apply()` 加分阶段降级**。此前任何一个 `install*` 或槽位注册抛错都会让整个 entry
  变成 FAILED，而宿主的启动审计（`web boot: N entry did not activate`）会让**整个 Web GUI**
  停在 "Failed to load plugins" 页 —— 一个可选的呼吸灯在某宿主版本上不兼容，不该有这种后果。
  现在每一步包在同步版 `stage()` 里（本插件的 `apply` 必须保持同步：槽位注册排在异步之后会
  表现为"入口时有时无"，所以不能照抄 T专家 那份 async 版），失败带阶段名出声并降级。
- **`ops/tz.sh` 发布时不再用 `npm version`**。它会自己造一个 `chore: 发布 vX` 提交并顺手打 tag，
  与「版本号随每次提交走、发布时只补 annotated tag」的规矩冲突（CHANGELOG 顶部那条写的就是它），
  照旧跑等于**二次升版**：发出去的号与 CHANGELOG、tag 全对不上。改成用 node 精确写入
  `package.json` 与 `package-lock.json`（根级 + `packages[""]` 两处，写完立刻重新 parse 校验）、
  提交、再 `git tag -a`。`--keep` / 重试模式那条分支本来就是对的（只补 annotated tag），未动。
- **host 侧 8 处 `console.*` 改用 `ctx.logger`**（`lib/index.js` 6 处、`lib/schedule-remote.js` 1 处，
  另给 `deliverViaDshIm` 补了 `logger` 参数 —— 此前只有 im-connect 那条后端收得到日志）。
  桌面端的 `console` 未必进宿主日志文件，而这些行的价值全在"事后能被翻到"。
  两处 `console` 兜底**刻意保留**并加了注释说明：`im-connect.js` 的 `channelLogger`
  （上游输出是排查投递失败的唯一线索，拿不到 logger 时宁可写 stdout 也不要静默丢掉）、
  `schedule-remote.js` 构造函数里那一行（同理）。
- `schedule-remote.js` 的 `static inject` 去掉从未使用的 `"settings"`。死依赖不是无害的：
  cordis 要等 inject 里**每一个**服务就绪才实例化这个类，于是宿主的 settings 一旦晚到或出问题，
  定时任务面板就跟着报「服务暂时不可用」，而排查的人会去查 typert 与调度引擎。

### 变更

- README 新增「时区与夏令时」一节，结论是**实测**的（croner 9.x）：cron 按宿主进程的本地时区
  解释；春季拨快时落在"不存在的那一小时"的任务当天**推后 1 小时**触发、不跳过这一天；
  秋季拨慢时落在"重复的那一小时"的任务当天**只触发一次**、不跑两遍。附可复现命令，
  并注明每个时区要用独立进程跑（同进程内改 `process.env.TZ` 不总生效，V8 会缓存时区数据）。
- README 的 `config.json` 字段表补上 0.11.0 那两个新字段（`sendToken` / `sendAllowRoots`）。
- README 的「只跑一次」一节改为与新计数语义一致：只有**成功**的运行消耗次数，
  失败改为连续 5 次自动停用（此前写的是"跑完那一次自动停用"，与 0.10.0 的实现不符）。
- `docs/PUBLISHING.md`：删掉"必须手动跑 verify"那句（现在有钩子了），改为说明
  `prepublishOnly` 与 CI 各跑什么；`npm version` 那条改成解释"为什么用 `git tag -a`"
  （`--follow-tags` 只推 annotated tag），不再与上面的禁令自相矛盾。
- `docs/DEVELOPMENT.md` 的自检表补 typecheck 一行、更新三套冒烟的覆盖描述与项数。
- `KNOWN-ISSUES.md` 顶部注明"文中行号是 2026-09-25 排查当时的快照、此后已漂移"，
  并指出定位应按符号名或跑 `host-smoke`（那两条缺陷现在各有回归断言盯着）。
  逐次追行号是场必输的仗 —— 这份文档是留档，不是导航。

### 自检

- host-smoke 109 项：新增「每个标了 `// @ts-check` 的自研文件都在 tsconfig 的 include 里」
  （递归扫 `lib/` 与 `src/` 双向核对，并断言 `typecheck` 脚本存在、`verify` 含它、
  `prepublishOnly` 含 `verify`）+ 收尾处的文档项数核对。
- client-smoke 80 项：新增「apply 分阶段降级」（用一个"所有槽位注册都抛"的 ctx 去撞，
  断言 `apply` 不抛、每一步都试过、失败出声且带阶段名）+ 文档项数核对。
- `npm ci --dry-run` 通过（lock 与 package.json 一致）、`npm pack --dry-run` 23 个文件、
  `bash -n ops/tz.sh` 通过、`bash ops/tz.sh 6` 能跑完预检（停在 npm 未登录 E401，属环境问题）。

## [0.12.0] — 未发布

同一批审查里的 P3：客户端卸载残留、轮询、跨平台可移植性，以及两处**行为收紧**。

### 修复

- **插件卸载/重载后不再在宿主页面上留痕迹**。`installGlow` 与 `installAppearance` 原先把
  `ensureStyle()` 与 `syncStyleAttribute()` 写在 `ctx.effect` **外面**，于是注入的 `<style>`
  标签与写在 `<html>` 上的属性（`data-dsh-glow-style` / `--dsh-glow-speed` /
  `data-dsh-helper-flat`）在卸载时无人清理；样式标签靠 `querySelector` 去重才没有一次重载叠一份
  —— 那是运气不是设计。现在注入与移除都在 effect 内成对出现（cordis 卸载 fiber 时会跑清理）。
  呼吸灯的观察组件卸载时还会擦掉侧栏行上的 `data-dsh-glow` / `data-dsh-glow-unread`
  标记：**那些属性写在宿主的 DOM 节点上**，组件卸载不会带走它们，原先关掉开关后侧栏仍在发光。
- **「立即执行」后的 6 秒轮询在面板关闭后立刻停**。原先没有存活标志，用户在这 6 秒里关掉面板
  是再正常不过的操作，而轮询会照跑到底：每 600ms 一次 remote 往返 + 往已卸载的组件 setState。
  React 18 不再为此报警告，所以它是静默的。`catch`/`finally` 里的 setState 也一并加了守卫。
- **`prefs.js` 广播时逐个订阅者兜错**。原先一个监听器抛错（组件已卸载、宿主某版本 props 形状变了）
  会中断整个 `for` 循环，**其余订阅者收不到通知** —— 表现是"改了一个设置，只有部分界面跟着变"，
  且没有任何报错线索。吞掉的错现在会 `console.warn` 出来（带偏好键名）。
  顺带改为遍历副本：订阅者可能在回调里 unsubscribe。
- **`ops/tz.sh` 的非交互入口整个不可用**（`bash ops/tz.sh 5` → `action: command not found`，
  exit **127**）：`action "$1"` 写在 `action()` 定义**之前**，而 bash 是顺序解释的。
  交互式菜单照常工作，所以这个坏法很容易被忽略。把入口移到定义之后，并给 `0` 加了
  no-op 分支（原先它会掉进 `*)` 报"无效选项"再以 2 退出，脚本里拿它当"什么都不做"用会误判成失败）。
  注：`ops/` 在 `.gitignore` 里（本地运维脚本，不随仓库分发、也不在 npm 的 `files` 白名单内），
  所以这条修复只落在本机的脚本上，clone 仓库不会看到它 —— 记在这里是为了说明"当时确实坏了、
  以及为什么坏得没人发现"。
- **`tools/preview.mjs` 不再写死作者的家目录**。原先 `PRIMITIVES` 的默认值是
  `/Users/biaoge/.npm-global/...`，换一台机器或别人 clone 下来跑 `npm run preview` 直接失败，
  而报错只说「找不到 primitives 包：<那条别人机器上的路径>」。改成按候选顺序探测
  （`DSH_PRIMITIVES` → npm 全局 → 本仓库 → 同工作区隔壁插件 → DSH Desktop 自带），
  全都找不到时把试过的路径与 `DSH_PRIMITIVES` 的用法一起打出来。

### 变更

- **BMP 判定从"看到 `BM` 就认"收紧为结构校验**（行为变更）。BMP 的签名只有 2 字节，
  原先 `Buffer.from('BMxxxx')` 就被判成图片 —— 一个叫「BMC 集群巡检报告.txt」的文件、
  一段以 BM 开头的 Base64、一个首格是 BM 的 CSV 都会被改名成 `.bmp` 按图片消息发出去，
  微信那边要么拒收要么给出一张打不开的"图片"。2 字节签名在 6.5 万种组合里撞上的概率并不低，
  这不是理论风险。现在还要校验 BITMAPFILEHEADER 的两处结构：偏移 6–9 的保留字段必须全为 0，
  偏移 14–17 的 DIB 头大小必须是已知值之一（12/16/40/52/56/108/124）。
  取舍是**宁可漏认一个畸形 BMP**（退回按文件发送，对方照样收得到内容，只是没有预览），
  也不要把文本当图片发出去。
- **两段 system prompt 引导不再给子会话**（行为变更，与 T专家 的 `t-team:experts` 小节对齐）。
  `dsh-helper-patch:send-file` 与 `dsh-helper-patch:schedule-tasks` 的 `text` 因此从静态字符串
  改成函数：子会话（`agent.session.header.parentSession` 有值）返回空串。
  理由：「该不该把文件发到用户微信」「该不该建一个每天自动跑的任务」都是**用户级**决定，
  要由主会话和用户商量；塞给 subagent 只是白占 token，更糟的是可能诱导它自作主张 ——
  两者都有持久副作用。子会话真要发文件也发得了，工具仍在它的工具表里。
- 清掉 `schedule.jsx` 文件尾一段**孤儿注释**（描述的是活跃指示那枚心电图，2026-09-28 已迁到
  `attention.jsx`）。里面「试过 `header.actions` 槽、实测落点在标题栏左侧 x≈583」这条结论有价值，
  已移进 `attention.jsx` 的文件头，并补上颜色语义 —— 免得后人再试一次那个槽。
- `schedule.jsx` 的 `import ... from "./schedule-copy.js";;` 多出的那个分号。
- `sidebar-glow.jsx` 的 CSS 里三段风格注释原先编号为「风格 A/B/C」，与 `STYLES` 数组顺序
  （hue / beat / halo）对不上，而且「（默认）」标在了 beat 上（默认其实是 hue）。
  三段一律改用 id 命名，默认标记移到 hue。

### 自检

- host-smoke 108 项：`sniff bmp` 那条从"看到 BM 就认"改写成结构校验的六个用例
  （合法 BMP 认得、保留字段非 0 不认、DIB 头大小乱写不认、三种以 BM 开头的真实文本都不认、
  只有 2 字节时不猜）；新增子会话豁免断言（两段小节的 `text` 必须是函数、对主会话给完整引导、
  对子会话返回空串、`context` 为空或缺失时既不豁免也不抛）。
- client-smoke / render-smoke 全绿（样式表注入顺序未变：假 `ctx.effect` 是立即执行的）。
- `bash -n ops/tz.sh` 通过，`bash ops/tz.sh 0` → exit 0，`bash ops/tz.sh 99` → 报"无效选项"exit 2
  （改之前两者都是 127）；`node tools/preview.mjs` 在这台机器上探测到 npm 全局那份并正常出图。

## [0.11.0] — 未发布

### 新增

- **`/send-file` 的两道可选闸门：HTTP 投递口令 + 目录白名单，都默认关闭**
  （2026-09-28 用户口径：「可选 token + 可选路径白名单，默认都关」）。

  背景：这个路由的原语是「读本机任意文件并发到微信」。跨站请求本来就被 Origin 校验挡掉
  （浏览器跨站 POST 必带 Origin），**残留的暴露面是同机的其它进程** —— 它们发的请求同样
  没有 Origin，与用户自己的 curl 无法区分。单用户个人电脑上这通常可接受，但多用户机器
  或本机跑着不信任的进程时，那就是一条真实的文件外泄通道。而"默认就限制"会直接打断
  既有的 curl 用法，所以两道闸门都做成可选、默认关：**不开就与加固前逐字节同行为**。

  - **口令**：设了之后每个请求都必须带（请求头 `x-dsh-helper-patch-token`，或 body 的
    `token` 字段），否则 401 + `code: send-token-required`。比较用 `timingSafeEqual`
    而不是 `===`：普通比较在第一个不同字节处返回，响应时间差能被本机进程用来逐字节猜口令
    —— 同机攻击者正好是这道闸门要防的对象。
  - **口令从不回显**：`GET`/`POST /config` 都只返回 `sendTokenSet` 这一个比特。那条 GET
    与本路由同属"无 Origin 的本机请求也放行"，回明文等于任何同机进程都能读到口令，
    闸门就形同虚设了。改口令是三段式：不传该字段 = 不修改、传空串 = 清除、传非空 = 设置
    （设置页因此能同时做到"留空保存不会误清口令"与"有明确的清除按钮"）。
  - **目录白名单**：只有白名单目录及其子目录里的文件能发出去。**工具路径同样受限** ——
    校验放在 `readDeliveryFile`（"读本机文件"的唯一收口点）而不是只放在 HTTP 入口，
    否则 `send_file_to_im` 就成了绕过白名单的后门。校验在 `stat` **之前**：被拒的路径
    连存在性都不该被探测。
  - **两侧都做 `realpath`**（`realpathDeepest`）：只比字符串前缀的话，在白名单目录里放一个
    指向 `/etc/passwd` 的符号链接就绕过去了。而"路径不存在时退到最近的存在祖先再拼回尾部"
    这一步同样必需 —— macOS 上 `tmpdir()` 给的是 `/var/folders/...` 而真实路径是
    `/private/var/folders/...`，只 realpath 一侧会把合法路径误拒（冒烟里实测抓到）。
  - 白名单支持 `~` 展开：设置页的说明写了「可用 ~ 表示家目录」，host 就必须真的认它，
    否则 `resolve("~/Downloads")` 会变成 `<cwd>/~/Downloads`，一条永远匹配不上的白名单。
  - 前缀判断带路径分隔符：`/tmp/allowed` 不会误放行 `/tmp/allowed-evil`。
- 设置页「文件投递」卡片新增这两项（卡片末尾，它们是"想收紧的人才会碰"的东西，不该抢在
  两个日常开关前面）。文案在**未设状态**就写出请求头名字与 401 后果：用户得在设之前
  知道既有脚本要怎么改，否则设完才发现全 401 了，排查成本比现在读一句话高得多。
- `ui.jsx` 新增 `TextField`（官方 `primitives.Input`，取不到时退回原生 `<input>`；
  `multiline` 时走原生 `<textarea>`）。0.9.2 曾把一个零引用的 `TextInput` 当死代码清掉，
  这个是为新控件加的、有真实调用点，不是把那个复活。

### 变更

- README 把这条路由的暴露面**照实写清**（原先只说了跨站 403 与 200 MiB 上限）：拦得住跨站、
  拦不住同机进程，以及两道闸门各自"关掉时 / 打开后"的行为表、带口令的 curl 写法、
  为什么口令不回显、为什么白名单对工具路径也生效。
- README 的 curl 示例端口 `3080` → **`19387`**，并注明以宿主实际监听为准
  （3080 是旧版本的默认端口，照抄会连不上）。

### 自检

- host-smoke 107 → **108 项**：新增「投递加固：口令比较、白名单归一化与前缀判断」
  （`expandTilde` / `tokenMatches` / `pickSendToken` / `pathWithinRoots` / `normalizeAllowRoots` /
  `realpathDeepest` 六个纯函数逐分支覆盖，含"未启用一律放行""前缀相似的兄弟目录不误放行"
  "长度不同的口令不能让 `timingSafeEqual` 抛出去"），并在既有那条 host 用例里加了端到端一段：
  默认态走到"文件不存在"（证明两道闸门都放行）→ 设口令后不带/带错 401、带对放行、
  body 里的 token 也认、明文不出 host、清除后回到默认 → 设白名单后外部路径被拒且错误
  列出允许目录、兄弟目录不误放行、内部路径放行、**工具路径同样被拦** → 清空白名单恢复不限制。
- client-smoke 新增两条：默认态（两项都标明「可选」「默认关闭」、写出请求头名、口令框是
  `password` 型且不回填、两颗保存按钮在"没内容可存"时禁用、未设口令时不出现「清除口令」），
  以及已设态（说「已设置」与 401 后果、列出当前允许的目录、「清除口令」出现且可点）。
  这两条一律从**渲染树**断言而不是靠 `primitiveCalls` 那个全局数组：`check()` 对 async 是
  立即调用的，多条渲染设置页的用例并发跑时会互相污染它（实测拿到 3 个口令框而不是 1 个）。
  为此给 primitives 桩补了 `Input`，并把 `value`/`placeholder`/`disabled` 落到节点属性上；
  另抽出 `freshModule()`（全新模块实例 = 全新 hook 状态槽），要断言"某个 props 组合下的
  初始状态"必须用它，拿主实例的话 `useState` 的初始值早在前面某条用例里就进槽了。

## [0.10.0] — 未发布

一次代码审查（2026-09-28，两个插件的只读复查）查出的一批问题，这一版修的是**定时任务引擎**那一组：
并发一致性、失败处理策略、数据文件的可恢复性。

### 修复

- **执行窗口里的并发变更不再被旧快照覆盖**（此前会静默损坏数据）。
  `runScheduled` / `runNow` 原先在 `execute()` 之后无条件 `items.set(id, updated)`，而 `updated`
  是用**执行开始时**那份 item 展开出来的；`execute()` 内部有真实的 await 窗口（建会话 + 提交提示词，
  实测数百毫秒）。窗口里用户完全可能删掉或改过这条任务，于是：
  - 删除被撤销 —— 任务**复活并落盘**。当前进程内定时器已被摘掉所以不立刻触发，但宿主一重启
    `rescheduleAll()` 就会重新给它挂上，用户以为删掉了、它第二天照常跑；
  - 修改被覆盖 —— 更隐蔽：`update()` 当时已按**新** cron 重挂了定时器，`items` 却被写回旧值，
    于是面板显示的 cron 与实际触发的 cron 不一致，要到下次重启才对齐。

  改为 `mergeRunResult()`：只取运行记录字段（`runs` / `runCount` / `failStreak` / `lastRunAt` /
  `lastRunError`），以 `items` 里的**当前值**为基底合并；任务已被删除就丢弃这次结果
  （定时路径静默丢弃，手动路径报「事项不存在」而不是把一份已删除的快照当成功结果返回）。
  `enabled` 单独处理：只接受"系统停用"（跑满上限 / 失败止损），用户在窗口里手动启停的意图一律保住。
- **失败的运行不再消耗 `maxRuns` 配额**。此前失败也计数，一个 `maxRuns: 1` 的一次性任务
  失败一次就 `enabled = false` **永久停用** —— 用户看到的状态是「没成功却已停」，且没有任何重试机会。
- **数据文件损坏时把原文件留存为 `.corrupt-<时间戳>`**。此前解析失败只 warn 一句就按空表继续，
  而下一次 `create` / `update` 的 `persist()` 会用空表**覆盖**那个损坏文件 ——
  用户的全部定时任务凭空消失且无副本可恢复。留存后日志会说明副本在哪、怎么恢复。
- **`config.json` 改为原子写**（临时文件 + `fsync` + rename），与 `schedule.json` 同一套实现。
  此前直接 `writeFile`：写一半崩溃会留下半个 JSON，`readConfig` 解析失败后回默认值 ——
  表现是「用户的设置无声丢失」，而且查不出原因。
- **`writeFileAtomic` 补 `fsync`**：没有它，rename 可能先于文件内容到达磁盘，机器**断电**
  （注意不是进程崩溃 —— 那种情况内核缓存仍会写完）就会留下一个"名字对了、内容是空"的文件。
- **HTTP 投递补上取消与超时**（5 分钟硬上限 + 客户端断开即取消）。此前 `/send-file` 不传 `signal`
  而工具路径传了 `exec.signal`，两个入口行为不一致：上游一挂起，HTTP 响应就无限悬挂、连接一直占着。
  超时回 504 并给出可操作文案；客户端已走掉时不再写响应（那头没人接，只会再抛一次）。

### 变更

- **连续失败到上限（5 次）自动停用该任务**，成功一次即清零计数。
  失败不消耗配额之后必须有这道止损：一个配了坏提示词的分钟级 cron 否则会**无限**开新会话 ——
  烧额度、会话列表被刷满，而用户可能几小时后才注意到。计数落盘，所以重启不会把它重置。
- **迁移被跳过时不再静默**。`migrateScheduleFile` 的「目标已存在」分支原先直接 `return`：
  如果本插件在迁移闸门打开前先启动过一次（那次启动会把一张空表写进目标文件），
  旧文件（`~/.t-team/schedule.json`）里的任务就永远迁不过来 —— 面板是空的、任务不再触发，
  而任何地方都不说一句话。现在这种情况会同时出声（宿主日志）并回一条 `migrationNotice` 诊断，
  由定时任务面板顶部渲染成醒目提示（含条数、旧文件路径与两种恢复办法）。
  日志在桌面/Web 里用户看不见，所以这条必须走面板。
- 面板列表显示「已连续失败 N 次」：少了它，用户看到一个「已停用」分不清是自己关的还是止损关的。
- 「最多执行次数」的说明补上计数口径（只有成功的运行消耗次数、失败改为连续失败止损）。
- 清掉 `schedule-css.js` 里一段**重复了两遍**的注释。

### 自检

- host-smoke 103 → **107 项**，新增/改写：
  - 「执行窗口里的并发变更」四段：删除不复活（内存 + 磁盘 + 定时器）、修改不被覆盖、
    窗口里手动停用要保住、`failStreak` 能穿过线格式；
  - 「迁移被跳过时必须出声」：报出搁浅条数与两个路径、日志含可操作恢复办法、且仍绝不覆盖用户数据；
  - 「搁浅诊断要能走到面板」：`snapshot` 带 `migrationNotice` 且穿得过 zod（漏声明会被 strip）、
    正常启动时不凭空出现该键；
  - 「数据文件损坏时留存副本」：副本是原始字节、后续写入不动它、日志说清副本在哪；
  - 改写 maxRuns 那两段以匹配新语义（失败侧用真环境覆盖，成功侧用 mock agents 覆盖）。
- 线格式新增 `failStreak` 与 `migrationNotice` 两个字段（`lib/schedule-schemas.js`）：
  zod 的 `z.object` 默认 strip，漏声明的键过网关会被静默剥掉。

## [0.9.2] — 未发布

### 变更

- **设置卡片的骨架恒定**：host 配置还没读回来时也渲染完整六张卡片（卡内显示「正在读取…」）。
  此前 loading 分支只画了四张（文件投递 + 浏览器侧三张），打开插件页的瞬间卡片会从 4 张跳成 6 张。
- **定时任务面板的 CSS 类名去掉 t-team 前缀**：`t-team-sched-*` → `dsh-helper-sched-*`。
  那批类名是当初从 T专家 整体搬过来时原样带过来的，留着只会让人以为两边还有耦合 ——
  两个插件本来就各有前缀（T专家 用 `t-team-*`、本插件用 `dsh-helper-*`），这次只是把尾巴对齐。
- 清掉 `ui.jsx` 里 **6 个零引用导出**（`Field` / `groupTitleStyle` / `TextInput` / `Select` / `Tabs` / `Tag`）：
  它们是照 T专家 那份结构写的，本插件用不到；`ChoiceGroup` 改为自包含（不再借 `Field` 的外壳）。
- 自检：client-smoke 补一条「骨架恒定」断言（host 配置未读回时也必须是六张）。

## [0.9.1] — 未发布

### 变更

- **设置卡片按用途重排成六张卡片**（用户 2026-09-28：「功能选项有点乱，可以借鉴参考下 可组合记忆
  (dsh-mnemon) 里面那种风格」）：文件投递 / 定时任务 / 活动提示 / 完成提示音 / 界面外观 / 宿主操作。
  分组从一个灰标题 + 一条 0.5px 分隔线（浅色主题下几乎看不见）改成一张张带边框的卡片。
  截图里那两处错位一并修掉：「启用定时任务」原本被塞在「文件投递」标题下面、「显示活跃指示」
  整行没有标题、悬在呼吸灯与提示音之间。
- **控件换成 DSH 官方 primitives**：开关用官方 `Switch`、按钮用官方 `Button` —— 与 mnemon 等官方插件
  同一套观感。此前那个绿色开关是本插件自绘的，与同页官方控件的圆角与色值都不一致。
  产物因此多了一条外部 require（`@deepseek-ai/dsh-client-ui-primitives`）：已在 `dsh.client.inject`
  声明，构建脚本相应把 `@deepseek-ai/*` 一律外部化（由宿主的客户端模块表提供单例）。
  组件取不到时逐个退回自绘实现 —— 客户端 entry 一抛错会让整个 GUI 停在 "Failed to load plugins"。
- 互斥选项（音色 / 音量 / 提示风格 / 节奏）**没有**直接用官方 `SegmentedControl`：它是 `inline-grid`
  且 `white-space: nowrap`、每段 `padding: 0 16px`，8 个音色横向必然溢出卡片。改用照它观感自绘的
  chips（底槽 + 选中项浮起，token 与它一致），窄窗口下自动折行。
- 自检：client-smoke 新增 5 条结构断言（六张卡片与顺序、定时任务开关的归属、「活动提示」卡片内容、
  开关一律走官方 Switch、选项组可折行），并把假 React 升级成**有状态**（读配置 → 重渲染能看到就绪版），
  renderTree 补上嵌套数组处理；渲染冒烟新增 `tools/primitives-stub.jsx` 替身与 esbuild alias。

## [0.9.0] — 未发布

### 新增

- **活跃指示（会话标题栏那枚心电图）**：从 `dsh-plugin-t-expert` 整体迁来 —— 有会话正在跑、或有事等你查看时
  显示彩色（高亮沿心电路径滚动），全部空闲且无待看时显示灰色；点它列出需要注意的主会话，点其中一条先展开
  它所属的侧栏工作区分组、再直接接上那个会话，还能一键复制会话 id。挂载点与外观都不变
  （`conversation.session.header.utilities`）。设置卡片里多一组开关「显示活跃指示」，默认开。

### 变更

- **偏好存 localStorage**（键 `dsh-helper-patch:pulse:enabled`），与呼吸灯/提示音/界面外观一致，不为一个
  布尔值开一条 host 路由。⚠️ 原来在 T专家 设置里关掉过它的用户，迁过来是**开着**的，需要在本插件里再关一次
  （T专家 那份存在宿主设置文档里，localStorage 继承不到）。
- 会话跳转工具从 `src/client/schedule-jobs.js` 改名 `src/client/session-nav.js`：它现在同时服务定时任务的
  「关联会话」与活跃指示的会话清单，本来也不是定时任务专有的；顺手把文件里三处日志前缀从 `[t-team]` 改成
  `[dsh-helper-patch]`。
- 插件列表的中英简介、README 与开发文档补上这项能力。

## [0.8.0] — 未发布

### 变更

- **插件列表的名称/简介改为中英双语**：新增 `locale/en.json`（英文）与 `locale/zh.json`（即原来的中文描述），
  `exports` 与 `files` 白名单补 `./locale/*`。宿主按界面语言取值 —— 英文界面显示英文、中文界面仍是原来的中文；
  少了 `locale/` 或这几行 exports 映射时会静默退回 `package.json` 的中文描述。

## [0.7.0] — 2026-09-27

### 变更

- **文件投递支持 `@michengai/dsh-im-connect`**：IM 插件从 `@xmanrui/dsh-im` 换成它之后，投递不再失效。
  两个后端按实际安装情况自动选（`config.json` 的 `backend` 可固定为 `im-connect` / `dsh-im`，默认 `auto`；
  显式指定时找不到就报错，不静默换路）。新后端只读复用它的微信通道工厂（`lib/channels/weixin.js` 的
  `createWeixinChannel`），造一个**只发不收**的实例——只调 `sendFile()`、**绝不调 `start()`**，因此不会和
  宿主里真正在跑的通道抢同一个微信账号；账号取 `$DSH_HOME/dsh-im-connect/channels.json`，botToken 取
  `ctx.credentials` 的 `im_connect_<账号id>_botToken`，收件人退回账号的 `allowedUserId`。
  行为差异：图片/视频改由 im-connect 按**文件名后缀**分流（旧后端由本插件按内容魔数判定），
  因此「图片以图片消息发送」开关只对 dsh-im 后端生效；错误翻译改为按上游文本解析
  （`ret=-2` / `-14` / CDN 上传 / HTTP 状态），`hadContextToken` 与失败提示照旧。
- **发送名纠偏（先验货、后分流）**：im-connect 后端发送前用内容魔数检查文件名——真图片叫错
  名字（截图存成 `.txt`、无后缀）自动纠正后缀按图片消息发；文本改名 `.jpg` 改按文件发，免得被
  微信当图片拒收后报出误导性错误。只动发送那一刻的文件名（微信里显示的），磁盘原文件不动，
  回执里仍是原名，纠正细节进日志。名字与内容同属图片类（如 `.jpeg`）不纠，避免无谓改名；
  视频不纠偏（格式头复杂、场景少）。魔数嗅探抽到 `src/host/image-sniff.js` 两个后端共用。
- 设置卡片的「文件投递」组新增一行**当前后端**（只读的探测结果），并说明两个后端下图片判定的差别。
- 系统提示词里「把文件发我微信」的走法按会话来源分开：IM 会话里 `present` 即可（IM 插件自己回传），
  其他会话用 `send_file_to_im`。
- 投递里「读文件 + 校验大小」抽成两个后端共用的 `readDeliveryFile()`，行为不变。
- 系统提示词 `dsh-helper-patch:send-file` 一节按实测经验补全：IM 会话 present 后不要再调工具
  （会发两遍）；「其他会话」明确包含定时任务新开的会话；一次一个文件、读取前的错误不必提前检查；
  `sent: true` 只代表平台已受理（回复别说"已送达"）；失败时转述错误自带的建议、不要立刻原样重试。

### 修复

- 对照上游 `@michengai/dsh-im-connect` 0.1.55 源码逐项复查投递链路契约：补两条错误翻译
  （`invalid-file-name`——文件名含反斜杠/控制字符时给出中文指引；「CDN 上传响应缺少
  x-encrypted-param」——上传成功但消息没发出，提示重试是安全的）；工具描述与系统提示词
  去掉只对单一后端成立的措辞；统一「接入微信」的提示文案。

## [0.6.0] — 未发布

### 新增

- **关闭侧栏毛玻璃**（设置卡片「界面外观」组，纯浏览器侧偏好，默认关）：macOS 桌面端左侧栏
  那层"毛玻璃"是**系统原生窗口材质**——主进程写死 `vibrancy: "sidebar"` + 窗口底色全透明，
  官方再配合让开底色（`html[data-platform=darwin]` 下 `html`/`body` 透明、框架透明、侧栏列只填
  40%（深色 50%）不透明的 `--dsw-specific-sidebar-fill`，主内容列与右栏是实色），所以只有左边
  那一条能透出模糊。宿主没有开关，这里用**样式覆盖**实现：给 `body` 铺不透明的
  `--dsw-alias-bg-base`（随深浅主题走，`html,body,#root` 满高 → 铺满视口后原生模糊被完全遮住），
  并把侧栏列还原成官方非 macOS 平台的实色填充与 0.5px 分隔线。零侵入、可逆，不动 `app.asar`
  （改它等于破坏代码签名与自动更新）。只在 macOS 桌面端有效。

## [0.5.1] — 未发布

### 修复

- 一轮结束「叮好几下」：完成提示音的去重/冷却窗口从 800ms 放宽到 5 秒，`running` 在一轮结束后
  抖几下也只响一声。
- 自然语言建定时任务未绑定默认「定时任务」工作区（模型没给工作区时就落到默认目录 `<默认目录>/tesk`）。

## [0.5.0] — 2026-09-26（首个 npm 版本）

### 新增

- **对话完成提示音**：会话跑完出一声（纯客户端，读 DSH 已有的会话状态快照，不加宿主钩子）。
  音色现场合成、不带音频文件（叮咚 / 单音叮 / 三连音 / 电子哔 / 街机金币 / 扫频 / 激光），
  音量三档、点一下即试听、可选「只在切走时响」；停下等 300ms 再响、只认顶层会话，避免多轮/多代理连响。
  支持**自定义提示音**（本地音频 ≤ 4 MB，存浏览器 IndexedDB，先解码再落库，失败回退「叮咚」）。
- **一次性任务 `maxRuns`**：cron 没有年份位，「某年某月某日」只能表达成「每年这天」；新增
  `maxRuns`（跑 N 次后自动停用，1 = 一次性）后配上「那天」的 cron 即等价只跑一次。上限与已跑次数
  **落盘**，重启宿主不重跑；面板可填、列表标「限次 1/1」，4 个工具都支持。
- **自然语言创建定时任务**：新增 `create_schedule_task` / `list_schedule_tasks` / `update_schedule_task` /
  `delete_schedule_task` 四个 Agent 工具。与官方「自动化任务」并存时引导模型先让用户选独立任务还是会话内
  提醒；总开关关闭时这组工具整组注销；改/删按 id、先回显标题与 cron 再动手。
- **定时任务**：从 `dsh-plugin-t-expert` 整体迁入（该功能已从 T专家 移除）。cron 调度引擎 + 侧栏面板：
  搜索过滤、图形化 cron 选择器、保存前「最近 5 次执行」预览、绑定/自定义工作区、执行记录（每条 20 次）、
  关联会话跳转与归档恢复、行内「停用/启用」按钮。数据落 `$DSH_HOME/integrations/dsh-helper-patch/schedule.json`，
  与 `@weibaohui/dsh-tasks` 零共享；启动时一次性迁移 T专家 旧数据（只复制不删除）。
- **定时任务总开关**（`scheduleEnabled`）：关闭后停止全部触发、拒绝手动执行并隐藏左侧入口，任务与记录
  保留、重开自动恢复；宿主启动按配置值启动。
- **「重启 DeepSeek Harness」按钮**：在「通用设置」页头部，服务端四道闸（配置开关 / 同源环回来源 /
  调试器附着 / 进程监督器），不满足时按钮禁用并说明原因；新增 `/restart` 与 `/restart/status` 路由，
  设置卡片新增 `restartEnabled` 开关。
- 包新增 ESM 子模块导出：`./host/dsh-cli`、`./host/http-trust`、`./host/restart`。
- README「设置与配置」补设置卡片截图（`docs/settings.png`）。

### 修复

- 总开关关闭后左侧「定时任务」入口不消失（补回槽位注销，配置读不到时按「显示」处理）。
- 定时任务业务错误退化成 JS 报错（补回 `businessError` 方法体，域码透传 + 系统 errno 兜底）。
- `/send-file`、`/config`、`/restart/status` 缺来源校验（统一走 `trustedLocalRequest`，无 Origin 的本机脚本放行）。
- 投递文件无大小上限（读取前 stat，超 200 MiB 直接拒绝）。
- 客户端静态 `inject` 缺 `typert`（界面只显示「定时任务服务暂时不可用」）。
- 定时任务 remote 服务改为插件自注册（原依赖安装时生成的 profile patch，只改包内不生效）。
- 样式表孤儿注释体吃掉后续规则（定时任务详情栏整页铺满）。
- `http-trust` 环回判定漏掉 IPv6 裸地址 `::1`。
- `files` 白名单补上 `docs/*.png`（此前发布包缺文档图片）。
- 设置卡片宽度被自己写死（`maxWidth:620px`，比官方内容列窄 340px）——去掉后宽度交给宿主容器，与同页其它内容等宽。
- 自然语言建定时任务省略工作区时落到默认目录（`process.cwd()`）而非「定时任务」工作区——补回与面板新建一致的默认工作区绑定（`ensureWorkspace('', '')`）。
- 提示音一轮结束「叮好几下」：turn 结束时客户端 running 信号会抖几下（`reconcileStatus` 与 `api-session/status` 两条路径时序不一致），每次间隔都超过 300ms 去抖，于是连响。把去重/冷却窗口从 800ms 拉到 **5 秒**，响过一声后 5 秒内不再响，压成一声。

## [0.4.0] — 2026-09-24

### 新增

- **活动呼吸灯**（原独立插件 `dsh-sidebar-glow` 整体并入）：工作区文件夹图标随会话状态呼吸，
  三种风格（彩色流转 / 脉冲 / 光环）；折叠时用橙色标记未读。偏好键名沿用 `dsh-sidebar-glow:*`。
- 设置卡片改为挂在官方「插件信息页」槽位。

### 变更

- 原 `dsh-sidebar-glow` 独立仓库删除，归档为 `removed-backups/dsh-sidebar-glow-20260924.tar.gz`。

## [0.3.0] — 2026-09-23

### 变更（BREAKING）

- 包名 `dsh-imsend` → `dsh-helper-patch`，设置页显示名改为「辅助补丁」。
- HTTP 路由前缀 `/api/dsh-imsend/*` → `/api/dsh-helper-patch/*`。
- 运行时配置目录 `$DSH_HOME/integrations/dsh-imsend/` → `$DSH_HOME/integrations/dsh-helper-patch/`。
- Agent 工具名 `send_file_to_im` **不变**（避免影响已有提示词与习惯）。

## [0.2.0] — 2026-09-23

### 新增

- 图片自动改用**图片消息**发送（按魔数识别，扩展名兜底），微信里可直接预览；投递结果 `via` 字段说明实际路径。
- 开关 `imageAsPicture`：关掉即回到「一律发文件」。
- 上游 dsh-im 尚未提供 `sendImage` 时自动退回 `sendFile`。

## [0.1.3] — 2026-09-22

### 修复

- `-2 prepare failed` 提示不再**断言**原因（腾讯官方协议未定义 `-2`）：改为给出「最近一次收到入站消息是
  N 分钟前」的线索并建议先发一条消息重试。

## [0.1.2] — 2026-09-22

### 修复

- 补全工具的 `output.schema`（此前返回值被 DSH 判为非法，投递成功也报错）；
  返回增加 `toUserId` / `botId` / `hadContextToken` 便于定位。

## [0.1.1] — 2026-09-22

### 修复

- 上游错误翻译成**可操作的中文**提示，HTTP 端点同时保留机器可判断的 `code` 与 `providerCode`。

## [0.1.0] — 2026-09-22

### 新增

- 首个版本（当时名 `dsh-imsend`）：在**任意** DSH 会话里把本机文件主动投递到微信，
  含 Agent 工具 `send_file_to_im` 与同源 HTTP 端点 `/api/dsh-imsend/send-file`。
- 只读复用 dsh-im 的微信协议模块与账号配置，不修改它的源码。
