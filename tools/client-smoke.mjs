/**
 * 客户端产物的运行期冒烟：在 Node 里模拟 DSH 的 `window.__ModuleLoader__`，
 * 真执行 `lib/client.js` 的 factory，再用一个假的客户端 cordis 上下文调 apply()，
 * 最后用假 React 真跑一遍观察组件，断言工作区行的标记行为。
 *
 * 这套测试原本长在 dsh-sidebar-glow 里；呼吸灯并入 dsh-helper 时一并搬过来，
 * 测的就是合并后这一份产物（辅助补丁的设置卡片只在插件信息页渲染，
 * 这里把它的槽位注册与两个视图的渲染结果一起断言）。
 *
 * 挡的是最隐蔽的一类失败：产物能打包、能过文本断言，但装进浏览器后
 * slot 没注册、或者标记逻辑算错（那种错误在界面上只表现为「没反应」）。
 *
 * 假 React 让 useEffect 同步执行，所以这里能真正验证 collectActiveIds +
 * applyMarks 的结果，而不是只验"函数被调用了"。
 *
 * ⚠️ **验证优先级：先静默，再浏览器**（2026-09-25 的教训）。
 * 能在 Node 里判定的东西就别开浏览器：读源码 / 读产物 / 用假 DOM 渲染，成本低、能进 CI、
 * 失败信息也精确。真需要看渲染结果时优先跑 tools/render-smoke.mjs（它也是静默的）。
 * 只有"必须在真实浏览器里看"的场景（例如真实网关 + 真实槽位）才动 agent-browser，
 * 且**用 headless**（`--headless=new` 起 Chrome），不要弹可见窗口 —— 那会打断用户手上的活。
 * 这条规矩是被一次真实事故逼出来的：样式表里的孤儿注释残体让 `.dsh-helper-sched{display:flex}`
 * 整条作废，两栏变成上下堆叠，而我当时先去开了浏览器才想到读文本就能查出来。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const MARK_ATTR = "data-dsh-glow";
const UNREAD_ATTR = "data-dsh-glow-unread";

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

/* ------------------------------------------------------------ 假 React */

const cleanups = [];
/**
 * 极简的 hook 状态存储：WeakMap<组件类型, 槽位数组>。
 *
 * 为什么要它：设置卡片读完 host 配置后会 `setSettings(...)`，而这个冒烟是**手动渲染**
 * （没有调度器），所以断言得能"渲染 → 让 Promise 落地 → 再渲染"看到配置就绪那一版。
 * 没有状态的话第二次渲染拿到的还是 null，「六张卡片里到底谁归谁」这类结构断言就测不了。
 * 与 React 同一个约定：同一个组件的 hook 调用顺序必须稳定，槽位按下标对应。
 */
const hookStates = new WeakMap();
let currentType = null;
let hookIndex = 0;
const React = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  useEffect: (fn) => {
    const cleanup = fn();
    if (typeof cleanup === "function") cleanups.push(cleanup);
  },
  useRef: (initial) => ({ current: initial }),
  useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
  useState: (initial) => {
    const fallback = typeof initial === "function" ? initial() : initial;
    if (currentType === null) return [fallback, () => {}];
    let slots = hookStates.get(currentType);
    if (slots === undefined) { slots = []; hookStates.set(currentType, slots); }
    const index = hookIndex++;
    if (!(index in slots)) slots[index] = fallback;
    const set = (next) => { slots[index] = typeof next === "function" ? next(slots[index]) : next; };
    return [slots[index], set];
  },
  useCallback: (fn) => fn,
};
React.default = React;
React.__esModule = true;

/* ------------------------------------------------- 官方 primitives 的测试桩 */

/**
 * `@deepseek-ai/dsh-client-ui-primitives` 的桩。
 *
 * 为什么不装真包：真组件自带 CSS Modules 与 react 依赖，在假 React 下渲染不了；这里只需要
 * 「官方控件被用上了、参数正确」这个事实 —— 桩把每次调用记下来，供下面的断言逐条核对。
 */
const primitiveCalls = [];
const primitivesStub = {
  Switch: (props) => {
    primitiveCalls.push({ name: "Switch", label: props?.label, checked: props?.checked === true, disabled: props?.disabled === true });
    return React.createElement("span", {
      "data-primitive": "Switch",
      "data-checked": props?.checked === true,
      "data-label": props?.label,
    });
  },
  Button: (props) => {
    primitiveCalls.push({ name: "Button", label: typeof props?.children === "string" ? props.children : "", disabled: props?.disabled === true });
    return React.createElement("button", {
      "data-primitive": "Button",
      "data-disabled": props?.disabled === true,
    }, props?.children);
  },
  // 投递口令那一项要用它，并且必须是 password 型：口令回显成明文等于把秘密摊在屏幕上。
  // 关键 props 一并落到节点上：断言要从**渲染树**里查（见下面那两条 check 的说明），
  // 而不是靠 primitiveCalls 那个全局数组 —— check() 对 async 是立即调用的，
  // 多条渲染设置页的用例并发跑时会互相污染它。
  Input: (props) => {
    primitiveCalls.push({
      name: "Input",
      type: props?.type ?? "text",
      label: props?.["aria-label"] ?? "",
      value: props?.value ?? "",
      placeholder: props?.placeholder ?? "",
    });
    return React.createElement("input", {
      "data-primitive": "Input",
      type: props?.type ?? "text",
      "aria-label": props?.["aria-label"] ?? "",
      "data-value": props?.value ?? "",
      "data-placeholder": props?.placeholder ?? "",
    });
  },
};

/* -------------------------------------------------------------- 假 DOM */

function fakeRow(key) {
  const attrs = new Map([["data-row-key", key]]);
  return {
    attrs,
    getAttribute: (name) => attrs.get(name) ?? null,
    setAttribute: (name, value) => { attrs.set(name, value); },
    removeAttribute: (name) => { attrs.delete(name); },
    matches: () => false,
    querySelector: () => null,
  };
}

function makeDocument(rows) {
  const styleTags = [];
  const htmlAttrs = new Map();
  const cssVars = new Map();
  return {
    styleTags,
    htmlAttrs,
    cssVars,
    head: { appendChild: (tag) => { styleTags.push(tag); } },
    body: {},
    documentElement: {
      // 桌面端 preload 会往 <html> 上打 data-platform（浏览器里没有）。这里按 macOS 桌面端
      // 设成 darwin：外观那组的提示文案正是按它分支的，缺了它测到的就是浏览器那条分支。
      dataset: { platform: "darwin" },
      setAttribute: (name, value) => { htmlAttrs.set(name, value); },
      getAttribute: (name) => htmlAttrs.get(name) ?? null,
      style: { setProperty: (name, value) => { cssVars.set(name, value); } },
    },
    createElement: () => ({ dataset: {}, textContent: "" }),
    querySelector: () => null,
    querySelectorAll: (selector) => (selector.includes("workspace:") ? rows : []),
  };
}

const observers = [];
class FakeMutationObserver {
  constructor(callback) { this.callback = callback; observers.push(this); }
  observe() {}
  disconnect() {}
}

/* ---------------------------------------------------------- 模拟壳环境 */

const rows = [
  fakeRow("workspace:ws-running"),
  fakeRow("workspace:ws-pending"),
  fakeRow("workspace:ws-idle"),
  fakeRow("workspace:ws-unknown"),
  fakeRow("workspace:"),
  fakeRow("workspace:ws-unread"),
  fakeRow("workspace:ws-archived-unread"),
  fakeRow("workspace:ws-mixed"),
];
const document = makeDocument(rows);
const storage = new Map();

globalThis.document = document;
globalThis.MutationObserver = FakeMutationObserver;
globalThis.requestAnimationFrame = () => 1;
globalThis.cancelAnimationFrame = () => {};
globalThis.window = {
  document,
  localStorage: {
    getItem: (key) => (storage.has(key) ? storage.get(key) : null),
    setItem: (key, value) => { storage.set(key, value); },
  },
  addEventListener: () => {},
  removeEventListener: () => {},
};

/* ------------------------------------------------------------- 加载产物 */

const text = readFileSync(join(REPO, "lib", "client.js"), "utf8");
let factory;
globalThis.window.__ModuleLoader__ = {
  load: (entry) => { factory = entry.factory; },
};
// 产物以 window.__ModuleLoader__.load(...) 结尾，直接求值即可。
new Function("window", "document", "MutationObserver", "requestAnimationFrame", "cancelAnimationFrame", text)(
  globalThis.window, document, FakeMutationObserver, globalThis.requestAnimationFrame, globalThis.cancelAnimationFrame,
);

const registered = [];
const injected = [];
const ctx = {
  effect: (fn) => { const cleanup = fn(); return cleanup; },
  slots: {
    inject: (name, contribute) => { injected.push(name); contribute(); },
    register: (options, component) => { registered.push({ options, component }); return () => {}; },
  },
};

let app;
check("产物导出 apply()", () => {
  assert.ok(factory !== undefined, "factory 未被 __ModuleLoader__.load 注册");
  // factory 返回的是 module.exports 的值，也就是 exports 对象本身。
  app = factory((id) => {
    if (id === "react") return React;
    if (id === "@deepseek-ai/dsh-client-ui-primitives") return primitivesStub;
    throw new Error(`未预期的 require：${id}`);
  });
  assert.equal(typeof app.apply, "function", "apply 不是函数");
});

check("apply() 不抛错", () => { app.apply(ctx); });

check("apply 分阶段降级：某个扩展点抛错不能让 entry FAILED（那会让整个 GUI 打不开）", () => {
  // 客户端插件 entry 一旦变成 FAILED，宿主的启动审计（`web boot: N entry did not activate`）
  // 会让**整个 Web GUI** 停在 "Failed to load plugins" 页，mountClient 根本不执行。
  // 一个可选的呼吸灯、一声提示音、或某个槽位在某个宿主版本上不兼容，不该有这种后果 ——
  // 所以 apply 里每一步都包在 stage() 里：失败只记日志并降级。
  // 这条用一个"所有槽位注册都抛"的 ctx 去撞它：apply 必须照常返回，且每一步都试过。
  const mod = freshModule();
  let attempts = 0;
  const logged = [];
  const originalError = console.error;
  console.error = (...args) => { logged.push(args.map((a) => String(a)).join(" ")); };
  try {
    mod.apply({
      effect: () => {},
      slots: {
        inject: () => {
          attempts += 1;
          throw new Error("这个宿主版本没有这个槽位");
        },
        register: () => () => {},
      },
      get: () => undefined,
    });
  } finally {
    console.error = originalError;
  }
  // 走到这里就说明 apply 没把异常抛给宿主（抛了的话这条 check 直接红）。
  assert.ok(attempts >= 4, `每个槽位都要尝试过（呼吸灯/提示音/侧栏/主面板/设置卡片/重启按钮），实际只试了 ${attempts} 次`);
  assert.ok(
    logged.some((line) => line.includes("已降级")),
    `失败必须出声并说明已降级，否则就是静默失效换了个地方发生：${logged.join(" | ") || "（什么都没记）"}`,
  );
  assert.ok(
    logged.some((line) => line.includes("呼吸灯")) && logged.some((line) => line.includes("侧栏定时任务入口")),
    `日志要带上阶段名，便于定位是哪一步坏的：${logged.join(" | ")}`,
  );
});

check("注册了 shell.overlay / plugins.bundle.config / settings.action / 标题栏 utilities", () => {
  const names = registered.map((entry) => entry.options.name).sort();
  assert.deepEqual(names, [
    "conversation.session.header.utilities", // 活跃指示（会话标题栏那枚心电图）
    "conversation.session.header.utilities", // 刷新按钮（与心电图同排；2026-09-29 从浮层面板里挪出来）
    "main",                    // 定时任务管理页（右侧主区域，keyed 面板）
    "plugins.bundle.config",
    "settings.action",
    "shell.overlay",           // 呼吸灯
    "shell.overlay",           // 完成提示音（两个常驻观察者各占一条，list 槽位允许）
    "sidebar.panellist",       // 定时任务侧栏入口（「新会话」正下方那一组）
  ]);
  assert.ok(injected.includes("shell.overlay"), "未等待 shell.overlay 槽位");
  assert.ok(injected.includes("plugins.bundle.config"), "未等待 plugins.bundle.config 槽位");
  assert.ok(injected.includes("conversation.session.header.utilities"), "未等待标题栏 utilities 槽位");
});

check("设置卡片挂在插件信息页，且 key 就是本 bundle 的包名", () => {
  const cards = registered.filter((entry) => entry.options.name === "plugins.bundle.config");
  assert.equal(cards.length, 1, "只该注册一张插件设置卡片");
  // 宿主拿这个槽位的 key 集合判断 bundle 有没有配置可展示（详情页的 configured）：
  // key 与包名对不上，卡片就不会出现在插件信息页上。
  assert.equal(cards[0].options.key, "dsh-helper", "key 必须是包名");
});

check("不再自建设置分区：设置里不出现 settings.section", () => {
  const sections = registered.filter((entry) => entry.options.name === "settings.section");
  assert.equal(sections.length, 0, "官方要求插件设置落在插件信息页，不该再单开分区");
});

check("注入四份样式表：呼吸灯（含三种风格关键帧）+ 定时任务 + 界面外观 + 活跃指示", () => {
  // 呼吸灯是第一份（installGlow 先跑），所以下面沿用 styleTags[0] 的断言仍然成立。
  // 界面外观与活跃指示故意排在最后（apply 里在 installScheduleStyles 之后）——按下标断言的脚本
  // 插到中间会张冠李戴，所以这个顺序不是随手写的。
  assert.equal(document.styleTags.length, 4, `期望 4 个 style 标签（呼吸灯 + 定时任务 + 界面外观 + 活跃指示），实际 ${document.styleTags.length}`);
  assert.match(document.styleTags[1].textContent, /dsh-helper-sched-ruleRows/, "缺少定时任务样式");
  const css = document.styleTags[0].textContent;
  assert.match(css, /dsh-sidebar-glow-hue/, "缺少彩色流转风格");
  assert.match(css, /dsh-sidebar-glow-beat/, "缺少脉冲风格");
  assert.match(css, /dsh-sidebar-glow-halo/, "缺少光环风格");
  assert.match(css, /prefers-reduced-motion/, "缺少减弱动效分支");
  assert.match(css, /animation-duration: var\(--dsh-glow-speed/, "彩色流转没接节奏变量");
});

check("界面外观：样式只认开关属性，且覆盖了官方 darwin 那两条规则的落点", () => {
  const css = document.styleTags[2].textContent;
  // 每条规则都必须挂在属性选择器下：不打开开关时样式表一个字都不生效（默认保持官方外观）。
  const rules = [...css.matchAll(/html\[data-dsh-helper-flat="on"\][^{}]*\{[^}]*\}/gu)].map((match) => match[0]);
  assert.equal(rules.length, 2, `期望 2 条规则（窗口底 + 侧栏列），实际 ${rules.length}：${rules.join(" | ")}`);
  for (const rule of rules) {
    assert.match(rule, /!important/, `规则要显式 !important，不赌与官方样式的加载顺序：${rule}`);
  }
  // 官方：base.css 把 darwin 下的 html/body 设为 transparent；ui-layout 让侧栏列只填 40%（深色 50%）
  // 不透明的 --dsw-specific-sidebar-fill。要盖住它们，落点必须正好是 body 与侧栏列。
  assert.match(css, /html\[data-dsh-helper-flat="on"\] body\{[^}]*background:var\(--dsw-alias-bg-base/,
    "窗口底要铺在 body 上（--dsw-alias-bg-base 定义在 body，html 上取不到它，主题会跟不上）");
  assert.match(css, /\[class\*="_sidebarCol"\]/, "侧栏列按稳定后缀匹配（类名是 CSS Modules 哈希，前缀会变）");
  assert.match(css, /border-right:0\.5px solid var\(--dsw-alias-border-l3/,
    "侧栏实色后要补回官方非 macOS 平台那条 0.5px 分隔线");
});

check("界面外观：默认关闭（保持官方毛玻璃），属性写成 on/off 而非摘挂", () => {
  // 默认关是刻意的：没配过的人看到的就是官方外观。
  assert.equal(document.htmlAttrs.get("data-dsh-helper-flat"), "off");
  // 值用 "on"/"off"：幂等，也免得 Node 侧的假 DOM 还要补一个 removeAttribute。
  assert.ok(document.styleTags[2].textContent.includes('data-dsh-helper-flat="on"'),
    "CSS 认的是属性值 on");
});

check("风格开关写到 <html> 上，默认彩色流转", () => {
  assert.equal(document.htmlAttrs.get("data-dsh-glow-style"), "hue");
});

check("节奏写成 CSS 变量，默认中档 2.4s", () => {
  assert.equal(document.cssVars.get("--dsh-glow-speed"), "2.4s");
});

check("光环跟随图标轮廓：用 drop-shadow，且不再画圆形", () => {
  const css = document.styleTags[0].textContent;
  assert.match(css, /drop-shadow/, "光环应当用 drop-shadow 跟随图标轮廓");
  assert.ok(!/border-radius:\s*50%/.test(css), "光环不该再套圆形伪元素");
  assert.ok(!/::before|::after/.test(css), "样式表里已不该有伪元素光环");
});

check("彩色流转带边缘光：drop-shadow 必须排在 hue-rotate 之前", () => {
  const css = document.styleTags[0].textContent;
  const block = /@keyframes dsh-sidebar-glow-hue \{[\s\S]*?\n\}/.exec(css)?.[0];
  assert.ok(block !== undefined, "缺少彩色流转关键帧");
  assert.match(block, /drop-shadow/, "彩色流转应当带边缘光");
  const frame = block.slice(block.indexOf("50%"));
  assert.ok(frame.indexOf("drop-shadow") < frame.indexOf("hue-rotate"),
    "drop-shadow 排在 hue-rotate 之后的话，边缘光不会跟着色相走");
});

check("图标不做缩放：三种风格的关键帧里没有 transform", () => {
  const css = document.styleTags[0].textContent;
  for (const name of ["dsh-sidebar-glow-hue", "dsh-sidebar-glow-beat", "dsh-sidebar-glow-halo"]) {
    // 取整段关键帧（内部百分比块缩进两格，顶层以行首 } 收尾），
    // 免得固定长度窗口串到后面的 @media 里去。
    const block = new RegExp(`@keyframes ${name} \\{[\\s\\S]*?\\n\\}`).exec(css)?.[0];
    assert.ok(block !== undefined, `缺少 ${name}`);
    assert.ok(!block.includes("transform"), `${name} 里不该有 transform（图标大小必须恒定）`);
  }
});

check("两个常驻观察者各注册一次：呼吸灯 + 完成提示音", () => {
  // shell.overlay 是 list 槽位（不是 single），所以两块功能各挂一个观察组件是允许的；
  // 但它们必须**各自只注册一次** —— 重复注册会画出第二个观察者，表现成提示音响两声。
  const overlays = registered.filter((entry) => entry.options.name === "shell.overlay");
  assert.equal(overlays.length, 2, `期望两个 overlay 观察组件，实际 ${overlays.length}`);
  assert.deepEqual(
    overlays.map((entry) => entry.options.id).sort(),
    ["dsh-helper-glow", "dsh-helper-sound"],
  );
});

check("未读的橙色只在折叠时生效，且压过呼吸动画", () => {
  const css = document.styleTags[0].textContent;
  const rule = /:root \[data-dsh-glow-unread\]\[aria-expanded="false"\] > span:first-child\s*\{[^}]*\}/.exec(css)?.[0];
  assert.ok(rule !== undefined, "缺少未读的橙色规则（折叠判断应交给 aria-expanded）");
  assert.match(rule, /--dsw-alias-state-warn-primary/, "未读应当用主题的 warn 色（amber 橙）");
  const svgRule = /:root \[data-dsh-glow-unread\]\[aria-expanded="false"\] > span:first-child svg\s*\{[^}]*\}/.exec(css)?.[0];
  assert.ok(svgRule !== undefined, "缺少未读覆盖动画的规则");
  assert.match(svgRule, /animation: none/, "未读要停掉呼吸动画，橙色才会稳定可见");
  assert.match(svgRule, /filter: none/, "未读要清掉光环/色相滤镜");
});

/* ------------------------------------------------------- 真跑观察组件 */

const statuses = new Map([
  ["s-running", { running: true }],
  ["s-pending", { running: false, pendingInteraction: { kind: "approval" } }],
  ["s-idle", { running: false }],
  // 未读 = 会话在主视图外停下来等你确认，对应官方会话行上那颗绿点。
  ["s-unread", { running: false, completionUnread: true }],
  ["s-archived-unread", { running: false, completionUnread: true }],
  ["s-mixed-running", { running: true, completionUnread: false }],
  ["s-mixed-unread", { running: false, completionUnread: true }],
]);
const workspaces = {
  items: [
    { workspaceId: "ws-running", sessionIds: ["s-running"] },
    { workspaceId: "ws-pending", sessionIds: ["s-pending"] },
    { workspaceId: "ws-idle", sessionIds: ["s-idle"] },
    { workspaceId: "ws-unknown", sessionIds: ["s-missing"] },
    { workspaceId: "ws-unread", sessionIds: ["s-idle", "s-unread"] },
    { workspaceId: "ws-archived-unread", sessionIds: ["s-archived-unread"] },
    { workspaceId: "ws-mixed", sessionIds: ["s-mixed-running", "s-mixed-unread"] },
  ],
  // 归档的会话不算未读：官方对归档行不画状态点。
  archivedSessionIds: ["s-archived-unread"],
};

/** 假 React 的 createElement 只产出描述对象，这里手动执行函数组件（真 React 渲染时会这么做）。 */
function render(element) {
  return typeof element.type === "function" ? element.type(element.props) : element;
}

function renderWatcher() {
  const entry = registered.find((item) => item.options.name === "shell.overlay");
  return render(entry.component({
    useSessionStatus: (selector) => selector(statuses),
    useWorkspaces: (selector) => selector(workspaces),
  }));
}

check("观察组件返回隐藏占位节点", () => {
  const node = renderWatcher();
  assert.equal(node.props.style.display, "none");
  assert.equal(node.props["aria-hidden"], true);
});

check("运行中的工作区被打标", () => {
  assert.ok(rows[0].attrs.has(MARK_ATTR), "ws-running 应被标记");
});

check("等待交互的工作区被打标", () => {
  assert.ok(rows[1].attrs.has(MARK_ATTR), "ws-pending 应被标记");
});

check("仅有空闲会话的工作区不打标", () => {
  assert.ok(!rows[2].attrs.has(MARK_ATTR), "ws-idle 不该被标记");
});

check("会话状态缺失的工作区不打标", () => {
  assert.ok(!rows[3].attrs.has(MARK_ATTR), "ws-unknown 不该被标记");
});

check("未分组那一行不打标", () => {
  assert.ok(!rows[4].attrs.has(MARK_ATTR), "未分组不该被标记");
  assert.ok(!rows[4].attrs.has(UNREAD_ATTR), "未分组也不该有未读标记");
});

check("有未读会话的工作区被打上未读标记", () => {
  assert.ok(rows[5].attrs.has(UNREAD_ATTR), "ws-unread 应被标记为未读");
  assert.ok(!rows[5].attrs.has(MARK_ATTR), "ws-unread 没有活动会话，不该有呼吸标记");
});

check("归档会话的未读不算未读", () => {
  assert.ok(!rows[6].attrs.has(UNREAD_ATTR), "归档会话不该点亮文件夹");
});

check("活动与未读是两个独立标记，可以同时存在", () => {
  assert.ok(rows[7].attrs.has(MARK_ATTR), "ws-mixed 有在跑的会话，应标活动");
  assert.ok(rows[7].attrs.has(UNREAD_ATTR), "ws-mixed 也有未读会话，应标未读");
});

check("没有未读的工作区不被打未读标记", () => {
  for (const [index, name] of [[0, "ws-running"], [1, "ws-pending"], [2, "ws-idle"]]) {
    assert.ok(!rows[index].attrs.has(UNREAD_ATTR), `${name} 不该有未读标记`);
  }
});

check("关掉开关后标记被撤销", () => {
  storage.set("dsh-sidebar-glow:enabled", "false");
  // 开关是懒读缓存的，换一个全新的模块实例来模拟重新挂载。
  cleanups.length = 0;
  const before = rows.map((row) => row.attrs.has(MARK_ATTR));
  assert.ok(before[0], "前置条件：开关打开时应有标记");
  const fresh = readFileSync(join(REPO, "lib", "client.js"), "utf8");
  let freshFactory;
  globalThis.window.__ModuleLoader__ = { load: (entry) => { freshFactory = entry.factory; } };
  new Function("window", "document", "MutationObserver", "requestAnimationFrame", "cancelAnimationFrame", fresh)(
    globalThis.window, document, FakeMutationObserver, globalThis.requestAnimationFrame, globalThis.cancelAnimationFrame,
  );
  const freshApp = freshFactory((id) => {
    if (id === "react") return React;
    if (id === "@deepseek-ai/dsh-client-ui-primitives") return primitivesStub;
    throw new Error(`未预期的 require：${id}`);
  });
  const freshRegistered = [];
  freshApp.apply({
    effect: () => {},
    slots: {
      inject: (_name, contribute) => contribute(),
      register: (options, component) => { freshRegistered.push({ options, component }); return () => {}; },
    },
  });
  const entry = freshRegistered.find((item) => item.options.name === "shell.overlay");
  render(entry.component({
    useSessionStatus: (selector) => selector(statuses),
    useWorkspaces: (selector) => selector(workspaces),
  }));
  for (const row of rows) {
    assert.ok(!row.attrs.has(MARK_ATTR), "开关关闭后不该留呼吸标记");
    assert.ok(!row.attrs.has(UNREAD_ATTR), "开关关闭后不该留未读标记");
  }
});

/* --------------------------------- 活跃指示（2026-09-28 从 dsh-expert 迁来） */

/**
 * 槽位给组件的 props：会话投影从 `ctx.get("sessions")` 惰查（刻意不写进 cordis inject，
 * 宿主某版本没有这个服务时也不会把整个客户端 entry 拖成 FAILED）。
 */
function pulseProps(byId) {
  const service = {
    list: { subscribe: () => () => {}, getSnapshot: () => ({ phase: "ready", ids: Object.keys(byId), byId }) },
  };
  return {
    ctx: { get: (name) => (name === "sessions" ? service : undefined) },
    pluginCtx: ctx,
    sessionId: "s-main",
    open: () => {},
  };
}

/** 渲染那枚心电图按钮（Fragment 的第一个子节点）；偏好关掉时组件返回 null。 */
function renderPulse(byId, registry = registered) {
  const entry = registry.find((item) => item.options.name === "conversation.session.header.utilities");
  const node = render(entry.component(pulseProps(byId)));
  return node === null ? null : node.children[0];
}

/**
 * 加载一份**全新的模块实例**并返回它的导出。
 *
 * 两个用途：
 *   1. 偏好是懒读缓存的，只有新实例才读得到刚写进 localStorage 的值（freshRegister 用它）；
 *   2. 组件函数是全新的对象 → 假 React 的 hookStates（WeakMap，按组件函数索引）也是全新的，
 *      所以要断言"某个 props 组合下的初始状态"，必须用新实例渲染：拿主实例的话，
 *      useState 的初始值早在前面某条用例里就被记进槽位了，喂什么 props 都不会变。
 */
function freshModule() {
  const fresh = readFileSync(join(REPO, "lib", "client.js"), "utf8");
  let freshFactory;
  globalThis.window.__ModuleLoader__ = { load: (entry) => { freshFactory = entry.factory; } };
  new Function("window", "document", "MutationObserver", "requestAnimationFrame", "cancelAnimationFrame", fresh)(
    globalThis.window, document, FakeMutationObserver, globalThis.requestAnimationFrame, globalThis.cancelAnimationFrame,
  );
  return freshFactory((id) => {
    if (id === "react") return React;
    if (id === "@deepseek-ai/dsh-client-ui-primitives") return primitivesStub;
    throw new Error(`未预期的 require：${id}`);
  });
}

/** 用一份全新的模块实例跑 apply()，返回它注册出来的槽位条目。 */
function freshRegister() {
  const freshApp = freshModule();
  const list = [];
  freshApp.apply({
    effect: () => {},
    slots: {
      inject: (_name, contribute) => contribute(),
      register: (options, component) => { list.push({ options, component }); return () => {}; },
    },
  });
  return list;
}

check("标题栏 utilities 槽注册两枚：心电图 + 刷新按钮，刷新排在它右边", () => {
  const entries = registered.filter((entry) => entry.options.name === "conversation.session.header.utilities");
  assert.equal(entries.length, 2, "该注册两枚：心电图 + 刷新");
  const pulse = entries.find((entry) => entry.options.id === "dsh-helper-pulse");
  const refresh = entries.find((entry) => entry.options.id === "dsh-helper-refresh");
  assert.ok(pulse !== undefined, "缺少心电图");
  assert.ok(refresh !== undefined, "缺少刷新按钮");
  // order 取小 = 排在那排按钮靠前的位置（与在 T专家 里一致）；刷新按钮比它大 = 落在它右边。
  assert.equal(pulse.options.order, 1);
  assert.equal(refresh.options.order, 2);
});

check("活跃指示的样式是第 4 份：类名与关键帧都改用本插件前缀", () => {
  const css = document.styleTags[3].textContent;
  assert.match(css, /\.dsh-helper-pulse\{/, "缺少心电图按钮的样式");
  assert.match(css, /\.dsh-helper-refresh\{/, "缺少标题栏刷新按钮的样式");
  assert.match(css, /\.dsh-helper-refresh[^{]*\{-webkit-app-region:no-drag\}|\.dsh-helper-pulse,\.dsh-helper-pulse-pop,\.dsh-helper-refresh\{-webkit-app-region:no-drag\}/, "刷新按钮必须显式 no-drag：宿主 header 是窗口拖动带，落了进去就点不动");
  assert.match(css, /@keyframes dsh-helper-pulse-scan/, "缺少走纸动效");
  assert.match(css, /prefers-reduced-motion/, "缺少减弱动效分支");
  assert.match(css, /backdrop-filter:var\(--dsw-menu-backdrop-filter/, "浮层材质要带 backdrop-filter（宿主 0.1.7 的半透明菜单材质）");
  assert.ok(!/t-team-pulse/.test(css), "迁过来后不该再留 T专家 的类名前缀，两插件同页会互相覆盖");
});

check("活跃指示：有会话在跑时是彩色的", () => {
  const button = renderPulse({ "s-main": { id: "s-main", displayTitle: "主会话", running: true, updatedAt: 30 } });
  assert.equal(button.props["data-on"], true, "有活动会话时该点亮");
  assert.equal(button.props["aria-expanded"], false, "面板默认关着");
  assert.equal(button.props["aria-label"], "有会话正在活动，或有事等你查看");
});

check("活跃指示：只有子代理在跑，主会话也算活动（与侧栏口径一致）", () => {
  const button = renderPulse({
    "s-main": { id: "s-main", displayTitle: "主会话", running: false, updatedAt: 10 },
    "s-sub": { id: "s-sub", origin: "subagent", running: true, parentId: "s-main", updatedAt: 20 },
  });
  assert.equal(button.props["data-on"], true, "宿主不投影「在跑的子代理数」，这里要自己按 parentId 上溯");
});

check("活跃指示：有待查看的完成提醒也算需要注意", () => {
  const button = renderPulse({ "s-done": { id: "s-done", displayTitle: "待看", running: false, completed: true, updatedAt: 2 } });
  assert.equal(button.props["data-on"], true);
});

check("活跃指示：全空闲时是灰的", () => {
  const button = renderPulse({ "s-idle": { id: "s-idle", displayTitle: "空闲", running: false, completed: false, updatedAt: 1 } });
  assert.equal(button.props["data-on"], false, "没有活动也没有待看时该是灰的");
});

check("活跃指示：「新会话」占位行与子代理行都不进清单", () => {
  const button = renderPulse({
    "s-blank": { id: "s-blank", blank: true, running: true, updatedAt: 9 },
    "s-sub": { id: "s-sub", origin: "subagent", running: true, updatedAt: 8 },
    "s-idle": { id: "s-idle", running: false, completed: false, updatedAt: 1 },
  });
  assert.equal(button.props["data-on"], false, "用户要的是「点开能接上的主会话」，占位行与子代理都不算");
});

/* ---- 会话跳转与分组 key：断言随功能一起从 T专家 的 verify 搬过来（搬家不该丢覆盖） ---- */

// session-nav.js 是纯 ESM、没有 JSX，可以直接 import 真跑，不必从产物里切源码。
const nav = await import(pathToFileURL(join(REPO, "src", "client", "session-nav.js")).href);

check("openHostSession 新宿主走 ctx.get(uiWorkspace).openSession（主会话 id / 子代理地址）", () => {
  const opened = [];
  const viaGet = { get: (name) => (name === "uiWorkspace" ? { openSession: (target) => { opened.push(target); } } : undefined) };
  nav.openHostSession(viaGet, "session-main");
  nav.openHostSession(viaGet, { parentSessionId: "session-parent", childSessionId: "session-child", mode: "continuable" });
  // 未声明 inject 的服务做属性访问会抛：这条路必须被 try/catch 吃掉，否则「点了关面板、会话不动」。
  const throwingGet = new Proxy(viaGet, {
    get(target, prop, receiver) {
      if (prop === "uiWorkspace") throw new Error('cannot get property "uiWorkspace" without inject');
      return Reflect.get(target, prop, receiver);
    },
  });
  nav.openHostSession(throwingGet, "session-via-get");
  assert.deepEqual(opened, [
    "session-main",
    { parentSessionId: "session-parent", childSessionId: "session-child", mode: "continuable" },
    "session-via-get",
  ]);
});

check("openHostSession 标题栏 inject 的 open(id) 优先于自己查服务", () => {
  const opened = [];
  const slotOpened = [];
  const viaGet = { get: (name) => (name === "uiWorkspace" ? { openSession: (target) => { opened.push(target); } } : undefined) };
  nav.openHostSession(viaGet, "session-slot", (id) => { slotOpened.push(id); });
  assert.deepEqual(slotOpened, ["session-slot"]);
  assert.deepEqual(opened, [], "官方 open(id) 能用时不该再自己查服务");
});

check("openHostSession 旧宿主退回 sessions.open / openSubagent", () => {
  const calls = [];
  nav.openHostSession({
    sessions: { open: (id) => calls.push(["open", id]) },
    layout: { selectPanel: () => calls.push(["panel"]) },
  }, "session-old");
  nav.openHostSession({ sessions: { openSubagent: (address) => calls.push(["sub", address]) } }, {
    parentSessionId: "p", childSessionId: "c", mode: "continuable",
  });
  assert.equal(calls[0][0], "open");
  assert.equal(calls[0][1], "session-old");
  assert.equal(calls[1][0], "panel", "旧宿主跳转前要退掉 main 面板，否则看起来像点了没反应");
  assert.equal(calls[2][0], "sub");
  assert.equal(calls[2][1].childSessionId, "c");
});

// 分组 key 算法是纯函数，从产物文本切出来真跑一遍边界（与 T专家 里那条断言等价）。
const owningKeySource = text.match(/function owningWorkspaceKey\(items, sessionId\) \{[\s\S]*?\n\}/u)?.[0] ?? "";
const owningKey = owningKeySource === "" ? null : new Function(`${owningKeySource}; return owningWorkspaceKey;`)();

check("分组 key 与原生算法一致（命中 → workspaceId；未分组 → 空串；取第一个命中项）", () => {
  assert.equal(typeof owningKey, "function", "没能在产物里找到 owningWorkspaceKey");
  // 未分组桶的空串是**真实分组键**（原生 owningGroupKey 同款算法），不能被当成"没找到"。
  assert.equal(owningKey([{ workspaceId: "ws-1", sessionIds: ["a", "b"] }], "b"), "ws-1");
  assert.equal(owningKey([{ workspaceId: "ws-1", sessionIds: ["a"] }], "zzz"), "");
  assert.equal(owningKey([], "a"), "");
  assert.equal(owningKey([{ workspaceId: "ws-1" }], "a"), "");
  assert.equal(owningKey([{ workspaceId: "ws-2", sessionIds: ["a"] }, { workspaceId: "ws-9", sessionIds: ["a"] }], "a"), "ws-2");
});

check("展开分组：数据未就绪不猜、失败不冒泡、已是展开态不重复写", () => {
  const expandSource = text.match(/function expandOwningWorkspaceGroup\(ctx, sessionId\) \{[\s\S]*?\n\}/u)?.[0] ?? "";
  assert.ok(expandSource !== "", "没能在产物里找到 expandOwningWorkspaceGroup");
  assert.ok(!expandSource.includes("throw "), "失败不冒泡（展开只是顺手的体验优化，不能拖累跳转）");
  assert.ok(expandSource.includes("if (!Array.isArray(items) || items.length === 0) return;"),
    "工作区数据未就绪时不猜分组（否则会把「未分组」桶展开并持久化下来）");
  assert.ok(expandSource.includes("groupExpansion?.[key] === true"), "已经是展开态就别再写（store 每写一次都通知订阅者）");
});

check("活跃指示：关掉开关后不再画它（偏好存 localStorage，键带本插件前缀）", () => {
  storage.set("dsh-helper:pulse:enabled", "false");
  try {
    const list = freshRegister();
    const entry = list.find((item) => item.options.name === "conversation.session.header.utilities");
    const node = render(entry.component(pulseProps({ "s-main": { id: "s-main", running: true, updatedAt: 1 } })));
    assert.equal(node, null, "开关关闭时组件应返回 null（不必注销槽位注册）");
  } finally {
    storage.delete("dsh-helper:pulse:enabled");
  }
});

/* --------------------------------------------- 合并后的设置面板（真渲染） */

// 面板里的 host 配置读取走 fetch；这里给一个永远成功的最小桩。
globalThis.fetch = () => Promise.resolve({ ok: true, json: async () => ({}) });

/** 递归求值函数组件，直到拿到宿主元素树——假 React 只做一层是不够的。 */
function renderTree(element, depth = 0) {
  if (depth > 30 || element === null || element === undefined) return element;
  // 数组要先摊平：JSX 里 `{children}` 传到组件内部会是一个**嵌套数组**，不摊平就整块丢掉
  // （2026-09-28 卡片的子元素正是这么传的：卡片渲染出来了、里面的行却是空的）。
  if (Array.isArray(element)) return element.map((item) => renderTree(item, depth + 1));
  if (typeof element.type === "function") {
    // 假 React 的 createElement 把 children 放在 element.children 上（真 React 是 props.children），
    // 渲染函数组件时必须补回去 —— 否则「用 children 给函数组件传文案」的写法（例如按钮文字）
    // 在测试里会凭空消失：组件本身没毛病，是 harness 没把 children 交给它。
    const children = element.children ?? [];
    const props = children.length === 0 ? element.props : { ...element.props, children };
    // 渲染期间标记「当前是哪个组件」，让 useState 能落到它自己的槽位上。
    const savedType = currentType;
    const savedIndex = hookIndex;
    currentType = element.type;
    hookIndex = 0;
    let rendered;
    try {
      rendered = element.type(props);
    } finally {
      currentType = savedType;
      hookIndex = savedIndex;
    }
    return renderTree(rendered, depth + 1);
  }
  const children = element.children ?? [];
  if (children.length === 0) return element;
  return { ...element, children: children.map((child) => renderTree(child, depth + 1)) };
}

/** 收集渲染结果里出现过的所有文本。 */
function collectText(node, out = []) {
  if (typeof node === "string") { out.push(node); return out; }
  if (Array.isArray(node)) { for (const item of node) collectText(item, out); return out; }
  if (node === null || node === undefined) return out;
  if (Array.isArray(node.children)) for (const child of node.children) collectText(child, out);
  return out;
}

/** 收集渲染结果里所有显式的 fontSize。 */
function collectFontSizes(node, out = []) {
  if (node === null || node === undefined || typeof node === "string") return out;
  if (Array.isArray(node)) { for (const item of node) collectFontSizes(item, out); return out; }
  const size = node.props?.style?.fontSize;
  if (size !== undefined) out.push(size);
  if (Array.isArray(node.children)) for (const child of node.children) collectFontSizes(child, out);
  return out;
}

check("设置卡片用 page 视图渲染，呼吸灯与界面外观都是它里面的组", () => {
  const card = registered.find((entry) => entry.options.name === "plugins.bundle.config");
  const tree = renderTree(card.component({ view: "page" }));
  const texts = collectText(tree).join(" / ");
  assert.ok(texts.includes("文件投递"), `卡片里应有「文件投递」分组标题，实际文本：${texts}`);
  assert.ok(texts.includes("活动呼吸灯"), `面板里应出现呼吸灯总开关，实际文本：${texts}`);
  assert.ok(texts.includes("提示风格") && texts.includes("节奏"), `面板里应出现风格与节奏，实际文本：${texts}`);
  assert.ok(texts.includes("界面外观"), `面板里应出现「界面外观」分组标题，实际文本：${texts}`);
  assert.ok(texts.includes("关闭侧栏毛玻璃"), `面板里应出现「关闭侧栏毛玻璃」开关，实际文本：${texts}`);
  // 活跃指示（从 T专家 迁来）：开关与说明都在，且说明里要交代那枚图标是什么。
  assert.ok(texts.includes("显示活跃指示"), `面板里应出现「显示活跃指示」开关，实际文本：${texts}`);
  assert.ok(texts.includes("心电图"), `说明里应交代那枚心电图图标的含义，实际文本：${texts}`);
  // 假 DOM 的 documentElement.dataset.platform 已设成 darwin，所以这里该拿到桌面端那条文案
  // （换句话说：如果提示只写了浏览器分支，这条断言会红）。
  assert.ok(texts.includes("原生毛玻璃"), `macOS 桌面端应看到说明毛玻璃来由的那段文案，实际文本：${texts}`);
  // host 侧那半（配置还没读回来时先行渲染）也要在。
  assert.ok(texts.includes("允许把文件投递到 IM") || texts.includes("正在读取…"),
    `host 配置那半应一并渲染，实际文本：${texts}`);
});

check("设置卡片含定时任务总开关（scheduleEnabled 已接线）", () => {
  // 回归点：引擎一直有 setArmed，但设置页没有入口、apply 写死 armed:true——
  // 用户没法整体停用定时触发。接线后：卡片多一颗开关，面板在 armed=false 时显示明确提示。
  // 注意：esbuild 默认 charset=ascii，中文串在产物里是 \uXXXX 转义——键名/字段名是 ASCII 直接查，
  // 中文文案查解码后的文本。
  assert.ok(text.includes("scheduleEnabled"), "读写配置时应携带 scheduleEnabled 字段");
  assert.ok(text.includes("sched.armedOff"), "面板应引用总开关停用的文案键");
  const decoded = text.replace(/\\u([0-9a-fA-F]{4})/gu, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)));
  assert.ok(decoded.includes("启用定时任务"), "设置卡片应出现「启用定时任务」开关");
  assert.ok(decoded.includes("定时任务已整体停用"), "面板在总开关关闭时应显示明确提示，而不是只让「立即执行」莫名失败");
});

check("定时任务面板含「最多执行次数」字段（maxRuns 已接线）", () => {
  // 一次性任务靠 maxRuns=1 表达：cron 语法没有年份位，"某年某月某日"只能写成"每年这天"，
  // 靠这个上限把它变成只跑一次。宿主那侧由 host 冒烟盯，这里只盯面板有没有把它露出来。
  assert.ok(text.includes("maxRuns"), "表单与列表要携带 maxRuns 字段");
  const decoded = text.replace(/\\u([0-9a-fA-F]{4})/gu, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)));
  assert.ok(decoded.includes("最多执行次数"), "表单里要出现「最多执行次数」输入框");
  assert.ok(decoded.includes("留空 = 不限次数"), "要有「留空 = 不限次数」的占位提示");
  assert.ok(decoded.includes("限次"), "列表行要能标出限次任务");
});

check("列表行有停用/启用按钮（行内单条切换，位于删除前）", () => {
  // 单条启停不依赖详情表单：patch 只带 enabled（宿主 update 是合并语义，宿主 scheduleOne
  // 顺手挂/摘定时器，总开关关着时挂不上、重新打开自动恢复）。
  assert.ok(text.includes("sched.disable"), "行内应引用「停用」文案键");
  assert.ok(text.includes("sched.enable"), "行内应引用「启用」文案键");
});

check("总开关关闭时：侧栏入口整条注销（不是组件里 return null）", async () => {
  // 回归点：侧栏那行是**宿主渲染**的（宿主拿 options 画行、我们只交图标），所以
  // 「关掉就不显示」只能靠**注销那条注册** —— 组件里 return null 摘不掉它。
  // T专家 原本就是这么做的（scheduleEntryVisible + subscribeUiPrefs），迁到本插件时
  // 只搬了注册、丢了注销，表现成「关了总开关，左侧入口还在」。
  //
  // 这里必须用**全新的模块实例**：总开关是模块级状态，主 harness 那个实例已被前面的
  // 用例摸过，且 apply 的初值读取是异步的（apply 本身保持同步），所以要等一个微任务。
  const mountFresh = async (config) => {
    const source = readFileSync(join(REPO, "lib", "client.js"), "utf8");
    let factory;
    globalThis.window.__ModuleLoader__ = { load: (entry) => { factory = entry.factory; } };
    new Function("window", "document", "MutationObserver", "requestAnimationFrame", "cancelAnimationFrame", source)(
      globalThis.window, document, FakeMutationObserver, globalThis.requestAnimationFrame, globalThis.cancelAnimationFrame,
    );
    const app = factory((id) => {
      if (id === "react") return React;
      if (id === "@deepseek-ai/dsh-client-ui-primitives") return primitivesStub;
      throw new Error(`未预期的 require：${id}`);
    });
    const entries = [];
    globalThis.fetch = () => Promise.resolve({ ok: true, json: async () => config });
    app.apply({
      effect: () => {},
      slots: {
        inject: (_name, contribute) => contribute(),
        register: (options, component) => {
          const entry = { options, component };
          entries.push(entry);
          // dispose 要真的把条目摘掉：否则"注销"这件事在测试里根本观察不到。
          return () => { const index = entries.indexOf(entry); if (index >= 0) entries.splice(index, 1); };
        },
      },
    });
    await new Promise((resolve) => { setTimeout(resolve, 0); });
    return entries;
  };

  const off = await mountFresh({ scheduleEnabled: false });
  assert.equal(
    off.find((item) => item.options.name === "sidebar.panellist"), undefined,
    "总开关关闭时不该注册侧栏入口",
  );
  assert.ok(off.some((item) => item.options.name === "main"), "main 面板与总开关无关，仍应注册");
  assert.ok(
    off.some((item) => item.options.name === "plugins.bundle.config"),
    "设置卡片必须还在——否则用户没有任何入口把它重新打开",
  );

  const on = await mountFresh({ scheduleEnabled: true });
  assert.ok(
    on.find((item) => item.options.name === "sidebar.panellist"),
    "总开关打开时应注册侧栏入口",
  );

  // 读不到配置时按「显示」处理：宁可多一个入口，也不要让用户找不到它。
  const unknown = await mountFresh({});
  assert.ok(
    unknown.find((item) => item.options.name === "sidebar.panellist"),
    "配置读不到或字段缺失时应保持默认显示",
  );

  // 收尾：恢复成文件里原本那个"永远成功但返回空对象"的桩，别影响后面的用例。
  globalThis.fetch = () => Promise.resolve({ ok: true, json: async () => ({}) });
});

check("卡片字号跟宿主对齐：一律显式 px，且不比详情页正文更大", () => {
  const card = registered.find((entry) => entry.options.name === "plugins.bundle.config");
  const sizes = collectFontSizes(renderTree(card.component({ view: "page" })));
  assert.ok(sizes.length > 0, "卡片里应当有显式字号");
  for (const size of sizes) {
    // em / % 会去继承宿主的根字号（插件详情页根字号 16px），比同页正文大一圈。
    assert.match(size, /^\d+(\.\d+)?px$/, `字号必须写死成 px，不能继承：${size}`);
  }
  const scaled = sizes.map((size) => Number.parseFloat(size));
  assert.ok(Math.max(...scaled) <= 14, `最大字号 ${Math.max(...scaled)}px 超过了详情页正文 14px`);
  assert.ok(sizes.includes("13.5px"), "分组标题与行标题应当用详情页正文尺寸 13.5px");
  assert.ok(sizes.includes("12px"), "说明文字应当用 12px");
});

/** 在渲染树里按卡片标题（`section` 的 aria-label）取出那棵子树。 */
function findSection(node, title) {
  if (node === null || node === undefined || typeof node === "string") return null;
  if (Array.isArray(node)) {
    for (const item of node) { const hit = findSection(item, title); if (hit !== null) return hit; }
    return null;
  }
  if (node.type === "section" && node.props?.["aria-label"] === title) return node;
  return Array.isArray(node.children) ? findSection(node.children, title) : null;
}

/** 收集渲染树里所有卡片的标题（顺序即渲染顺序）。 */
function collectSections(node, out = []) {
  if (node === null || node === undefined || typeof node === "string") return out;
  if (Array.isArray(node)) { for (const item of node) collectSections(item, out); return out; }
  if (node.type === "section" && typeof node.props?.["aria-label"] === "string") out.push(node.props["aria-label"]);
  if (Array.isArray(node.children)) for (const child of node.children) collectSections(child, out);
  return out;
}

/** 收集渲染树里满足条件的节点。 */
function collectNodes(node, predicate, out = []) {
  if (node === null || node === undefined || typeof node === "string") return out;
  if (Array.isArray(node)) { for (const item of node) collectNodes(item, predicate, out); return out; }
  if (predicate(node)) out.push(node);
  if (Array.isArray(node.children)) for (const child of node.children) collectNodes(child, predicate, out);
  return out;
}

/** 渲染一次设置卡片并拿到它的元素树（此时 host 配置通常还没读回来）。 */
function renderSettingsCard() {
  const card = registered.find((entry) => entry.options.name === "plugins.bundle.config");
  return renderTree(card.component({ view: "page" }));
}

/**
 * 渲染**配置已就绪**那一版：先渲染一次，等 fetch 桩的 then 落地（setSettings 写进 hook 槽），
 * 再渲染一次。没有这一步就只能看到「正在读取…」——host 侧那三张卡片的行压根不渲染。
 * ⚠️ 状态槽是按组件类型保留的，所以一旦在这里 flush 过，后面的断言渲染到的都是就绪版。
 */
async function renderSettingsCardReady() {
  renderSettingsCard();
  await new Promise((resolve) => { setImmediate(resolve); });
  return renderSettingsCard();
}

check("设置卡片按用途分成六张卡片（顺序 = 渲染顺序）", async () => {
  // 2026-09-28 用户报「功能选项有点乱」：改成一叠卡片，一个用途一张 —— 分组靠容器边界表达，
  // 不再靠一条 0.5px、在浅色主题下几乎看不见的分隔线。
  const sections = collectSections(await renderSettingsCardReady());
  assert.deepEqual(sections,
    ["文件投递", "定时任务", "活动提示", "完成提示音", "界面外观", "宿主操作"],
    sections.join(" / "));
});

check("设置卡片骨架恒定：host 配置没读回来时也渲染六张（打开时不会从 4 张跳成 6 张）", () => {
  // 用一份全新模块实例渲染（状态槽是跨渲染保留的，主实例此时早已是就绪版）。
  const list = freshRegister();
  const entry = list.find((item) => item.options.name === "plugins.bundle.config");
  const sections = collectSections(renderTree(entry.component({ view: "page" })));
  assert.deepEqual(sections,
    ["文件投递", "定时任务", "活动提示", "完成提示音", "界面外观", "宿主操作"],
    sections.join(" / "));
});

check("定时任务开关挪出了「文件投递」卡片（用户报的那个错位）", async () => {
  const tree = await renderSettingsCardReady();
  const file = collectText(findSection(tree, "文件投递")).join(" / ");
  const schedule = collectText(findSection(tree, "定时任务")).join(" / ");
  assert.ok(!file.includes("启用定时任务"), `「文件投递」卡片里不该再有定时任务开关：${file}`);
  assert.ok(schedule.includes("启用定时任务"), `「定时任务」卡片里应有那个开关：${schedule}`);
  // 同理：重启按钮不该再混在文件投递里，它有自己的「宿主操作」卡片。
  assert.ok(!file.includes("重启 DeepSeek Harness"), `「文件投递」卡片里不该有重启开关：${file}`);
  assert.ok(collectText(findSection(tree, "宿主操作")).join(" / ").includes("重启 DeepSeek Harness"),
    "重启开关应当在「宿主操作」卡片里");
});

check("文件投递卡片里有两项**可选**加固（口令 + 目录白名单），默认呈现为「关」", async () => {
  // 2026-09-28 用户口径：「可选 token + 可选路径白名单，默认都关」。
  // 这条盯四件事：
  //   1. 控件还在 —— 0.9.2 刚清过一批零引用导出，新加的控件也可能被后来人当死代码清掉；
  //   2. 文案说清「默认关闭」—— 用户必须知道"不设"等于"不限制"，否则会误以为已经有保护；
  //   3. 口令框是 password 型且不回填明文（host 的 GET/POST 都只回 sendTokenSet 这一个比特）；
  //   4. 既有的 curl 用法要怎么改，界面上就得写出来（请求头名字）。
  const tree = await renderSettingsCardReady();
  const card = findSection(tree, "文件投递");
  assert.ok(card !== null, "要有「文件投递」卡片");
  const text = collectText(card).join(" / ");
  assert.ok(text.includes("HTTP 投递口令（可选）"), `要有口令那一项并标明「可选」：${text}`);
  assert.ok(text.includes("允许投递的目录（可选）"), `要有目录白名单那一项并标明「可选」：${text}`);
  assert.ok(text.includes("默认关闭"), `两项都要说清默认是关的：${text}`);
  assert.ok(text.includes("x-dsh-helper-token"), `要写出请求头名字，用户才知道既有的 curl 该怎么改：${text}`);
  assert.ok(text.includes("当前不限制目录"), `默认状态要明说"现在不限制"，而不是留一片空白让人猜：${text}`);
  assert.ok(text.includes("send_file_to_im"), `要说清工具路径也受白名单限制（否则用户以为只管住了 HTTP）：${text}`);
  // 口令框：官方 Input + password 型 + 不回填。
  // 一律从**渲染树**里查而不是靠 primitiveCalls：那个数组是全局累积的，而 check() 对 async
  // 是立即调用的，多条渲染设置页的用例并发跑时会互相污染它（实测拿到 3 个而不是 1 个）。
  const passwords = collectNodes(card, (node) => node.props?.["data-primitive"] === "Input" && node.props?.type === "password");
  assert.equal(passwords.length, 1, `口令框要走官方 Input 且是 password 型（明文回显等于把秘密摊在屏幕上），实际 ${passwords.length} 个`);
  assert.equal(passwords[0].props["data-value"], "", "绝不能回填口令 —— host 从不把明文发给前端");
  const placeholder = passwords[0].props["data-placeholder"];
  assert.ok(placeholder.includes("留空 = 不启用口令"), `未设口令时占位符要这么说：${placeholder}`);
  // 默认状态下不该有「清除口令」（还没设，清除无从谈起）；设了之后才出现（见下面那条）
  const buttons = collectNodes(card, (node) => node.props?.["data-primitive"] === "Button");
  const labels = buttons.map((node) => collectText(node).join(""));
  assert.ok(labels.includes("保存口令"), `要有「保存口令」按钮：${labels.join(" / ")}`);
  assert.ok(labels.includes("保存目录"), `要有「保存目录」按钮：${labels.join(" / ")}`);
  assert.ok(!labels.includes("清除口令"), `还没设口令时不该出现「清除口令」：${labels.join(" / ")}`);
  // 两颗保存按钮在"没内容可存"时都必须是禁用的：否则误点「保存口令」就等于把口令清掉了
  assert.equal(buttons[labels.indexOf("保存口令")].props["data-disabled"], true,
    "输入框为空时「保存口令」要禁用（否则误点就等于清空口令）");
  assert.equal(buttons[labels.indexOf("保存目录")].props["data-disabled"], true,
    "白名单没改动时「保存目录」要禁用");
});

check("已设口令/白名单后，设置页据实呈现（清除按钮出现、当前限制写得出来）", () => {
  // host 只回 sendTokenSet 这一个比特与白名单列表；界面要凭这两个把状态说清楚，
  // 否则用户设完之后回来看不到任何证据，只能靠"试着发一个文件"去猜。
  //
  // 直接渲染导出的 SettingsCards 并喂 settings，**不碰全局 fetch 桩**：check() 对 async
  // 是立即调用的，换 fetch 会污染同时在渲染设置页的其它用例（实测踩过 —— 上一条用例的
  // 「保存目录」被这份桩里的白名单算成了"有改动"，禁用断言就翻了）。
  // 用全新模块实例：SendHardening 的 useState 初始值要按这份 props 重新算，
  // 拿主实例的话槽位里还是上一条用例留下的空字符串（见 freshModule 的说明）。
  const tree = renderTree(React.createElement(freshModule().SettingsCards, {
    settings: {
      enabled: true, imageAsPicture: true, restartEnabled: true, scheduleEnabled: true,
      backend: "", sendTokenSet: true, sendAllowRoots: ["/Users/me/Downloads", "~/Desktop"],
    },
    pending: false,
    error: "",
    onSave: () => {},
  }));
  {
    const card = findSection(tree, "文件投递");
    assert.ok(card !== null, "要有「文件投递」卡片");
    const text = collectText(card).join(" / ");
    assert.ok(text.includes("已设置"), `设了口令后要说「已设置」：${text}`);
    assert.ok(text.includes("401"), `要说清不带口令的后果是 401：${text}`);
    assert.ok(text.includes("当前允许 2 个目录"), `白名单要写出当前允许的条数：${text}`);
    assert.ok(text.includes("/Users/me/Downloads"), `白名单要逐条列出来，用户才敢改：${text}`);
    // 同上：从渲染树查，不碰全局的 primitiveCalls
    const labels = collectNodes(card, (node) => node.props?.["data-primitive"] === "Button")
      .map((node) => collectText(node).join(""));
    assert.ok(labels.includes("清除口令"), `已设口令后要给出「清除口令」：${labels.join(" / ")}`);
    const passwords = collectNodes(card, (node) => node.props?.["data-primitive"] === "Input" && node.props?.type === "password");
    assert.equal(passwords.length, 1, `仍然只该有一个口令框，实际 ${passwords.length} 个`);
    assert.equal(passwords[0].props["data-value"], "", "即使已设口令，也不能把明文回填进输入框");
    const placeholder = passwords[0].props["data-placeholder"];
    assert.ok(placeholder.includes("已设置（留空 = 不修改）"), `占位符要说明留空不会改动：${placeholder}`);
    // 白名单已有内容时，未改动就不该让「保存目录」可点（与默认态那条一致）
    const buttons = collectNodes(card, (node) => node.props?.["data-primitive"] === "Button");
    const names = buttons.map((node) => collectText(node).join(""));
    assert.equal(buttons[names.indexOf("保存目录")].props["data-disabled"], true,
      "白名单与已保存内容一致时「保存目录」要禁用");
    assert.equal(buttons[names.indexOf("清除口令")].props["data-disabled"], false,
      "已设口令时「清除口令」必须可点（否则用户没法取消这道限制）");
  }
});

check("「活动提示」卡片把活跃指示与呼吸灯收在一起，两行都自带标题", () => {
  // 此前「显示活跃指示」整行没有标题、悬在呼吸灯与提示音之间 —— 也是用户说的"乱"之一。
  const activity = collectText(findSection(renderSettingsCard(), "活动提示")).join(" / ");
  for (const label of ["显示活跃指示", "活动呼吸灯", "提示风格", "节奏"]) {
    assert.ok(activity.includes(label), `「活动提示」卡片里应出现「${label}」：${activity}`);
  }
});

check("开关一律走官方 primitives 的 Switch（不再自绘绿色胶囊）", async () => {
  await renderSettingsCardReady();   // 先让配置就绪，host 侧那几颗开关才会渲染
  primitiveCalls.length = 0;
  renderSettingsCard();
  const labels = primitiveCalls.filter((call) => call.name === "Switch").map((call) => call.label);
  for (const label of [
    "允许把文件投递到 IM", "图片以图片消息发送", "启用定时任务",
    "显示活跃指示", "活动呼吸灯", "对话完成时播放提示音", "只在切走时响",
    "关闭侧栏毛玻璃", "启用「重启 DeepSeek Harness」按钮",
  ]) {
    assert.ok(labels.includes(label), `「${label}」应当由官方 Switch 渲染，实际：${labels.join(" / ")}`);
  }
  // 每颗开关都要带可访问名（官方 Switch 的 label 是必填项，缺了就是无障碍缺陷）。
  for (const call of primitiveCalls.filter((item) => item.name === "Switch")) {
    assert.ok(typeof call.label === "string" && call.label !== "", `开关「${call.label}」缺少可访问名`);
  }
});

check("互斥选项组允许换行（官方 SegmentedControl 不换行，8 个音色会溢出卡片）", () => {
  const groups = collectNodes(renderSettingsCard(), (node) => node.props?.role === "radiogroup");
  assert.equal(groups.length, 4, `音色 / 音量 / 提示风格 / 节奏共四组，实际 ${groups.length}`);
  for (const group of groups) {
    assert.equal(group.props.style.flexWrap, "wrap", "选项组的底槽必须能折行，窄窗口下才不会溢出卡片");
    assert.ok(typeof group.props["aria-label"] === "string" && group.props["aria-label"] !== "",
      "每组选项要有可访问名");
  }
});

check("summary 视图只给一行说明，不摆出整张表单", () => {
  const card = registered.find((entry) => entry.options.name === "plugins.bundle.config");
  const texts = collectText(renderTree(card.component({ view: "summary" }))).join(" / ");
  assert.ok(texts.includes("文件投递") && texts.includes("定时任务开关"), `summary 应给一句说明，实际文本：${texts}`);
  assert.ok(!texts.includes("允许把文件投递到 IM"), `summary 不该渲染设置行，实际文本：${texts}`);
  assert.ok(!texts.includes("提示风格"), `summary 不该渲染呼吸灯那一组，实际文本：${texts}`);
});

check("page 视图不认得 view 缺失时也照常渲染（宿主只传 page）", () => {
  const card = registered.find((entry) => entry.options.name === "plugins.bundle.config");
  const texts = collectText(renderTree(card.component({}))).join(" / ");
  assert.ok(texts.includes("文件投递"), `空 props 也应按 page 渲染，实际文本：${texts}`);
});

/* --------------------------------------------------- 定时任务（迁自 T专家） */

check("定时任务：侧栏入口的 id 必须等于 main 面板的 key（否则点了不换页）", () => {
  const entry = registered.find((item) => item.options.name === "sidebar.panellist");
  const main = registered.find((item) => item.options.name === "main");
  assert.ok(entry !== undefined, "没注册侧栏入口");
  assert.ok(main !== undefined, "没注册主区域面板");
  assert.equal(entry.options.id, "helper-patch-schedule");
  assert.equal(main.options.key, entry.options.id);
  assert.equal(entry.options.order, 1, "侧栏那一组里排最前，紧贴「新会话」");
});

check("定时任务与 T专家 零关联：产物里不该出现名册/召唤相关代码", () => {
  const src = readFileSync(join(REPO, "lib", "client.js"), "utf8");
  for (const pat of ["summon_t_expert", "remote.tTeam", "tTeam", "catalogSnapshot", "ExpertPicker", "collectExpertMentions", "tokenizePrompt"]) {
    assert.equal(src.includes(pat), false, `产物里不该出现 ${pat}`);
  }
  assert.match(src, /helperPatch/, "remote 命名空间应为 helperPatch");
  assert.match(src, /dsh-helper-sched-ruleRows/, "定时任务样式应已打进产物");
  assert.match(src, /dsh-helper-sched-promptInput/, "提示词文本域的样式应在");
});

check("定时任务 remote：8 个方法、命名空间与 package 都指向本插件", async () => {
  const { TYPERT_REMOTE } = await import("../src/client/schedule-remote.js");
  assert.equal(TYPERT_REMOTE.package, "dsh-helper");
  assert.equal(TYPERT_REMOTE.descriptors.length, 8);
  for (const descriptor of TYPERT_REMOTE.descriptors) {
    assert.equal(descriptor.service, "helperPatch");
    assert.equal(descriptor.namespace, "helperPatch");
    assert.match(descriptor.id, /^dsh-helper#helperPatch\//);
  }
});

check("面板不再预先创建工作区：新建与保存都只解析、不建", async () => {
  // 用户 2026-09-28 口径：「为什么任务还没执行，都已经把工作区建立了？不用这样，
  // 他执行的时候应该会自动建立工作区」。
  // 面板原先在 openNewForm 里就调 ensureScheduleWorkspace("")（当场 mkdir + 注册表建条目），
  // 于是用户只是点开新建表单看一眼、或者填完又取消，磁盘上已经多了一个空目录、侧栏里
  // 已经多了一个工作区；保存自定义目录那条路同样当场建。两处都已改成只解析。
  const source = readFileSync(join(REPO, "src/client/schedule.jsx"), "utf8");
  assert.ok(source.includes("remote.resolveScheduleWorkspace("),
    "面板要用只读解析 remote.resolveScheduleWorkspace 取工作区");
  // 判据取**调用形式**而不是裸名字：DEFAULT_WORKSPACE 的注释里正当地提到了
  // ensureScheduleWorkspace（解释为什么不用它），裸 includes 会把注释也算成违规。
  assert.ok(!source.includes("remote.ensureScheduleWorkspace("),
    "面板不该再调 remote.ensureScheduleWorkspace —— 建工作区的动作要推迟到任务第一次执行");
  assert.ok(source.includes("DEFAULT_WORKSPACE"),
    "默认工作区还不存在时要有哨兵值表示「执行时创建」（否则只能退化成「不绑定」，语义就错了）");
});

check("cron 模型自成一体：五段/六段往返一致，且是纯函数", async () => {
  const { parseCron, buildCron, INTERVAL_STEPS, WORKDAYS } = await import("../src/client/schedule-cron.js");
  assert.equal(buildCron(parseCron("0 9 * * *")), "0 9 * * *");
  assert.equal(buildCron(parseCron("30 0 9 * * *")), "30 0 9 * * *");
  assert.equal(buildCron(parseCron("*/30 * * * *")), "*/30 * * * *");
  assert.equal(buildCron(parseCron("30 8 * * 1-5")), "30 8 * * 1-5");
  assert.deepEqual(WORKDAYS, [1, 2, 3, 4, 5]);
  assert.ok(INTERVAL_STEPS.second.includes(10) && INTERVAL_STEPS.minute.includes(30));
});

check("提示词框是普通文本域（迁移时去掉了读名册的芯片编辑器）", () => {
  const card = registered.find((item) => item.options.name === "main");
  assert.ok(card !== undefined);
  const src = readFileSync(join(REPO, "src", "client", "schedule.jsx"), "utf8");
  assert.ok(src.includes("function PromptBox("), "应有 PromptBox");
  assert.ok(src.includes("<textarea"), "PromptBox 应是 textarea");
  assert.equal(src.includes("contentEditable"), false, "不该再有 contentEditable 编辑器（注释里提及历史不算）");
});

/* ------------------------------------------------- 样式表结构（静默检查） */

check("样式表结构合法：没有孤儿残体、关键规则没被吞掉", async () => {
  // 2026-09-25 实际踩过两个坑，都是"按关键词抽行"迁移 CSS 时留下的，而且**纯文本就能查**：
  //   1) 注释的 `/*` 开头被删掉，留下裸文本 —— CSS 解析器会把裸文本连同后面紧跟的注释、
  //      以及下一条规则的 `选择器{` 一起当成一个选择器，于是那条规则整条作废。
  //      当时的后果是 `.dsh-helper-sched{display:flex}` 失效 → 根容器变 block → 左右两栏变成上下堆叠。
  //   2) `@media` 那行被漏掉，响应式规则无条件生效 → 一打开详情就 `listPane{display:none}`、
  //      右栏 `flex-basis:100%` → 详情整页铺满而不是挂在侧边。
  // 这两条都不需要浏览器：读文本就能判定，所以放在这里，别再靠肉眼。
  const { SCHEDULE_CSS } = await import("../src/client/schedule-css.js");
  const lines = SCHEDULE_CSS.split("\n");

  // (1) 孤儿残体：不在注释里，又不像规则开头（. @ } 或空行）
  let inComment = false;
  const orphans = [];
  for (const [index, raw] of lines.entries()) {
    const text = raw.trim();
    if (inComment) { if (text.includes("*/")) inComment = false; continue; }
    if (text.startsWith("/*")) { if (!text.includes("*/")) inComment = true; continue; }
    if (text === "" || text.startsWith(".") || text.startsWith("@") || text.startsWith("}")) continue;
    orphans.push(`${index + 1}: ${text.slice(0, 60)}`);
  }
  assert.deepEqual(orphans, [], `样式里有裸文本行（会吃掉紧随其后的规则）：\n${orphans.join("\n")}`);

  // (2) 关键规则必须真的在：根容器是 flex、详情栏是按比例分栏
  assert.match(SCHEDULE_CSS, /\.dsh-helper-sched\{display:flex;/, "根容器必须是 display:flex（否则两栏会上下堆叠）");
  assert.match(SCHEDULE_CSS, /\.dsh-helper-sched-detailForm\{[^}]*flex:0 0 47%/, "详情栏要按 47% 分栏（与官方 .t-XoWW_detail 一致）");

  // (3) "详情独占整页 / 列表让位"这类规则**必须**待在 @media 里
  const mediaBlocks = [];
  let depth = 0;
  let current = null;
  for (const raw of lines) {
    const text = raw.trim();
    if (depth === 0 && text.startsWith("@media")) { current = []; depth = 1; continue; }
    if (current !== null) {
      depth += (text.match(/\{/gu) ?? []).length;
      depth -= (text.match(/\}/gu) ?? []).length;
      current.push(text);
      if (depth <= 0) { mediaBlocks.push(current.join(" ")); current = null; depth = 0; }
    }
  }
  const mediaText = mediaBlocks.join("\n");
  for (const rule of ['.dsh-helper-sched-listPane[data-detail="true"]{display:none}', "flex-basis:100%"]) {
    assert.ok(mediaText.includes(rule), `${rule} 必须在 @media 内（裸着会无条件生效：打开详情就隐藏列表）`);
  }
  assert.ok(mediaBlocks.length >= 3, `三档断点都要在（1100 / 760 / 400），实际 ${mediaBlocks.length} 块`);
});

check("提示词输入框只有一层边框（不会被通用 input/textarea 规则套上第二层）", async () => {
  // 2026-09-25 用户报「编辑 / 新建定时任务时，提示词下面的输入框有两条边线」。
  // 成因是**特异性**，不是重复：通用规则 ".dsh-helper-sched-group textarea" 是 (0,2,1)，
  // 而当时写的裸 ".dsh-helper-sched-promptInput" 只有 (0,1,0) —— border:0 被赢回去，
  // textarea 于是又套了一圈 12px 圆角的边，与外层 promptbox 的 16px 描边叠成双线。
  // 两层写法 (0,2,0) 同样不够，**必须三层**才能稳赢通用规则。
  const { SCHEDULE_CSS } = await import("../src/client/schedule-css.js");
  const rule = SCHEDULE_CSS.match(/\.dsh-helper-sched-group \.dsh-helper-sched-promptbox \.dsh-helper-sched-promptInput\{([^}]*)\}/u);
  assert.ok(rule, "提示词输入框必须用三层选择器覆盖通用规则（两层特异性不够，双边框会再现）");
  assert.match(rule[1], /border:0/u, "输入框必须显式 border:0 —— 边框一律由外层 .dsh-helper-sched-promptbox 提供");
  assert.match(rule[1], /background:transparent/u, "输入框底色要透明，否则会盖住外层底色");
  assert.match(rule[1], /padding:0/u, "内边距由外层提供，输入框自己不能再加，否则文字会缩进两次");
  // 外层那条规则曾被重复粘贴两遍（编辑事故残留），一并看住。
  assert.doesNotMatch(
    SCHEDULE_CSS,
    /\.dsh-helper-sched-promptbox\{[^}]*\}\.dsh-helper-sched-promptbox\{/u,
    "promptbox 规则不该重复粘贴",
  );
});

check("布局度量与官方那一页逐字一致（内容列／滚动层／标题行／详情栏）", async () => {
  const { SCHEDULE_CSS } = await import("../src/client/schedule-css.js");
  // 内容列的 max-width 限的是**内容盒**：宿主没有全局 box-sizing reset，官方也没在那列上加
  // border-box。加上它 + width:100% 会让内容比官方窄 96px（用户实测报过"区域宽不一样"）。
  assert.match(SCHEDULE_CSS, /\.dsh-helper-sched-page\{max-width:960px;margin:0 auto;padding:0 clamp\(24px,4vw,48px\) 48px\}/,
    "内容列必须是官方那套：max-width:960px + margin auto + padding clamp(24px,4vw,48px)");
  assert.doesNotMatch(SCHEDULE_CSS, /\.dsh-helper-sched-page\{[^}]*box-sizing:border-box/,
    "内容列不能加 box-sizing:border-box（会比官方窄 96px）");
  assert.doesNotMatch(SCHEDULE_CSS, /\.dsh-helper-sched-page\{[^}]*width:100%/,
    "内容列不能写 width:100%（配合 border-box 就是那个 96px 的坑）");
  // 滚动挂在左栏里**全宽**的那一层，内容列只居中 —— 否则滚动条会长在居中列的右边缘。
  assert.match(SCHEDULE_CSS, /\.dsh-helper-sched-pageScroll\{[^}]*overflow:auto/, "滚动必须在 pageScroll 这一层");
  assert.match(SCHEDULE_CSS, /\.dsh-helper-sched-listPane\{display:flex;flex-direction:column;flex:1 1 auto/,
    "左栏要能吃满剩余宽度");
  // 标题行的顶部留白：官方那一页在桌面端（macOS 无边框窗口 / Windows 自绘标题栏）会把
  // --dsh-frame-top-clearance（darwin 下 48px）叠在 28px 上，我们漏过一次 —— 表现就是
  // 「定时任务页标题贴着顶部，比自动化任务页高 48px」（2026-09-29 用户报的）。
  assert.match(SCHEDULE_CSS, /\.dsh-helper-sched-head\{[^}]*padding-top:calc\(28px \+ var\(--dsh-frame-top-clearance,0px\)\)/,
    "标题行的 padding-top 必须叠上 --dsh-frame-top-clearance，否则桌面端标题贴顶");
  assert.doesNotMatch(SCHEDULE_CSS, /\.dsh-helper-sched-head\{[^}]*padding-top:28px/,
    "别再退回写死 28px —— 那正是「标题贴顶」的成因");
  // 状态图标的两态颜色走语义 token（用户口径：失败要显眼）
  assert.match(SCHEDULE_CSS, /\.dsh-helper-sched-deliveryStatus\{[^}]*state-success-primary/, "成功用 state-success-primary");
  assert.match(SCHEDULE_CSS, /\.dsh-helper-sched-deliveryStatus\[data-fail="true"\]\{color:var\(--dsw-alias-state-error-primary\)\}/,
    "失败用 state-error-primary");
});

/* ------------------------------------------------- 完成提示音（2026-09-25） */

// 提示音这块最容易错的地方不是"能不能出声"，而是**什么时候不该出声**：
// 子代理的完成、自动续轮的抖动、一次快照里多个会话同时停下 —— 这三种错了的后果
// 就是连响成一串，用户会直接把功能关掉，而界面上完全看不出哪里不对。
// 所以下面把"停下来"的判定逻辑（sound-core.js）逐条钉死，再补一条端到端的出声路径。

check("提示音：只认顶级会话，子代理与 Agent Teams 队友都不算", async () => {
  const { collectRunningTopLevel } = await import("../src/client/sound-core.js");
  const statuses = new Map([
    ["lead", { running: true }],
    ["child", { running: true }],    // 子代理：带 parentSessionId
    ["teammate", { running: true }], // 队友：teammate 就是 Team Lead 的直接子会话
    ["lead-null", { running: true }], // 主会话，但 parentSessionId 被序列化成 null
    ["idle", { running: false }],
    ["ghost", { running: true }],    // 目录里查不到行的会话
  ]);
  const byId = {
    lead: {},
    child: { parentSessionId: "lead" },
    teammate: { parentSessionId: "lead" },
    "lead-null": { parentSessionId: null },
    idle: {},
  };
  // parentSessionId 为 null（序列化路径常见）的主会话不能被误判成子会话而漏响。
  assert.deepEqual([...collectRunningTopLevel(statuses, byId)].sort(), ["lead", "lead-null"]);
  // 拿不到目录时保持安静：宁可漏响，也不要把子代理的完成播成提示音。
  assert.deepEqual([...collectRunningTopLevel(statuses, undefined)], []);
});

check("提示音：第一帧只建立基线，不把「正在跑」误判成「刚停下」", async () => {
  const { createDetector } = await import("../src/client/sound-core.js");
  const fired = [];
  const detector = createDetector({ schedule: () => 1, cancel: () => {}, onComplete: (ids) => fired.push(ids) });
  detector.observe(new Set(["a"]));
  assert.deepEqual(fired, [], "第一帧不该出声（否则打开页面就会莫名其妙响一声）");
  assert.equal(detector.armed(), false, "第一帧不该排去抖定时器");
});

check("提示音：停下来要等过去抖窗口，期间又跑起来（自动续轮）就不响", async () => {
  const { createDetector } = await import("../src/client/sound-core.js");
  const fired = [];
  const timers = [];
  const detector = createDetector({
    schedule: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    cancel: () => {},
    onComplete: (ids) => fired.push(ids),
  });
  detector.observe(new Set(["a", "b"]));
  detector.observe(new Set(["b"]));       // a 停了
  assert.equal(timers.length, 1, "停下来应当排一次去抖");
  assert.equal(timers[0].ms, 300, "去抖窗口应当是 300ms");
  detector.observe(new Set(["a", "b"]));  // AgentLoop.kick()/goal 续轮：a 又跑起来了
  timers[0].fn();
  assert.deepEqual(fired, [], "抖动不该出声");
  detector.observe(new Set(["b"]));       // 这次是真停
  timers[1].fn();
  assert.deepEqual(fired, [["a"]], "确认停下之后才出声");
});

check("提示音：一次快照里多个会话同时停下，只响一声", async () => {
  const { createDetector } = await import("../src/client/sound-core.js");
  const fired = [];
  const timers = [];
  const detector = createDetector({
    schedule: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    cancel: () => {},
    onComplete: (ids) => fired.push(ids),
  });
  detector.observe(new Set(["a", "b", "c"]));
  detector.observe(new Set());
  assert.equal(timers.length, 1, "三个一起停也只排一个定时器");
  timers[0].fn();
  assert.equal(fired.length, 1, "只该回调一次");
  assert.deepEqual(fired[0].sort(), ["a", "b", "c"]);
});

check("提示音：关掉开关会重置，重新打开不补响关闭期间的那一声", async () => {
  const { createDetector } = await import("../src/client/sound-core.js");
  const fired = [];
  let cancelled = 0;
  const detector = createDetector({ schedule: () => 7, cancel: () => { cancelled += 1; }, onComplete: (ids) => fired.push(ids) });
  detector.observe(new Set(["a"]));
  detector.observe(new Set());       // a 停了，定时器已排
  detector.reset();
  assert.equal(cancelled, 1, "重置应当取消还没到点的定时器");
  assert.equal(detector.armed(), false);
  assert.equal(detector.waiting(), 0);
  detector.observe(new Set());       // 重新打开后的第一帧
  assert.deepEqual(fired, [], "重新打开不该补响");
});

check("提示音：音色与音量是数据，规格可断言（不是藏在 Web Audio 调用里）", async () => {
  const { TONES, DEFAULT_TONE, DEFAULT_VOLUME, completionSoundSpec } = await import("../src/client/sound-core.js");
  assert.equal(TONES.length, 7, "七种合成音：叮咚 / 单音叮 / 三连音 / 电子哔 / 街机金币 / 扫频 / 激光");
  const loud = completionSoundSpec("triple", "loud");
  assert.equal(loud.notes.length, 3, "三连音就是三个音");
  assert.ok(loud.notes[2].freq > loud.notes[0].freq, "三连音应当是上行（下行听着像「失败」）");
  const soft = completionSoundSpec("triple", "soft");
  assert.ok(loud.notes[0].gain > soft.notes[0].gain, "响档的增益必须真的更大");
  assert.ok(loud.notes.every((note) => note.gain > 0 && note.gain <= 1), "增益要落在 0~1");
  // 非法 id（用户手改 localStorage 也能碰到）一律退回默认档，不抛错
  const bogus = completionSoundSpec("nope", "nope");
  const plain = completionSoundSpec(DEFAULT_TONE, DEFAULT_VOLUME);
  assert.equal(bogus.id, DEFAULT_TONE);
  assert.deepEqual(bogus.notes.map((note) => note.freq), plain.notes.map((note) => note.freq));
});

check("提示音：音色有第四档「自定义」，且偏好必须接受它", async () => {
  const { CUSTOM_TONE_ID, TONE_CHOICES, TONE_IDS, DEFAULT_TONE, completionSoundSpec } = await import("../src/client/sound-core.js");
  assert.equal(CUSTOM_TONE_ID, "custom");
  // 回归点：TONE_IDS 是偏好的 normalize 白名单。custom 不在里面的话，用户选完自定义
  // 一刷新就被打回默认档 —— 表现为"设置没保存"，而代码看起来完全正常。
  assert.ok(TONE_IDS.includes(CUSTOM_TONE_ID), "音色偏好白名单必须包含 custom");
  assert.deepEqual(TONE_CHOICES.map((item) => item.id), ["chime", "ding", "triple", "beep", "coin", "sweep", "laser", "custom"]);
  // 自定义音没就绪时回退内置音：规格应当与默认音一致（既不抛错，也不静音）
  const fallback = completionSoundSpec(CUSTOM_TONE_ID, "medium");
  const plain = completionSoundSpec(DEFAULT_TONE, "medium");
  assert.equal(fallback.id, DEFAULT_TONE);
  assert.deepEqual(fallback.notes.map((note) => note.freq), plain.notes.map((note) => note.freq));
});

check("提示音：自定义音频记录的校验与大小显示", async () => {
  const { CUSTOM_SOUND_MAX_BYTES, formatBytes, isCustomSoundRecord } = await import("../src/client/sound-core.js");
  assert.equal(isCustomSoundRecord({ name: "ding.mp3", data: new ArrayBuffer(2048) }), true);
  assert.equal(isCustomSoundRecord({ name: "ding.mp3", data: new Uint8Array(16) }), true, "TypedArray 也要接受");
  assert.equal(isCustomSoundRecord({ name: "", data: new ArrayBuffer(16) }), false, "没有名字不算");
  assert.equal(isCustomSoundRecord({ name: "x.mp3", data: new ArrayBuffer(0) }), false, "空数据不算");
  assert.equal(isCustomSoundRecord({ name: "x.mp3", data: "not-bytes" }), false, "不是二进制不算");
  assert.equal(isCustomSoundRecord({ name: "x.mp3", data: new ArrayBuffer(CUSTOM_SOUND_MAX_BYTES + 1) }), false, "超限要拦下");
  assert.equal(isCustomSoundRecord(null), false);
  assert.equal(formatBytes(512), "512 B");
  assert.equal(formatBytes(2048), "2 KB");
  assert.equal(formatBytes(1.5 * 1024 * 1024), "1.5 MB");
});

check("提示音：音色选「自定义」时卡片才出现文件选择行", async () => {
  // 偏好是模块级缓存的（prefs.js 的 cached），所以要预置 localStorage 之后用**全新的
  // 模块实例**渲染，否则读到的是前面用例缓存下来的音色。
  storage.set("dsh-helper:sound:tone", "custom");
  try {
    const source = readFileSync(join(REPO, "lib", "client.js"), "utf8");
    let factory;
    globalThis.window.__ModuleLoader__ = { load: (entry) => { factory = entry.factory; } };
    new Function("window", "document", "MutationObserver", "requestAnimationFrame", "cancelAnimationFrame", source)(
      globalThis.window, document, FakeMutationObserver, globalThis.requestAnimationFrame, globalThis.cancelAnimationFrame,
    );
    const freshApp = factory((id) => {
      if (id === "react") return React;
      if (id === "@deepseek-ai/dsh-client-ui-primitives") return primitivesStub;
      throw new Error(`未预期的 require：${id}`);
    });
    const entries = [];
    freshApp.apply({
      effect: () => {},
      slots: {
        inject: (_name, contribute) => contribute(),
        register: (options, component) => { entries.push({ options, component }); return () => {}; },
      },
    });
    const card = entries.find((item) => item.options.name === "plugins.bundle.config");
    const texts = collectText(renderTree(card.component({ view: "page" }))).join(" / ");
    assert.ok(texts.includes("自定义音频文件"), `选中自定义后应出现文件行，实际文本：${texts}`);
    assert.ok(texts.includes("选择音频文件"), `应有一颗选择文件的按钮，实际文本：${texts}`);
    // 无 IndexedDB 的桩环境里读库会失败，但那是**提示**而不是崩溃：文件行本身照常渲染。
    assert.ok(texts.includes("正在读取") || texts.includes("不会上传"), `读库失败不该让文件行消失，实际文本：${texts}`);
  } finally {
    storage.delete("dsh-helper:sound:tone");
  }
});

check("提示音：总增益留有防削波余量（不能给满）", async () => {
  const { MASTER_GAIN, completionSoundSpec } = await import("../src/client/sound-core.js");
  assert.ok(MASTER_GAIN > 0 && MASTER_GAIN < 1, `总增益应落在 (0,1)，实际 ${MASTER_GAIN}`);
  // 响档 + 叮咚：两个音有重叠，单个音峰值若满幅，叠加瞬间就会硬削波。
  const loud = completionSoundSpec("chime", "loud");
  const peak = Math.max(...loud.notes.map((note) => note.gain));
  assert.ok(peak < 1, `单个音峰值 ${peak} 不该满幅（多音叠加会削波）`);
});

check("提示音：扫频 / 激光带 glide（扫频终点），规格能透传", async () => {
  const { TONES, completionSoundSpec } = await import("../src/client/sound-core.js");
  const sweep = completionSoundSpec("sweep", "medium");
  assert.equal(sweep.notes.length, 1, "扫频是单个滑音");
  assert.ok(sweep.notes[0].glide > sweep.notes[0].freq, "扫频应当从低到高");
  const laser = completionSoundSpec("laser", "medium");
  assert.ok(laser.notes[0].glide < laser.notes[0].freq, "激光应当从高到低");
  // 只有扫频 / 激光带 glide：其它音色的频率应当是恒定的。
  for (const tone of TONES) {
    if (tone.id === "sweep" || tone.id === "laser") continue;
    assert.ok(tone.notes.every((note) => note.glide === undefined), `「${tone.id}」不该带 glide`);
  }
});

check("提示音：「切走才响」用标准 API 判定，判不出来时保持安静", async () => {
  const { pageIsAway } = await import("../src/client/sound-core.js");
  assert.equal(pageIsAway({ hidden: true }), true, "切了标签页 / 最小化");
  assert.equal(pageIsAway({ hidden: false, hasFocus: () => false }), true, "窗口在但焦点在别的 app");
  assert.equal(pageIsAway({ hidden: false, hasFocus: () => true }), false, "人正看着，不该响");
  // 桩环境（没有 hidden 也没有 hasFocus）判不出来 —— 静音是安全的一侧
  assert.equal(pageIsAway({}), false);
  assert.equal(pageIsAway(null), false);
});

check("提示音：去重/冷却窗口（响过一声后 5 秒内不再响）", async () => {
  const { createPlayGuard, DEDUPE_MS } = await import("../src/client/sound-core.js");
  assert.equal(DEDUPE_MS, 5000, "去重/冷却窗口应为 5 秒（压掉 turn 结束时 running 的几下抖动）");
  let stored = null;
  const guard = createPlayGuard({ windowMs: 800, now: () => 1000, read: () => stored, write: (value) => { stored = value; } });
  assert.equal(guard(), true, "第一次应当放行");
  assert.equal(guard(), false, "同一窗口内第二次应当被拦下（另一个标签页已经响过了）");
  const later = createPlayGuard({ windowMs: 800, now: () => 2000, read: () => stored, write: (value) => { stored = value; } });
  assert.equal(later(), true, "过了窗口就该放行");
});

check("提示音：设置卡片里有这一组（开关 / 音色 / 音量 / 切走 / 试听）", () => {
  const card = registered.find((entry) => entry.options.name === "plugins.bundle.config");
  const texts = collectText(renderTree(card.component({ view: "page" }))).join(" / ");
  for (const label of ["完成提示音", "对话完成时播放提示音", "音色", "音量", "只在切走时响", "试听"]) {
    assert.ok(texts.includes(label), `卡片里应出现「${label}」，实际文本：${texts}`);
  }
  for (const label of ["叮咚", "单音叮", "三连音", "电子哔", "街机金币", "扫频", "激光", "自定义"]) {
    assert.ok(texts.includes(label), `音色「${label}」应可选，实际文本：${texts}`);
  }
  assert.ok(texts.includes("轻") && texts.includes("中") && texts.includes("响"), "音量三档都应可选");
});

check("提示音：端到端——主会话停下会真的排音符，子代理停下不会", () => {
  // 这一条走**产物**：渲染真实的观察组件，装一个假 AudioContext 看它有没有排音符。
  // 去抖窗口用假定时器推过去，不真等。
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  const timers = [];
  globalThis.setTimeout = (fn, ms) => { timers.push({ fn, ms }); return timers.length; };
  globalThis.clearTimeout = () => {};

  const played = [];
  const fakeAudio = {
    state: "running",
    currentTime: 10,
    destination: {},
    resume: () => Promise.resolve(),
    createOscillator: () => {
      const oscillator = {
        type: "",
        // 真实 AudioParam 有 setValueAtTime / exponentialRampToValueAtTime；
        // 这里给个最小实现，让带 glide 的音色也能在桩里跑通（start 时读到的就是起点频率）。
        frequency: {
          value: 0,
          setValueAtTime: (value) => { oscillator.frequency.value = value; },
          exponentialRampToValueAtTime: () => {},
        },
        connect: () => {},
        start: (at) => played.push({ freq: oscillator.frequency.value, at }),
        stop: () => {},
      };
      return oscillator;
    },
    createGain: () => ({
      gain: { setValueAtTime: () => {}, exponentialRampToValueAtTime: () => {} },
      connect: () => {},
    }),
  };
  globalThis.window.AudioContext = function FakeAudioContext() { return fakeAudio; };

  const entry = registered.find((item) => item.options.id === "dsh-helper-sound");
  const renderSoundWatcher = (statuses, byId) => render(entry.component({
    useSessionStatus: (selector) => selector(statuses),
    useSessions: (selector) => selector({ byId, ids: Object.keys(byId), phase: "ready" }),
  }));

  try {
    assert.ok(entry !== undefined, "没有注册提示音的 shell.overlay 观察组件");
    assert.equal(renderSoundWatcher(new Map([["lead", { running: true }]]), { lead: {} }).props.style.display, "none",
      "观察组件应当是隐藏占位节点");
    assert.equal(timers.length, 0, "第一帧只建立基线");
    renderSoundWatcher(new Map([["lead", { running: false }]]), { lead: {} });
    assert.equal(timers.length, 1, "主会话停下来应当排一次去抖");
    assert.equal(timers[0].ms, 300);
    timers[0].fn();
    assert.ok(played.length >= 2, `推过窗口后应当真的排了音符，实际 ${played.length} 个`);
    assert.ok(played.every((note) => Number.isFinite(note.freq) && note.freq > 0), "每个音符都要有正频率");

    // 子代理：即使它在跑、又停下，也不该产生新的定时器（它从头到尾都不在集合里）
    renderSoundWatcher(new Map([["child", { running: true }]]), { child: { parentSessionId: "lead" } });
    renderSoundWatcher(new Map([["child", { running: false }]]), { child: { parentSessionId: "lead" } });
    assert.equal(timers.length, 1, "子代理的完成不该再排定时器");

    // 宿主没注入这两个 hook 时（root hooks 改名/版本差异）不能把整个 overlay 组件炸掉：
    // 缺谁就退化成"检测不到"，安静即可。
    assert.doesNotThrow(() => render(entry.component({})), "缺少注入的 selector hook 时不该抛错");
  } finally {
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
    delete globalThis.window.AudioContext;
  }
});

check("提示音：一轮结束 running 抖几下 → 只响一声（5 秒冷却压抖动）", () => {
  // 「叮好几下」修复的端到端回归：模拟 turn 结束时 running 抖动 3 次（停→跑→停→跑→停，
  // 每次停都超过 300ms 去抖）。detector 会触发 3 次 onComplete，但 5 秒冷却只放行第 1 次。
  // 必须用**全新模块实例**：detector / audioContext / playGuard 都是模块级单例，前面测试已污染。
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  const timers = [];
  globalThis.setTimeout = (fn, ms) => { timers.push({ fn, ms }); return timers.length; };
  globalThis.clearTimeout = () => {};
  // 清掉上次测试留下的播放时间戳，确保从「没响过」开始（否则第一次就被冷却拦下）。
  storage.delete("dsh-helper:sound:last-played-at");

  const played = [];
  const fakeAudio = {
    state: "running",
    currentTime: 0,
    destination: {},
    resume: () => Promise.resolve(),
    createOscillator: () => {
      const oscillator = {
        type: "",
        frequency: { value: 0, setValueAtTime: (value) => { oscillator.frequency.value = value; }, exponentialRampToValueAtTime: () => {} },
        connect: () => {},
        start: (at) => played.push({ freq: oscillator.frequency.value, at }),
        stop: () => {},
      };
      return oscillator;
    },
    createGain: () => ({ gain: { setValueAtTime: () => {}, exponentialRampToValueAtTime: () => {} }, connect: () => {} }),
  };
  globalThis.window.AudioContext = function () { return fakeAudio; };

  try {
    const source = readFileSync(join(REPO, "lib", "client.js"), "utf8");
    let factory;
    globalThis.window.__ModuleLoader__ = { load: (entry) => { factory = entry.factory; } };
    new Function("window", "document", "MutationObserver", "requestAnimationFrame", "cancelAnimationFrame", source)(
      globalThis.window, document, FakeMutationObserver, globalThis.requestAnimationFrame, globalThis.cancelAnimationFrame,
    );
    const freshApp = factory((id) => {
      if (id === "react") return React;
      if (id === "@deepseek-ai/dsh-client-ui-primitives") return primitivesStub;
      throw new Error(`未预期的 require：${id}`);
    });
    const entries = [];
    freshApp.apply({
      effect: () => {},
      slots: {
        inject: (_name, contribute) => contribute(),
        register: (options, component) => { entries.push({ options, component }); return () => {}; },
      },
    });
    const entry = entries.find((item) => item.options.id === "dsh-helper-sound");
    assert.ok(entry !== undefined, "全新实例应注册提示音观察组件");
    const renderSoundWatcher = (statuses, byId) => render(entry.component({
      useSessionStatus: (selector) => selector(statuses),
      useSessions: (selector) => selector({ byId, ids: Object.keys(byId), phase: "ready" }),
    }));
    const running = () => new Map([["lead", { running: true }]]);
    const idle = () => new Map([["lead", { running: false }]]);

    renderSoundWatcher(running(), { lead: {} });  // 基线
    renderSoundWatcher(idle(), { lead: {} });     // 停（第 1 下）
    timers[0].fn();                              // 去抖到点 → 响第 1 次
    renderSoundWatcher(running(), { lead: {} });  // 又跑（第 2 下抖动）
    renderSoundWatcher(idle(), { lead: {} });
    timers[1].fn();
    renderSoundWatcher(running(), { lead: {} });  // 第 3 下抖动
    renderSoundWatcher(idle(), { lead: {} });
    timers[2].fn();

    // 叮咚 = 2 个 note。3 下抖动若没冷却会排 6 个 note；有冷却只排第 1 次的 2 个。
    assert.equal(played.length, 2, `3 次抖动只该响一声（2 个 note），实际排了 ${played.length} 个 note`);
  } finally {
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
    delete globalThis.window.AudioContext;
  }
});

/* ---------------------------------------------------------------- 输出 */

await Promise.all(pending);

console.log(results.join("\n"));
console.log(process.exitCode === 1 ? "\n客户端冒烟：失败" : `\n客户端冒烟：全部通过（${results.length} 项）`);

// 文档不许说谎：docs/DEVELOPMENT.md 的自检表里写着三套冒烟各自的项数。那三个数字曾经长期
// 停在 58/72/6（实际早已是 77/103/9），没有任何机制发现，直到 2026-09-28 审计时逐条数了一遍。
// 放在收尾处直接核对而不是包成一条 check()：check 的计数本身正是被核对的对象，
// 用它去核对它会陷入"自己算不算一项"的绕圈子。
try {
  const doc = readFileSync(new URL("../docs/DEVELOPMENT.md", import.meta.url), "utf8");
  const claimed = /^\| `npm run smoke` \|.*\|\s*(\d+)\s*项\s*\|$/mu.exec(doc)?.[1];
  if (claimed !== undefined && Number(claimed) !== results.length) {
    console.log(`  ✗ docs/DEVELOPMENT.md 的自检表说 client-smoke 是 ${claimed} 项，实际 ${results.length} 项（加了测试就同步那三个数字）`);
    process.exitCode = 1;
  }
} catch {
  /* 文档读不到就跳过：核对文档不该成为冒烟本身的失败原因 */
}
