/**
 * 定时任务的样式（从 dsh-expert 的 css.js 里抽出来的 schedule 段）。
 *
 * 类名前缀 2026-09-28 由 `t-team-sched-*` 改成 `dsh-helper-sched-*`：这批类名是当初整体搬
 * 过来时原样带过来的，留着会让"辅助补丁里躺着一堆 t-team 的东西"成为读代码的噪音。
 * 两个插件本来就各有前缀（T专家 用 `t-team-*`、本插件用 `dsh-helper-*`），这次只是把尾巴对齐。
 * 由 apply() 注入一个 <style> 标签。
 */
export const SCHEDULE_CSS = `

/* ---- 定时任务：侧栏入口（注册为 sidebar.panellist 的一行，位于「新会话」按钮下方） ---- */
/*
 * 那一行（按钮、文字、图标位、悬停/当前项底色、点击行为）由宿主 sidebar 渲染成它自己的
 * panelRow，class 是 CSS Modules 哈希化的、指不上 —— 现在也**不去覆写**它：
 * 同一份列表里，官方「自动化任务」入口（dsh-client-ui-schedule 也注册在这个槽）就是原生长相：
 * 透明底、悬停与当前项给 --dsw-alias-interactive-bg-hover 浅灰底、左对齐图标 + 文字、
 * 最小高 36px、圆角 var(--dsw-radius-md)、左右各 2px 外边距；侧栏收起时宿主自己收成 36px 图标位。
 *
 * 2026-09-25 用户口径「定时任务按钮也做成这种风格」（截图＝官方「自动化任务」那一行）：此前这里用
 * 内容居中），和同列表里的官方入口长得毫不相干；现在整段撤掉，交回宿主默认样式。
 * 顺带消掉了旧实现里的宽度坑：那时必须 width:auto + align-self:stretch，否则宿主 panelRow 的
 * 拉伸宽度会再叠上左右各 2px 的 margin、比「新会话」宽出 4px —— 用默认样式时宽度本来就对。
 *
 * 唯一保留的规则：让自绘图标作为 flex item 稳定成块级（宿主的 glyph 位是 inline-flex 容器）。
 */
.dsh-helper-schedule-glyph{display:block}


/* ---- 定时任务：右侧主区域管理页（注册在 main 槽的 keyed 面板） ----
 *
 * 2026-09-25 用户口径：这块页面要与宿主自带的「自动化任务」页（dsh-client-ui-schedule 的
 * TaskManagerPage）同一套观感。下面这些度量就是**照着那一页抄的**（它的类名是哈希前缀
 * t-XoWW_，取不到，只能把数值搬过来）：
 *   · 内容列 max-width 960px 居中，左右 padding clamp(24px,4vw,48px)，标题上留 28px；
 *   · 标题行 = h1（20px / 500）+ 右侧动作区；下面是 28px 胶囊过滤标签与 36px 搜索框；
 *   · 任务行**无边框**：圆角 12px、padding 8px、悬停给浅灰底，行内是「图标 + 主副两行文字」；
 *   · 主按钮是黑底胶囊（h32 / r16 / 13px），次级操作是透明胶囊按钮（h28 / r14）。
 * 功能一个不少：刷新 / 返回会话 / 新建 / 立即执行 / 编辑 / 删除 / 执行记录 / 表单 / 提示与数据路径。
 */
.dsh-helper-sched{display:flex;width:100%;min-width:0;height:100%;min-height:0;overflow:hidden;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:14px;line-height:1.6}

/* 键盘焦点环：官方给整页一条统一规则（.t-XoWW_page :focus-visible{outline:2px solid …;offset:2px}），
   只有大标题输入框与提示词输入区例外——它们自己有 focus 表现（下划线 / 外框变蓝）。
   照抄，免得各处按钮与输入框的焦点样式各写各的。 */
.dsh-helper-sched :focus-visible{outline:2px solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));outline-offset:2px}

.dsh-helper-sched .dsh-helper-sched-editName:focus-visible,

.dsh-helper-sched .dsh-helper-sched-prompt-input:focus-visible,

.dsh-helper-sched .dsh-helper-sched-search input:focus-visible{outline:none}

/* 左栏（列表）：flex:1 撑满，右侧有详情时自然让出一半；自己不分栏滚动，滚动交给里面的 pageScroll。
   2026-09-25 用户口径：新建/编辑改成官方那种「左列表 + 右详情」的双栏。 */
.dsh-helper-sched-listPane{display:flex;flex-direction:column;flex:1 1 auto;min-width:0;min-height:0}

/* ⚠️ 滚动容器必须是左栏里**全宽**的这一层，内容列（.dsh-helper-sched-page）只负责居中。

/* ⚠️ 滚动容器必须是左栏里**全宽**的这一层，内容列（.dsh-helper-sched-page）只负责居中。
 * 2026-09-25 用户发现「滚动条不在最右边」：此前滚动挂在 960px 的居中列上，滚动条就长在
 * 那一列的右边缘、离窗口右边还有一大截空白。官方那一页也是这么分的：
 * .t-XoWW_pageScroll（flex:1 + overflow:auto + scrollbar-gutter:stable）套 .t-XoWW_pageContent
 * （max-width + margin auto）。scrollbar-gutter:stable 让有/无滚动条时内容不左右跳；
 * 9px 宽与 2px 内缩也是官方那两个值（滚动条配色走宿主的 --dsh-scrollbar-* 变量）。
 * ⚠️ 这一层是**块级**容器（不加 display:flex）：官方的 pageScroll 也没有 display，内容列因此
 * 走块级的 width:auto + max-width 规则。给它加 flex 会让子项的自动外边距改变宽度算法。 */
.dsh-helper-sched-pageScroll{flex:1;min-height:0;overflow:auto;scrollbar-gutter:stable;--dsh-scrollbar-width:9px;--dsh-scrollbar-thumb-border:2px}

/* ⚠️ 内容列与官方 .t-XoWW_pageContent **逐字一致**：max-width:960px + padding，块级（不加 display:flex）、
 * **不要** box-sizing:border-box 与 width:100%（2026-09-25 用户报「区域宽和官方不一样」就是那两条来的）：
 *   · 官方 max-width 限的是**内容盒** → 整列最宽 960 + 2×padding（最大 1056）；
 *   · 加了 border-box + width:100% 就变成「内容 + padding 一共 960」→ 内容只有 864，窄了 96px。
 * 块级流里各段的间距由元素自己的 margin 提供（heading 24 / filters 14 / search 16），与官方同款；
 * 这里不用 flex + gap —— 那会让同一处间距由两套机制叠加，实测就与官方差 2px。 */
.dsh-helper-sched-page{max-width:960px;margin:0 auto;padding:0 clamp(24px,4vw,48px) 48px}

/* 右栏（详情 / 新建 / 编辑）：官方 detail 那套 —— 47% 宽、左侧 .5px 分隔线、顶部 tab 行、
   中间滚动区、底部固定动作条。左右留白统一走官方的 --detail-gutter（24 / 20 / 16 三档断点），
   窄屏（<=760px）时右栏独占整页、列表让位（官方同款断点）。 */
.dsh-helper-sched-detailForm{--detail-gutter:24px;position:relative;display:flex;flex-direction:column;flex:0 0 47%;min-width:0;min-height:0;border-left:.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-base)}

.dsh-helper-sched-detailTabsBar{display:flex;align-items:center;justify-content:space-between;gap:20px;height:44px;min-height:44px;padding:0 var(--detail-gutter);border-bottom:.5px solid var(--dsw-alias-border-l3)}

.dsh-helper-sched-detailTabs{display:flex;align-items:flex-end;align-self:flex-end;gap:36px;min-width:0;margin-bottom:-1px;padding-bottom:1px}

.dsh-helper-sched-detailTab{position:relative;padding:0 0 13px;border:0;background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:13px;font-weight:500;line-height:16px;cursor:pointer}

.dsh-helper-sched-detailTab[data-on="true"]{color:var(--dsw-alias-state-business-primary)}

.dsh-helper-sched-detailTab[data-on="true"]:after{content:"";position:absolute;left:0;right:0;bottom:-1px;height:2px;border-radius:2px;background:var(--dsw-alias-state-business-primary)}

.dsh-helper-sched-detailClose{display:inline-flex;align-items:center;justify-content:center;flex:none;width:28px;height:28px;margin-right:-8px;padding:0;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:14px;line-height:1;cursor:pointer}

.dsh-helper-sched-detailClose:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}

.dsh-helper-sched-detailScroll{flex:1;min-height:0;padding:24px var(--detail-gutter) 28px;overflow:auto;scrollbar-gutter:stable;--dsh-scrollbar-width:9px;--dsh-scrollbar-thumb-border:2px}

.dsh-helper-sched-detailBody{display:flex;flex-direction:column;gap:20px}

/* 底部动作条：官方 saveFooter 的 20px 内边距 + 最后一个按钮右移 8px（视觉右边缘与内容对齐）。 */
.dsh-helper-sched-saveFooter{display:flex;align-items:center;justify-content:flex-end;gap:8px;flex:none;padding:20px var(--detail-gutter);border-top:.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-base)}

.dsh-helper-sched-saveFooter>:last-child{margin-right:-8px}

/* 标题行：与官方 .t-XoWW_pageHeading 同款（padding-top 28 / margin-bottom 24 / gap 16）。
   内容列改成块级流之后，24px 由它自己给，不再与 page 的 gap 叠加。
   ⚠️ 顶上还要再让出一段「窗口框架避让」：桌面端（macOS 的无边框窗口，或 Windows 那套自绘
   标题栏）宿主的 html 上定义了 --dsh-frame-top-clearance（darwin 下 48px），官方那一页的写法是
   在 [data-platform=darwin] 下把 pageHeading 的 padding-top 改成
   calc(28px + var(--dsh-frame-top-clearance,0px)) —— 2026-09-29 用户报「定时任务页标题贴着顶部、
   和自动化任务不一样」就是漏了这一条：我们只给 28px，比官方整整高出 48px，标题还压在窗口
   红绿灯那一带的框架留白里。
   写法上不套 [data-platform=darwin]：这个变量只在「需要避让」的框架下才有值，浏览器里取不到就
   走 fallback 0px（与官方在网页版的表现一致），顺带也不会漏掉 Windows 标题栏那一路。 */
.dsh-helper-sched-head{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:12px 16px;padding-top:calc(28px + var(--dsh-frame-top-clearance,0px));margin-bottom:24px}

.dsh-helper-sched-title{flex:1;min-width:0;margin:0;font-size:20px;font-weight:500;line-height:28px}

.dsh-helper-sched-headActions{display:flex;flex-wrap:wrap;align-items:center;gap:8px;flex:none}

/* 提示文字（加载中）：官方那页没有这一句，给它一个不贴住下一段的下边距。 */
.dsh-helper-sched-intro{font-size:13px;color:var(--dsw-alias-label-secondary);margin:0 0 14px;max-width:760px}

/* 空态 / 无匹配：官方 .t-XoWW_empty 是**居中**的一块（flex column + 居中 + 48px 20px 内边距）。 */
.dsh-helper-sched-empty{display:flex;flex-direction:column;align-items:center;padding:48px 20px;margin:0;text-align:center;font-size:14px;color:var(--dsw-alias-label-tertiary)}

/* 页尾不再挂「安全提示」与「数据文件路径」两行（2026-09-25 用户口径）：
   tip 挪到提示词输入框下面，用 .dsh-helper-sched-hint；路径那行整个删掉。 */
.dsh-helper-sched-note{font-size:13px;color:var(--dsw-alias-state-warn-primary);margin:0 0 12px}

/* 迁移搁浅提示：比普通 note 多一圈边框，因为它意味着「你以为在跑的任务其实从没被调度」，
   值得比普通提醒更醒目一点。 */
.dsh-helper-sched-stranded{padding:10px 12px;border:1px solid var(--dsw-alias-state-warn-primary);border-radius:8px;line-height:1.6}

.dsh-helper-sched-error{display:flex;align-items:center;gap:8px;font-size:13px;color:var(--dsw-alias-state-error-primary);margin:0 0 12px}

.dsh-helper-sched-rowNote{display:block;margin-top:2px;font-size:12px;color:var(--dsw-alias-label-tertiary)}

/* 列表区容器：官方 pageContent 里没有这一层（heading/filters/search/list 直接是兄弟），
   所以这里**不给任何间距**——间距由各元素自己的 margin 提供，跟官方一模一样，避免两套机制叠加。 */
.dsh-helper-sched-body{display:block;min-width:0}

/* 过滤标签行 + 搜索框：官方页面的那两行，数值照抄（28px 胶囊 / 36px 圆角 12px 输入框），
 * 连间距的**来源**也照抄：filters{margin-bottom:14px}、searchField{margin:0 0 16px}。 */
.dsh-helper-sched-filters{display:flex;flex-wrap:wrap;align-items:center;gap:8px 12px;margin-bottom:14px}

.dsh-helper-sched-filterTab{display:inline-flex;align-items:center;flex:none;height:28px;padding:0 10px;border:0;border-radius:14px;background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:14px;line-height:22px;white-space:nowrap;cursor:pointer}

.dsh-helper-sched-filterTab:hover{background:var(--dsw-alias-interactive-bg-hover)}

.dsh-helper-sched-filterTab[data-on="true"]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}

/* ⚠️ 搜索框逐条对齐官方 .t-XoWW_searchField：**content-box**（官方没写 box-sizing，加了 border-box
 * 会让外高从 37 变 36）、**不设 gap**（图标与输入框之间那 6px 属于官方的 Input 组件，
 * 由图标盒自己的 margin-right 给）、margin 0 0 16px。 */
.dsh-helper-sched-search{display:flex;align-items:center;height:36px;margin:0 0 16px;padding:0 10px;border:.5px solid var(--dsw-alias-border-l3);border-radius:12px;color:var(--dsw-alias-label-tertiary);transition:border-color .15s}

.dsh-helper-sched-search:hover{border-color:var(--dsw-alias-border-l2)}

.dsh-helper-sched-search:focus-within{border-color:var(--dsw-alias-state-business-primary)}

/* 图标盒：官方 Input 的 .icon 是 16×16 的 inline-flex 居中盒（里面的 svg 14px），
   图标盒与输入框之间 6px —— 照抄，否则文字起始位置会差 2~4px。 */
.dsh-helper-sched-searchGlyph{display:inline-flex;align-items:center;justify-content:center;flex:none;width:16px;height:16px;margin-right:6px}

/* 输入元素：官方 .input 只重置了 border/outline/background，**保留了 UA 默认的 padding:1px 2px**
 * （所以占位文字的起始位置比我们按住 padding 时多 2px）。照抄：padding 用 UA 默认值，别清零。 */
.dsh-helper-sched-search input{flex:1;min-width:0;padding:1px 2px;border:0;outline:none;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:14px;line-height:22px}

.dsh-helper-sched-search input::placeholder{color:var(--dsw-alias-label-caption)}

.dsh-helper-sched-search input::-webkit-search-cancel-button{display:none}

/* 清空按钮：官方 .t-XoWW_searchClear 是 28×28、右移 6px（图标 14px）。 */
.dsh-helper-sched-searchClear{display:inline-flex;align-items:center;justify-content:center;flex:none;width:28px;height:28px;margin-right:-6px;padding:0;border:0;border-radius:50%;background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:12px;line-height:1;cursor:pointer}

.dsh-helper-sched-searchClear:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}

/* 任务行：官方 .t-XoWW_row 的观感 —— 无边框、悬停浅灰、图标 + 主副两行；操作按钮固定在行尾。
 * 官方那行是 content-box + width:100% + padding 8px（宿主没有全局 box-sizing reset：官方在
 * instruction / zoneSearch / confirmDialog 四处都**显式**补了 border-box，正说明默认是 content-box）。
 * 于是这一行的 border box 比内容列**右出血 16px** —— 那 16px 落在内容列的 padding（≥24px）里，
 * 不会溢出到滚动层，所以照抄不会有横向滚动条。别改回 border-box，那样行会比官方窄 16px。 */
.dsh-helper-sched-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:2px}

.dsh-helper-sched-row{display:flex;align-items:flex-start;gap:12px;width:100%;height:auto;padding:8px;border-radius:12px;cursor:pointer}

.dsh-helper-sched-row:hover{background:var(--dsw-alias-interactive-bg-hover)}

/* 图标槽：官方只有 width/height/margin-top（svg 是 inline），这里也不加 flex ——
   加了会让图标相对行标题的垂直位置差 1~2px。 */
.dsh-helper-sched-rowGlyph{flex:none;width:16px;height:20px;margin-top:2px;color:var(--dsw-alias-label-tertiary)}

.dsh-helper-sched-rowMain{display:flex;flex-direction:column;flex:1;min-width:0}

.dsh-helper-sched-rowTitle{font-size:14px;font-weight:500;line-height:23px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

/* 行标题前的状态图标（14px，与 23px 行高的文字对齐）：
   启用 = 绿（state-success-primary），停用 = **淡红**（state-error-secondary，用户口径「淡红才明显」）。
   颜色固定、不随行的悬停态变化 —— 悬停时标题抬回正常色，图标继续表示这条任务的状态。 */
.dsh-helper-sched-rowTitle>.dsh-helper-sched-state{display:inline-block;vertical-align:-2px;margin-right:6px}

.dsh-helper-sched-rowTitle>.dsh-helper-sched-state[data-state="on"]{color:var(--dsw-alias-state-success-primary)}

.dsh-helper-sched-rowTitle>.dsh-helper-sched-state[data-state="off"]{color:var(--dsw-alias-state-error-secondary)}

.dsh-helper-sched-rowSummary{display:block;margin-top:2px;font-size:13px;line-height:21px;color:var(--dsw-alias-label-tertiary);overflow-wrap:anywhere}

/* 已停用的行按官方「已结束」的处理方式压暗标题与摘要（悬停时再抬回来，保证可读）。 */
.dsh-helper-sched-row[data-disabled="true"] .dsh-helper-sched-rowTitle{color:var(--dsw-alias-label-tertiary)}

.dsh-helper-sched-row[data-disabled="true"] .dsh-helper-sched-rowSummary{color:var(--dsw-alias-label-caption)}

.dsh-helper-sched-row[data-disabled="true"]:hover .dsh-helper-sched-rowTitle{color:var(--dsw-alias-label-primary)}

.dsh-helper-sched-rowActions{display:flex;align-items:center;gap:6px;flex:none}

.dsh-helper-sched-runsToggle{align-self:flex-start;margin:2px 0 0 -6px;padding:1px 6px;border:0;border-radius:var(--dsw-radius-sm, 6px);background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:20px;cursor:pointer}

.dsh-helper-sched-runsToggle:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}

/* ---- 执行记录页（右栏第二个 tab）：官方「任务运行记录」那套时间线 ----
 * 度量照抄 .t-XoWW_delivery*：每条 = 图标 + 时间（14/500）+ 结果，左侧一条 .5px 竖线把各条串起来
 * （left:15.75px 是图标中心：行 margin -8 + padding 8 → 图标中心 16）。 */
.dsh-helper-sched-detailRecords{display:flex;flex-direction:column;flex:1;min-height:0;overflow:hidden}

.dsh-helper-sched-recordsScroll{flex:1;min-height:0;overflow:auto;scrollbar-gutter:stable;padding:24px var(--detail-gutter) 28px;--dsh-scrollbar-width:9px;--dsh-scrollbar-thumb-border:2px}

.dsh-helper-sched-delivery{position:relative;display:flex;align-items:flex-start;gap:12px;margin:0 -8px;padding:14px 8px;border-radius:8px;font-size:14px;line-height:22px}

.dsh-helper-sched-delivery:first-of-type{padding-top:0}

.dsh-helper-sched-delivery:before,.dsh-helper-sched-delivery:after{content:"";position:absolute;left:15.75px;width:.5px;background:var(--dsw-alias-border-l3)}

.dsh-helper-sched-delivery:not(:first-of-type):before{height:14px;top:0}

.dsh-helper-sched-delivery:not(:last-of-type):after{top:42px;bottom:0}

.dsh-helper-sched-delivery:first-of-type:not(:last-of-type):after{top:28px}

.dsh-helper-sched-deliveryGlyph{flex:none;margin-top:6px;color:var(--dsw-alias-label-tertiary)}

.dsh-helper-sched-deliveryBody{flex:1;min-width:0;padding:2px 0}

.dsh-helper-sched-deliveryHead{display:flex;align-items:center;gap:10px}

.dsh-helper-sched-deliveryTime{display:block;color:var(--dsw-alias-label-primary);font-size:14px;font-weight:500;line-height:22px}

/* 状态跟在时间后面（2026-09-25 用户口径）：小图标 + 文字，成功绿、失败红。
   图标用 14px（宿主那些图标本身是 16px 的 viewBox，这里缩放一下与 14px 的时间字号更贴）。 */
.dsh-helper-sched-deliveryStatus{display:inline-flex;align-items:center;gap:4px;font-size:13px;line-height:20px;color:var(--dsw-alias-state-success-primary);white-space:nowrap}

.dsh-helper-sched-deliveryStatus>svg{flex:none;width:14px;height:14px}

.dsh-helper-sched-deliveryStatus[data-fail="true"]{color:var(--dsw-alias-state-error-primary)}

/* 失败原因单独一行（别把"时间 + 状态"那一行撑长）。 */
.dsh-helper-sched-deliveryError{margin:2px 0 0;font-size:13px;line-height:22px;color:var(--dsw-alias-state-error-primary);overflow-wrap:anywhere}

/* 会话行：id + 后面那枚「关联会话 ›」按钮（并排，窄了自动换行）。 */
.dsh-helper-sched-deliverySession{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin:2px 0 0;font-size:12px;line-height:20px;color:var(--dsw-alias-label-tertiary)}

.dsh-helper-sched-deliverySessionId{font-family:var(--ds-font-family-code, monospace);overflow-wrap:anywhere}

.dsh-helper-sched-linkSession{display:inline-flex;align-items:center;gap:2px;flex:none;padding:1px 8px;border:0;border-radius:14px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:20px;white-space:nowrap;cursor:pointer}

.dsh-helper-sched-linkSession:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}

.dsh-helper-sched-linkSession>svg{flex:none;color:var(--dsw-alias-label-tertiary)}

/* 「这个会话打不开」的提示行：归档走 warn 色（旁边还有一枚「恢复并打开」），已删走错误色。 */
.dsh-helper-sched-sessionNotice{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin:4px 0 0;font-size:12px;line-height:20px;color:var(--dsw-alias-state-warn-primary)}

.dsh-helper-sched-sessionNotice[data-state="unavailable"]{color:var(--dsw-alias-state-error-primary)}

/* 那一次提交的提示词：官方 savedPrompt 那套 —— 两行截断（line-clamp:2），点「展开」看全文。 */
.dsh-helper-sched-deliveryPrompt{-webkit-line-clamp:2;line-clamp:2;display:-webkit-box;-webkit-box-orient:vertical;overflow:hidden;white-space:pre-wrap;overflow-wrap:anywhere;margin:6px 0 0;font-size:13px;line-height:22px;color:var(--dsw-alias-label-tertiary)}

.dsh-helper-sched-deliveryPrompt[data-expanded="true"]{-webkit-line-clamp:none;line-clamp:none;display:block}

.dsh-helper-sched-promptToggle{display:inline-flex;align-items:center;gap:2px;margin:2px 0 0 -6px;padding:1px 6px;border:0;border-radius:var(--dsw-radius-sm, 6px);background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:20px;cursor:pointer}

.dsh-helper-sched-promptToggle:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}

/* 末尾一行：说明只留最近多少次（官方的 retentionEnd 同款小字）。 */
.dsh-helper-sched-recordsEnd{margin:16px 0 0;font-size:12px;line-height:20px;color:var(--dsw-alias-label-tertiary)}

/* 按钮：官方那两档 —— 次级是透明胶囊（h28 / r14），主按钮按官方 Button + newButton 的规格：
 * 背景走 --dsw-alias-button-primary-fill、文字走 --dsw-alias-label-primary-foreground（不是我们自己
 * 拼的 label-primary/bg-base —— 换了品牌色就会看出差别）、h32 / r16 / padding 0 12px / gap 4px。 */
.dsh-helper-sched-btn{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:6px;flex:none;height:28px;padding:0 12px;border:0;border-radius:14px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;font-weight:400;line-height:20px;white-space:nowrap;cursor:pointer}

.dsh-helper-sched-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}

.dsh-helper-sched-btn:focus-visible{outline:2px solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));outline-offset:2px}

.dsh-helper-sched-btn:disabled{opacity:.5;cursor:default}

.dsh-helper-sched-btn-primary{gap:4px;height:32px;padding:0 12px;border-radius:16px;background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground);font-weight:500}

.dsh-helper-sched-btn-primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover);color:var(--dsw-alias-label-primary-foreground)}

.dsh-helper-sched-btn-danger{color:var(--dsw-alias-state-error-primary)}

.dsh-helper-sched-btn-danger:hover:not(:disabled){background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 12%, transparent);color:var(--dsw-alias-state-error-primary)}

/* 右栏表单里的字段组与控件：官方详情页那套（.5px 描边 + 12px 圆角输入框、36px 高、
   聚焦换成主题蓝）；分组标题是官方 ruleCard h3 那个 13px 小标题。 */
.dsh-helper-sched-editName{box-sizing:border-box;width:100%;min-width:0;min-height:32px;padding:0;border:0;outline:0;background:transparent;color:var(--dsw-alias-label-primary);font-size:20px;font-weight:500;line-height:28px}

.dsh-helper-sched-editName::placeholder{color:var(--dsw-alias-label-caption)}

.dsh-helper-sched-editName:hover:not(:disabled){box-shadow:0 1px var(--dsw-alias-border-l3)}

.dsh-helper-sched-editName:focus{box-shadow:0 1px var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary))}

.dsh-helper-sched-group{display:flex;flex-direction:column;gap:6px;font-size:13px;color:var(--dsw-alias-label-secondary)}

.dsh-helper-sched-groupLabel{margin:0 0 2px 10px;color:var(--dsw-alias-label-tertiary);font-size:13px;font-weight:400;line-height:20px}

.dsh-helper-sched-group input,.dsh-helper-sched-group textarea,.dsh-helper-sched-group select{box-sizing:border-box;min-height:36px;padding:7px 12px;border-radius:12px;border:.5px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:14px;font-family:inherit}

.dsh-helper-sched-group input:hover,.dsh-helper-sched-group textarea:hover,.dsh-helper-sched-group select:hover{border-color:var(--dsw-alias-border-l2)}

.dsh-helper-sched-group input:focus,.dsh-helper-sched-group textarea:focus,.dsh-helper-sched-group select:focus{outline:none;border-color:var(--dsw-alias-state-business-primary)}

.dsh-helper-sched-hint{font-size:12px;color:var(--dsw-alias-label-tertiary)}

.dsh-helper-sched-checkbox{display:flex;align-items:center;gap:8px;font-size:13px;color:var(--dsw-alias-label-secondary)}

/* cron 选择器：运行时间卡片（官方 ruleRows 那套）+ 卡片下方的常用模板 + 摘要 + 最近几次预览 */
.dsh-helper-sched-cron{display:flex;flex-direction:column;gap:10px;width:100%}

/* 运行时间卡片：度量照抄官方 .t-XoWW_ruleRows / ruleRow / ruleLabel / ruleValue / ruleInput ——
 * .5px 描边 + 16px 圆角容器、每行 min-height 48px、行间一条 .5px 分隔线（最后一行不要），
 * 左边标签 14px、右边取值（原生 select / input 做成无边框、hover 才浮出浅灰圆角底）。 */
.dsh-helper-sched-ruleRows{display:flex;flex-direction:column;padding:0 12px;border:.5px solid var(--dsw-alias-border-l3);border-radius:16px}

.dsh-helper-sched-ruleRow{display:flex;align-items:center;justify-content:space-between;gap:12px;min-height:48px;border-bottom:.5px solid var(--dsw-alias-border-l3)}

.dsh-helper-sched-ruleRows>:last-child{border-bottom:0}

.dsh-helper-sched-ruleLabel{flex:none;color:var(--dsw-alias-label-primary);font-size:14px;line-height:1.6}

.dsh-helper-sched-ruleControl{display:flex;align-items:center;gap:4px;min-width:0}

.dsh-helper-sched-ruleUnit{color:var(--dsw-alias-label-primary);font-size:14px;line-height:1.6;white-space:nowrap}

/* 取值面（官方 ruleValue / ruleValueFace / pickerTrigger / pickerIcon 的形态）：一行右侧是
 * 「当前值 + 一个指示图标」的可点面，hover 时整面浮浅灰，点开一个同源小面板。
 * ⚠️ 刻意不用原生 select：它的箭头与下拉弹层由浏览器画，深浅主题下都没法与官方一致。 */
.dsh-helper-sched-picker{position:relative;display:flex;justify-content:flex-end;min-width:0}

.dsh-helper-sched-ruleValue{display:inline-flex;align-items:center;min-height:48px;padding:0;border:0;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:14px;line-height:1.6;cursor:pointer}

.dsh-helper-sched-ruleValue:disabled{color:var(--dsw-alias-label-tertiary);cursor:default}

.dsh-helper-sched-ruleValueFace{display:inline-flex;align-items:center;gap:6px;min-height:32px;padding:0 8px;border-radius:18px;white-space:nowrap;transition:background .15s}

.dsh-helper-sched-ruleValue:not(:disabled):hover .dsh-helper-sched-ruleValueFace{background:var(--dsw-alias-interactive-bg-hover)}

.dsh-helper-sched-ruleValue:focus-visible{outline:none}

.dsh-helper-sched-ruleValue:focus-visible .dsh-helper-sched-ruleValueFace{outline:2px solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));outline-offset:1px}

.dsh-helper-sched-ruleValueFace>svg{color:var(--dsw-alias-label-tertiary);flex:none}

.dsh-helper-sched-pickerIcon{display:inline-flex;flex:none;color:var(--dsw-alias-label-tertiary)}

/* 点开的小面板：与取值面同源（菜单底色 + 背景模糊，刻意不带投影）。
 * 单列用 .dsh-helper-sched-pickerList（竖排），双列（时/分）直接是两个 .dsh-helper-sched-pickerCol 并排。 */

/* 点开的小面板：与取值面同源（菜单底色 + 背景模糊，刻意不带投影）。
 * 单列用 .dsh-helper-sched-pickerList（竖排），双列（时/分）直接是两个 .dsh-helper-sched-pickerCol 并排。 */
.dsh-helper-sched-pickerPanel{position:absolute;right:0;top:calc(100% + 2px);z-index:26;display:flex;gap:4px;margin:0;padding:6px;list-style:none;border:.5px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-specific-menu, var(--dsw-alias-bg-layer-3));backdrop-filter:var(--dsw-menu-backdrop-filter, blur(20px) saturate(1.4))}

.dsh-helper-sched-pickerList{flex-direction:column;gap:2px}

.dsh-helper-sched-pickerPanel button{display:block;width:100%;min-width:52px;padding:5px 10px;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;line-height:20px;text-align:left;white-space:nowrap;cursor:pointer}

.dsh-helper-sched-pickerPanel button:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}

.dsh-helper-sched-pickerPanel button[data-on="true"]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);font-weight:500}

.dsh-helper-sched-pickerCol{display:flex;flex-direction:column;gap:2px;max-height:240px;margin:0;padding:0;list-style:none;overflow:auto}

.dsh-helper-sched-pickerCol button{min-width:48px;text-align:center;font-variant-numeric:tabular-nums}

/* 自定义表达式的输入框：官方 ruleInput（无框、右对齐、hover 浮浅灰） */
.dsh-helper-sched-ruleRow input{box-sizing:border-box;flex:0 58%;min-width:0;min-height:32px;padding:0 8px;border:0;border-radius:18px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:14px;line-height:22px;font-variant-numeric:tabular-nums;text-align:right;cursor:text;transition:background .15s}

.dsh-helper-sched-ruleRow input:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}

.dsh-helper-sched-ruleRow input:focus-visible{outline:2px solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));outline-offset:-2px}

.dsh-helper-sched-ruleRow input:disabled{opacity:.5;cursor:default}

/* 常用模板：卡片下方的小胶囊（与列表页的过滤标签同款）。
 * ⚠️ 类名必须是 .dsh-helper-sched-preset：.dsh-helper-sched-chip 归提示词里的专家芯片，

/* 常用模板：卡片下方的小胶囊（与列表页的过滤标签同款）。
 * ⚠️ 类名必须是 .dsh-helper-sched-preset：.dsh-helper-sched-chip 归提示词里的专家芯片，
 * 两边同名时后定义的那条会把前面的覆盖掉（踩过：模板按钮长成蓝色芯片）。 */
.dsh-helper-sched-chips{display:flex;flex-wrap:wrap;gap:6px}

.dsh-helper-sched-preset{box-sizing:border-box;display:inline-flex;align-items:center;height:28px;padding:0 12px;border:.5px solid var(--dsw-alias-border-l3);border-radius:14px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;white-space:nowrap;cursor:pointer}

.dsh-helper-sched-preset:hover:not(:disabled){border-color:var(--dsw-alias-label-primary);color:var(--dsw-alias-label-primary)}

.dsh-helper-sched-preset:disabled{opacity:.5;cursor:default}

.dsh-helper-sched-days{display:flex;gap:6px;flex-wrap:wrap}

.dsh-helper-sched-day{min-width:34px;height:32px;padding:0 8px;border-radius:10px;border:.5px solid var(--dsw-alias-border-l3);background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;cursor:pointer}

.dsh-helper-sched-day[data-on="true"]{background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-base);border-color:transparent}

.dsh-helper-sched-sum{font-size:12px;color:var(--dsw-alias-label-tertiary)}

.dsh-helper-sched-next{display:flex;flex-direction:column;gap:4px}

.dsh-helper-sched-nextLabel{font-size:12px;color:var(--dsw-alias-label-tertiary)}

.dsh-helper-sched-nextList{list-style:none;margin:0;padding:0;display:flex;flex-wrap:wrap;gap:6px}

.dsh-helper-sched-nextList li{font-size:12px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-border-l3);border-radius:8px;padding:2px 8px;font-variant-numeric:tabular-nums}

/* 提示词输入区：外框对齐官方详情页的提示词输入框——圆角 16px、.5px 描边、聚焦换成主题蓝。 */
.dsh-helper-sched-promptbox{box-sizing:border-box;display:flex;flex-direction:column;padding:12px;border-radius:16px;border:.5px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-base);transition:border-color .16s}

/* 提示词输入框：普通文本域（迁移时把「@专家名 芯片高亮」的 contenteditable 编辑器换成了它）。
 * resize 关掉、**无边框**、透明底、零内边距 —— 边框圆角一律由外面的 .dsh-helper-sched-promptbox 提供。
 * ⚠️ 选择器必须是**三层**（.dsh-helper-sched-group .dsh-helper-sched-promptbox .dsh-helper-sched-promptInput）：
 * 通用的 ".dsh-helper-sched-group textarea" 是 (0,2,1)，两层写法 (0,2,0) 特异性**不够**，
 * border:0 会被通用规则赢回去 —— 那就是「提示词框有两条边线」的原因（2026-09-25 修）。
 * （注意：这个文件是模板字符串，注释里别写反引号，会把字符串截断导致构建失败。） */
.dsh-helper-sched-group .dsh-helper-sched-promptbox .dsh-helper-sched-promptInput{box-sizing:border-box;display:block;width:100%;min-height:112px;padding:0;border:0;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:14px;line-height:1.6;resize:none}
.dsh-helper-sched-group .dsh-helper-sched-promptbox .dsh-helper-sched-promptInput:focus-visible{outline:none}
.dsh-helper-sched-group .dsh-helper-sched-promptbox .dsh-helper-sched-promptInput::placeholder{color:var(--dsw-alias-label-caption)}

.dsh-helper-sched-promptbox:hover{border-color:var(--dsw-alias-border-l2)}

.dsh-helper-sched-promptbox:focus-within{border-color:var(--dsw-alias-state-business-primary)}

/* 芯片观感对齐对话输入框里的引用芯片：浅灰底、圆角矩形（不是全胶囊）、蓝色文字、
 * 左侧一个圆形线条小图标；× 平时不显示，悬停才浮出来（截图里就是没有 × 的样子）。 */
.dsh-helper-sched-chip{box-sizing:border-box;display:inline-flex;align-items:center;gap:3px;max-width:100%;margin:0 2px;padding:0 4px;border:1px solid transparent;border-radius:6px;background:color-mix(in srgb, var(--dsw-alias-label-primary) 10%, transparent);color:var(--dsw-alias-brand-primary, #1677ff);font-size:12px;line-height:18px;vertical-align:middle;user-select:none}

/* 悬停给一圈淡描边：让"鼠标在这枚芯片上"这件事有确定的视觉反馈（别靠浏览器默认）。 */
.dsh-helper-sched-chip:hover{border-color:color-mix(in srgb, var(--dsw-alias-brand-primary, #1677ff) 35%, transparent)}

.dsh-helper-sched-chip-icon{flex:none;display:block}

.dsh-helper-sched-chip-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

.dsh-helper-sched-chip-remove{padding:0 1px;border:0;background:transparent;color:inherit;font:inherit;font-size:12px;line-height:1;cursor:pointer;opacity:.6;transition:opacity .12s}

.dsh-helper-sched-chip-remove:hover{opacity:1}

/* 提示词编辑区：contenteditable 的富文本流（纯文字 + 芯片），芯片因此能插在正文任意位置。
 * ⚠️ 选择器要带 .dsh-helper-sched-promptbox 前缀（原来是 .dsh-helper-sched-field）：否则特异性低于

 * 通用的 ".dsh-helper-sched-group textarea/input" 那类规则，编辑区会自带一圈边框（踩过：框里套框）。 */

/* 提示词编辑区：contenteditable 的富文本流（纯文字 + 芯片），芯片因此能插在正文任意位置。
 * ⚠️ 选择器要带 .dsh-helper-sched-promptbox 前缀（原来是 .dsh-helper-sched-field）：否则特异性低于
 * 通用的 ".dsh-helper-sched-group textarea/input" 那类规则，编辑区会自带一圈边框（踩过：框里套框）。 */
/* 官方那三档断点（数值照抄）：右栏左右留白 24 → 20 → 16；<=760 时右栏独占整页、列表让位
   —— 挤成两栏两边都没法用。
   ⚠️ 这三段**必须**留在 @media 里。它们曾经因为抽取 CSS 时漏掉了 @media 行而无条件生效，
   表现就是"一打开编辑/新建，列表消失、右栏占满整页"，与官方那种"右栏挂在侧边"完全不是一回事。 */
@media (width<=1100px){
  .dsh-helper-sched-detailForm{--detail-gutter:20px}
}
@media (width<=760px){
  .dsh-helper-sched-listPane[data-detail="true"]{display:none}
  .dsh-helper-sched-detailForm{flex-basis:100%;border-left:0}
  .dsh-helper-sched-detailScroll{padding-top:20px}
}
@media (width<=400px){
  .dsh-helper-sched-detailForm{--detail-gutter:16px}
  .dsh-helper-sched-detailTabsBar{gap:16px}
}
`;

export default SCHEDULE_CSS;
