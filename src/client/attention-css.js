/**
 * 「活跃指示」的样式：会话标题栏那枚心电图图标 + 点开后的会话清单面板。
 *
 * 2026-09-28 从 dsh-expert 整体迁来（原 `src/client/css.js` 里 `.t-team-pulse*`
 * 那一段），规则一条没动，只把类名/关键帧前缀从 `t-team-pulse` 换成 `dsh-helper-pulse`
 * —— 两个插件可能同时装在同一个页面上，各用各的前缀才不会互相覆盖。
 *
 * 与 schedule-css.js 一样单独成文件：内容长、又需要被 client-smoke 按文本断言。
 */
export const PULSE_CSS = `
/* 活跃指示：会话标题栏里的一枚心电图图标 —— 紧贴 agent preset 胶囊左侧（order 比它小）。
   彩色 = 有活动或有待看，灰 = 全空闲。 */
.dsh-helper-pulse{display:inline-flex;align-items:center;justify-content:center;flex:none;width:24px;height:24px;margin-right:2px;padding:0;border:0;font:inherit;border-radius:7px;cursor:pointer;color:var(--dsw-alias-state-success-primary);background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 14%,transparent)}
.dsh-helper-pulse[data-on="false"]{color:var(--dsw-alias-label-caption);background:color-mix(in srgb,var(--dsw-alias-label-caption) 12%,transparent)}
.dsh-helper-pulse:hover{background:color-mix(in srgb,var(--dsw-alias-label-primary) 12%,transparent)}
/* 点开的「需要注意的会话」清单：贴徽章右缘、图标下方。
   浮层材质（2026-09-22 的血泪）：宿主 0.1.7 的视觉统一改版把 --dsw-specific-menu 从
   「= 不透明的 --dsw-alias-bg-layer-3」改成了**半透明菜单材质**
   （亮色 rgba(248,249,250,.58) / 暗色 rgba(48,49,54,.5)），并配套
   --dsw-menu-backdrop-filter = blur(40px) saturate(150%) 才有毛玻璃观感。
   所以凡是 background 用了 --dsw-specific-menu 的规则，都必须紧跟一条 backdrop-filter，
   否则在 0.1.7 上就是「弹窗半透明、能看见底下的对话」；旧宿主上该变量仍是不透明色，
   带了 filter 也没有副作用（背后内容本来就看不见）。fallback 用固定的 blur 值，
   只是为了在拿不到宿主变量的宿主上也不至于完全没材质。 */
.dsh-helper-pulse-pop{position:fixed;z-index:70;width:300px;max-height:min(420px,60vh);overflow:auto;box-sizing:border-box;display:flex;flex-direction:column;gap:2px;padding:8px;border-radius:12px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-specific-menu,var(--dsw-alias-bg-layer-3));backdrop-filter:var(--dsw-menu-backdrop-filter,blur(20px) saturate(1.4));box-shadow:var(--dsw-shadow-lv3);color:var(--dsw-alias-label-primary)}
.dsh-helper-pulse-pop-head{font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary);padding:4px 6px 6px}
/* 标题栏里那枚独立的「刷新」：紧挨心电图右边（order 2）。刻意**不做进浮层面板** —— 面板是
   position:fixed 浮层，视觉上落在宿主 header 的窗口拖动带里，事件根本进不了页面（2026-09-29 实测，
   补 no-drag 也救不回来）；而这一排按钮由宿主罩在 no-drag 容器里、又不脱离文档流，事件正常。
   配色按「一眼看出能点」来（初版用低对比被读成灰色禁用态）。
   注意：本文件整体是一个模板字符串，注释里不能出现反引号，否则会提前截断它、把 PULSE_CSS 变成 NaN。 */
.dsh-helper-refresh{display:inline-flex;align-items:center;justify-content:center;flex:none;width:24px;height:24px;margin-right:2px;padding:0;border:0;font:inherit;border-radius:7px;cursor:pointer;color:var(--dsw-alias-label-secondary);background:transparent}
.dsh-helper-refresh:hover{color:var(--dsw-alias-label-primary);background:color-mix(in srgb,var(--dsw-alias-label-primary) 12%,transparent)}
.dsh-helper-refresh:active{transform:translateY(1px)}
.dsh-helper-pulse-pop-empty{font-size:12px;color:var(--dsw-alias-label-caption);padding:8px 6px}
.dsh-helper-pulse-pop-row{display:flex;align-items:center;gap:8px;width:100%;box-sizing:border-box;border:0;background:transparent;color:inherit;font:inherit;font-size:13px;text-align:left;padding:7px 8px;border-radius:8px;cursor:pointer}
.dsh-helper-pulse-pop-row:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dsh-helper-pulse-pop-dot{flex:none;width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-success-primary)}
.dsh-helper-pulse-pop-dot[data-state="pending"]{background:var(--dsw-alias-state-warn-primary)}
.dsh-helper-pulse-pop-title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-helper-pulse-pop-tag{flex:none;font-size:11px;color:var(--dsw-alias-label-caption)}
/* 每条会话的容器：标题行 + id 行纵向叠放。 */
.dsh-helper-pulse-pop-item{display:flex;flex-direction:column;gap:0;border-radius:8px;overflow:hidden}
.dsh-helper-pulse-pop-item:hover{background:var(--dsw-alias-interactive-bg-hover)}
/* 单条会话下方的小 id 行：等宽、低对比，点击触发复制（与标题行同 hover 区域）。 */
.dsh-helper-pulse-pop-id-btn{display:flex;align-items:center;gap:6px;width:100%;box-sizing:border-box;border:0;background:transparent;color:inherit;font:inherit;padding:0 8px 6px 22px;text-align:left;border-radius:0;cursor:copy}
.dsh-helper-pulse-pop-id{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;line-height:14px;color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0}
.dsh-helper-pulse-pop-id[data-monospace="true"]{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
/* 面板 head 下的"当前会话"行：左标签 + 等宽 id + 标题(挤压) + 右 hint，整行可点复制；不论下面有没有「需要注意」的会话都显示。
   当前会话 id 还没就绪时整行点 cursor:default，且用点状边框 + 琥珀色 hint，明显区别于"已就绪可复制"。*/
.dsh-helper-pulse-pop-current{display:flex;align-items:center;gap:6px;width:calc(100% - 4px);margin:0 2px 6px;box-sizing:border-box;border:1px dashed color-mix(in srgb,var(--dsw-alias-border-l2) 70%,transparent);background:color-mix(in srgb,var(--dsw-alias-bg-layer-2) 60%,transparent);color:inherit;font:inherit;padding:5px 8px;border-radius:8px;cursor:copy;text-align:left}
.dsh-helper-pulse-pop-current:hover{border-color:color-mix(in srgb,var(--dsw-alias-border-l3) 80%,transparent)}
.dsh-helper-pulse-pop-current[data-copied="true"]{border-style:solid;border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 50%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 10%,transparent)}
.dsh-helper-pulse-pop-current[data-pending="true"]{cursor:default;border-style:dotted;background:transparent}
.dsh-helper-pulse-pop-current-label{flex:none;font-size:11px;color:var(--dsw-alias-label-secondary)}
.dsh-helper-pulse-pop-current-title{flex:1;min-width:0;font-size:11.5px;line-height:14px;color:var(--dsw-alias-label-caption);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-helper-pulse-pop-current-hint{flex:none;font-size:11px;color:var(--dsw-alias-label-caption);white-space:nowrap}
.dsh-helper-pulse-pop-current[data-copied="true"] .dsh-helper-pulse-pop-current-hint{color:var(--dsw-alias-state-success-primary)}
.dsh-helper-pulse-pop-current[data-pending="true"] .dsh-helper-pulse-pop-current-hint{color:var(--dsw-alias-state-warn-primary)}
/* 活动态动效：一段高亮沿心电图路径滚动（走纸／监护仪扫过那一下），只对有活动或有待看时生效；
   pathLength=100 让这里的 100 就是"整条路径"，不必知道真实长度。空闲（灰）时是静止实线。
   参数（用户 2026-09-15 调过两轮）：高亮约占一半路径、1.2s 跑完一圈 —— 想再调就改这两个数。
   注意别把高亮调到接近 100：暗段太短就看不出"在滚动"了。 */
@keyframes dsh-helper-pulse-scan{from{stroke-dashoffset:100}to{stroke-dashoffset:0}}
.dsh-helper-pulse[data-on="true"] path{stroke-dasharray:48 52;animation:dsh-helper-pulse-scan 1.2s linear infinite}
@media (prefers-reduced-motion:reduce){.dsh-helper-pulse[data-on="true"] path{animation:none;stroke-dasharray:none}}
/* 宿主布局层用 -webkit-app-region:drag 划了窗口拖动区，落在其中的元素收不到鼠标事件。
   官方各客户端包都给自己的交互元素补了 no-drag，本插件此前漏了 —— 症状是
   「按钮只有边缘一小块能点」（2026-09-29 用户实测）。这里对徽章、面板、刷新按钮统一声明。 */
.dsh-helper-pulse,.dsh-helper-pulse-pop,.dsh-helper-refresh{-webkit-app-region:no-drag}
`;
