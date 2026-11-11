/**
 * 界面外观：把 macOS 桌面端那层窗口毛玻璃（系统原生 vibrancy）盖掉。
 *
 * 这层毛玻璃不是插件画的，也不是纯 CSS 模糊，而是**原生窗口材质**：桌面端在 macOS 上
 * 创建窗口时写死了（app.asar 内 `lib/main.js` 的 createWindow）
 *
 *   titleBarStyle: "hiddenInset", vibrancy: "sidebar",
 *   visualEffectState: "active", backgroundColor: "#00000000"
 *
 * 也就是整窗底下铺一层 NSVisualEffectView，窗口底色全透明；渲染层再配合让开底色：
 *
 *   · 官方 base.css：`html[data-platform=darwin], html[data-platform=darwin] body{background:transparent}`
 *     （`data-platform` 只由桌面端 preload 设置，浏览器里访问同一个 GUI 不会有）
 *   · dsh-client-ui-layout：`[data-platform=darwin] .frame{background:none}`，
 *     侧栏列只填 40%（深色 50%）不透明的 `--dsw-specific-sidebar-fill`，
 *     主内容列与右栏则是不透明的 `--dsw-alias-bg-base`
 *
 * 所以"毛玻璃"只出现在左侧栏（和它顶上那片窗口装饰带），右侧永远是纯色。
 * 宿主**没有**提供开关，也没有环境变量能关：主进程只在窗口最小化/隐藏时临时
 * `setVibrancy(null)`，恢复时又切回来。
 *
 * 这里走纯 CSS 遮挡，而不是去改主进程：改 app.asar 里的 main.js 会破坏 App 的
 * 代码签名、影响自动更新，每次升级都得重做。遮挡法零侵入、可逆，关掉开关即回到官方外观。
 *
 * 只在 macOS 桌面端有实际效果；浏览器/非 macOS 平台本来就没有这层材质，开关无害但也无感。
 */
import React from "react";
import { Row } from "./ui.jsx";
import { createPreference } from "./prefs.js";

/**
 * 打在 `<html>` 上的开关属性。
 *
 * 值取 `"on"` / `"off"` 而不是"有属性即生效"：一来幂等（重复同步不会来回摘挂属性），
 * 二来 Node 侧冒烟的假 DOM 只需要实现 setAttribute 就能断言，不必再补 removeAttribute。
 */
const FLAT_ATTR = "data-dsh-helper-flat";

/** localStorage 键。前缀是本插件包名，与提示音那几个键同一套命名。 */
const FLAT_KEY = "dsh-helper:appearance:flat-surface";

/**
 * 注入的样式。
 *
 * 1) 窗口底：给 body 铺不透明实色。官方 base.css 让 html / body / #root 都是满高（height:100%）
 *    且无外边距，body 铺满整个视口，底下那层原生模糊就被完全遮住。
 *    `--dsw-alias-bg-base` 定义在 **body** 上（浅色 `#fff` / 深色 bluish-950，深色由
 *    `body[data-ds-dark-theme]` 重绑），所以规则写在 body 上才解析得到它，主题也跟着走。
 * 2) 侧栏列：还原成官方**非 macOS 平台**的实色填充与那条 0.5px 分隔线
 *    （`--dsw-specific-sidebar-fill` 同样定义在 body 上，侧栏列是它的后代，取得到）。
 *    类名是 CSS Modules 哈希（形如 `P9Gu9a_sidebarCol`），只能按稳定的后缀匹配；
 *    哪天官方改名，这条就降级失效 —— 毛玻璃照样消失（第 1 条在起作用），
 *    只是侧栏底色仍是官方那层 40% 的淡色，不至于让功能坏掉。
 *
 * 两处都带 `!important`：官方那两条 darwin 规则的特异性与我们同级（顺序也能赢，
 * 因为插件的 style 标签是页面加载后才追加到 head 末尾的），显式写死等于不赌加载顺序。
 *
 * 规则一律紧凑写成「选择器{声明}」且注释里不出现花括号：client-smoke 直接用正则数规则条数，
 * 注释里留一个 `{...}` 就会把计数搅乱。
 */
export const APPEARANCE_CSS = `
html[${FLAT_ATTR}="on"] body{background:var(--dsw-alias-bg-base, #fff) !important}
html[${FLAT_ATTR}="on"] [class*="_sidebarCol"]{background:var(--dsw-specific-sidebar-fill, transparent) !important;border-right:0.5px solid var(--dsw-alias-border-l3, rgba(128, 128, 128, 0.25)) !important}
`;

/** 偏好：默认关（保持官方外观，不给别人换脸）。 */
const flatPref = createPreference(FLAT_KEY, (raw) => raw === "true", false);

/**
 * 当前是不是「会出毛玻璃」的环境。
 *
 * `data-platform=darwin` 只由桌面端 preload 打（见 dsh-web-frontend 的 base.css 约定），
 * 浏览器里访问同一个 GUI 时它不存在 —— 那种环境本来就没有原生材质。
 * Node 侧渲染冒烟没有 document，所以整段都要能安全返回。
 */
function isDarwinDesktop() {
  if (typeof document === "undefined") return false;
  return document.documentElement?.dataset?.platform === "darwin";
}

/** 注入样式表（一次，随插件卸载移除）。 */
/** 注入样式表；返回撤销它的函数（幂等）。理由与 sidebar-glow 那份一致：注入与移除要成对。 */
function ensureStyle() {
  const tagId = `${FLAT_ATTR}.css`;
  const existing = document.querySelector(`style[data-plugin-css="${tagId}"]`);
  if (existing !== null) return () => existing.remove();
  const tag = document.createElement("style");
  tag.dataset.plugin = "dsh-helper";
  tag.dataset.pluginCss = tagId;
  tag.textContent = APPEARANCE_CSS;
  document.head.appendChild(tag);
  return () => tag.remove();
}

/** 把当前偏好写到 <html> 上：CSS 全部挂在 `data-dsh-helper-flat="on"` 下。 */
function syncAttribute() {
  document.documentElement.setAttribute(FLAT_ATTR, flatPref.read() ? "on" : "off");
}

/**
 * 擦掉写在 <html> 上的那个属性。
 *
 * `<html>` 是宿主的节点，组件卸载不会带走它。不清的话插件卸载后宿主页面仍挂着
 * `data-dsh-helper-flat` —— 样式表已经摘了所以看不出问题，但下次任何插件用到同名属性
 * 就会撞上这份残留，而这类问题从现象反推几乎不可能。
 */
function clearAttribute() {
  document.documentElement.removeAttribute(FLAT_ATTR);
}

/* -------------------------------------------------------------- 设置面板 */

/** 「关闭侧栏毛玻璃」那颗开关（渲染在插件信息页的设置卡片里）。 */
export function AppearanceSettings() {
  const flat = flatPref.use();
  const darwin = isDarwinDesktop();

  // 外层容器与卡片标题交给设置卡片（index.jsx 的 Card「界面外观」），这里只出内容。
  return React.createElement(React.Fragment, null,
    React.createElement(Row, {
      title: "关闭侧栏毛玻璃",
      hint: darwin
        ? "macOS 桌面端的窗口底下是一层系统原生毛玻璃（Electron vibrancy），官方左侧栏只填 40% 不透明色，"
          + "所以只有左边那一条能透出模糊。打开后窗口底改为不透明实色、侧栏还原成实色填充并补回 0.5px 分隔线，"
          + "模糊完全消失；宿主本身没有这个开关，这里是纯样式覆盖，随时可以关回去。"
        : "当前环境（浏览器或非 macOS 桌面端）本来就没有这层原生毛玻璃，这个开关不会改变外观；"
          + "它在 macOS 桌面端 App 里才起作用。",
      checked: flat,
      onToggle: () => flatPref.write(!flat),
    }),
  );
}

/* ------------------------------------------------------------------ 装配 */

/**
 * 装进宿主插件的 apply：注入样式、同步偏好、订阅偏好与跨标签页变化。
 * 设置界面由插件信息页的设置卡片渲染（见 index.jsx）。
 *
 * @param ctx - 客户端 cordis 上下文。
 */
export function installAppearance(ctx) {
  ctx.effect(() => {
    // 与 installGlow 同一个修法：注入必须写在 effect 里面，卸载时 cordis 才会跑清理。
    // 原先这两句在 effect 外面，插件卸载后样式标签与 <html> 上的属性会一直留着。
    const removeStyle = ensureStyle();
    syncAttribute();
    const unsubscribe = flatPref.subscribe(syncAttribute);
    const onStorage = (event) => {
      if (event.key === flatPref.key) flatPref.invalidate();
    };
    window.addEventListener("storage", onStorage);
    return () => {
      unsubscribe();
      window.removeEventListener("storage", onStorage);
      clearAttribute();
      removeStyle();
    };
  }, "dsh-helper: 外观样式与偏好同步");
}
