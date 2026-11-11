/**
 * 把插件当前真实的 CSS 渲染成一张预览页，用来看「够不够明显、糊不糊」。
 *
 * 与手写对比页的区别：这里的样式是从 src/client/sidebar-glow.jsx 的 CSS 常量里
 * 原样抽出来的，所以你看到的就是浏览器里会跑的那份，不会与实现漂移。
 * （这份工具连同呼吸灯一起从 dsh-sidebar-glow 搬过来，那时它抽的是那个仓库的
 * src/client/index.jsx —— 同一份代码。）
 * 图标几何也从已安装的 @deepseek-ai/dsh-client-ui-primitives 里抽，是真图标。
 *
 * 用法：
 *   node tools/preview.mjs [输出 html 路径]
 * 然后截图（chromium 的 headless shell 就够）：
 *   <chrome-headless-shell> --headless --hide-scrollbars \
 *     --screenshot=/tmp/glow.png --window-size=780,1500 file://<输出 html 路径>
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("..", import.meta.url));

/**
 * 已安装的 `@deepseek-ai/dsh-client-ui-primitives`：预览页要从它里面抽真实图标几何。
 *
 * 按候选顺序探测，**不写死任何人的家目录**。原先这里硬编码的是作者机器上的
 * `~/.npm-global/...`，换一台机器、或别人 clone 下来跑 `npm run preview` 就直接失败，
 * 而报错只会说「找不到 primitives 包：<那条别人机器上的路径>」，看不出该怎么办。
 * 现在全都找不到时，把试过的路径与 DSH_PRIMITIVES 的用法一起说出来。
 */
const PRIMITIVE_CANDIDATES = [
  // 显式指定优先（CI / 非标准安装位置）
  process.env.DSH_PRIMITIVES,
  // npm 全局装的 dsh（`npm root -g` 那一份；前缀因机而异，所以按家目录拼常见布局）
  join(homedir(), ".npm-global/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-ui-primitives/lib/index.js"),
  // 本仓库自己装过的那份
  join(REPO, "node_modules/@deepseek-ai/dsh-client-ui-primitives/lib/index.js"),
  // 同一工作区里隔壁插件装过的那份（t-team 这个工作区就是这种布局）
  join(REPO, "../dsh-expert/node_modules/@deepseek-ai/dsh-client-ui-primitives/lib/index.js"),
  // DSH Desktop 自带的
  "/Applications/DeepSeek Harness.app/Contents/Resources/app.asar.unpacked/dsh/node_modules/@deepseek-ai/dsh-client-ui-primitives/lib/index.js",
].filter((path) => typeof path === "string" && path !== "");
const PRIMITIVES = PRIMITIVE_CANDIDATES.find((path) => existsSync(path));
if (PRIMITIVES === undefined) {
  throw new Error(
    "找不到 @deepseek-ai/dsh-client-ui-primitives（预览页要从它抽真实图标几何）。试过这些路径：\n  "
    + PRIMITIVE_CANDIDATES.join("\n  ")
    + '\n\n用 DSH_PRIMITIVES 指定它，例如：\n  DSH_PRIMITIVES="$(npm root -g)/@deepseek-ai/dsh/node_modules'
    + '/@deepseek-ai/dsh-client-ui-primitives/lib/index.js" node tools/preview.mjs',
  );
}
const OUT = process.argv[2] ?? join(tmpdir(), "dsh-sidebar-glow-preview.html");

const MARK_ATTR = "data-dsh-glow";
const STYLE_ATTR = "data-dsh-glow-style";
// 与实现的默认节奏档（中 = 2.4s）保持一致：三种风格按各自比例缩放。
const DURATIONS = { hue: 2.4, beat: 2.4 * 0.66, halo: 2.4 * 0.75 };

/* ------------------------------------------------ 从实现里抽真实 CSS */

const source = readFileSync(join(REPO, "src", "client", "sidebar-glow.jsx"), "utf8");
const cssMatch = /const CSS = `([\s\S]*?)`;/.exec(source);
if (cssMatch === null) throw new Error("没能从 src/client/sidebar-glow.jsx 里抽出 CSS 常量");
const CSS = cssMatch[1]
  .replaceAll("${MARK_ATTR}", MARK_ATTR)
  .replaceAll("${STYLE_ATTR}", STYLE_ATTR)
  // 实现里风格属性挂在 <html> 上（真实环境只有一个文档根）；预览页要在同一张
  // 图里并排三种风格，所以把 `html[data-dsh-glow-style` 收敛成不带 html 前缀，
  // 让每个 panel 自己承载这个属性。只影响本预览页，观感与线上一致。
  .replaceAll(`html[${STYLE_ATTR}`, `[${STYLE_ATTR}`);

/* ------------------------------------------------------------ 真图标 */

function artwork(name) {
  // 不再检查 PRIMITIVES 是否存在：模块顶层的候选探测已经保证了它存在，
  // 而且那时报的错带着一整份"试过哪些路径 + 该怎么指定"，比在这里报一句 ENOENT 有用。
  const text = readFileSync(PRIMITIVES, "utf8");
  const start = text.indexOf(`const ${name} = `);
  if (start < 0) throw new Error(`找不到 ${name}`);
  const block = text.slice(start, text.indexOf("\n});", start));
  const paths = [];
  for (const match of block.matchAll(/jsx\("path", \{([\s\S]*?)\}\)/g)) {
    const body = match[1];
    const d = /d: "([^"]+)"/.exec(body)?.[1];
    if (d === undefined) continue;
    const attrs = [`d="${d}"`];
    if (body.includes('stroke: "currentColor"')) attrs.push('fill="none"', 'stroke="currentColor"', 'stroke-width="1"');
    if (body.includes('fill: "currentColor"')) attrs.push('fill="currentColor"');
    const opacity = /opacity: "([\d.]+)"/.exec(body)?.[1];
    if (opacity !== undefined) attrs.push(`opacity="${opacity}"`);
    paths.push(`<path ${attrs.join(" ")}/>`);
  }
  return `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">${paths.join("")}</svg>`;
}

const closeIcon = artwork("FolderCloseArtwork");
const openIcon = artwork("IconFolderOpenArtwork");

/* -------------------------------------------------------------- 页面 */

const PHASES = [0, 1, 2];
const TITLES = { hue: "彩色流转（默认）", beat: "脉冲", halo: "光环" };

function panel(styleId, theme, icon) {
  const rows = PHASES.map((phase) => `<div class="phase" data-phase="${phase}">`
    + `<div class="row" ${MARK_ATTR}><span class="icon">${icon}</span>`
    + `<span class="title">工作区 ${phase + 1}</span></div></div>`).join("");
  // 末尾再放一个 3× 放大的图标，用来看光晕的形态（1× 下看不清它紧不紧）。
  const zoom = `<div class="phase" data-phase="2"><div class="row zoomrow" ${MARK_ATTR}>`
    + `<span class="icon zoom">${icon}</span><span class="title">3× 放大</span></div></div>`;
  return `<div class="panel ${theme}" ${STYLE_ATTR}="${styleId}">${rows}${zoom}</div>`;
}

const cards = ["hue", "beat", "halo"].map((styleId) => `<section class="card">
  <h3>${TITLES[styleId]}</h3>
  <div class="pair">
    ${panel(styleId, "light", closeIcon)}
    ${panel(styleId, "dark", openIcon)}
  </div>
  <p class="legend">左：浅色主题 / 折叠图标（描边型）　右：深色主题 / 展开图标（填充型）　三格 = 周期 0% / 33% / 67%</p>
</section>`).join("\n");

const phaseCss = ["hue", "beat", "halo"].flatMap((styleId) => {
  const d = DURATIONS[styleId];
  return PHASES.map((phase) => {
    const delay = -(d * phase / 3).toFixed(3);
    const sel = `.panel[${STYLE_ATTR}="${styleId}"] [data-phase="${phase}"] .row`;
    return `${sel}, ${sel} > span:first-child svg,`
      + ` ${sel} > span:first-child::before, ${sel} > span:first-child::after {`
      + ` animation-delay: ${delay}s !important; animation-play-state: paused !important; }`;
  });
}).join("\n");

const html = `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><title>dsh-sidebar-glow 预览</title>
<style>
  * { box-sizing: border-box }
  body { margin: 0; padding: 20px; background: #eceef2; color: #1a1a1a;
         font: 13px/1.5 -apple-system, "Helvetica Neue", "PingFang SC", sans-serif }
  h1 { font-size: 16px; margin: 0 0 16px }
  .card { background: #fff; border-radius: 12px; padding: 14px 16px; margin-bottom: 14px;
          box-shadow: 0 1px 3px rgba(0,0,0,.08) }
  .card h3 { font-size: 14px; margin: 0 0 10px }
  .legend { color: #888; margin: 8px 0 0; font-size: 11px }
  .pair { display: flex; gap: 12px }
  .panel { flex: 1; border-radius: 10px; padding: 8px }
  .panel.light { --dsw-alias-state-business-primary: #4d6bfe; --dsw-alias-label-primary: #1a1a1a;
                 background: #fff; color: #1a1a1a; border: 1px solid #e3e5ea }
  .panel.dark  { --dsw-alias-state-business-primary: #6b8cff; --dsw-alias-label-primary: #e8e8ea;
                 background: #1e1e22; color: #e8e8ea; border: 1px solid #2c2c31 }
  .row { display: flex; align-items: center; gap: 6px; height: 34px; padding: 0 8px;
         border-radius: 8px; margin-bottom: 2px; color: var(--dsw-alias-label-primary) }
  .icon { width: 16px; height: 16px; flex: none; display: inline-flex; align-items: center;
          justify-content: center }
  .title { font-size: 14px }
  /* 放大观察行：只放大 .icon 容器，动画仍在里面的 svg 上，互不干扰。 */
  .zoomrow { height: 64px; overflow: visible }
  .icon.zoom { transform: scale(3); margin: 0 26px }
  /* 把实现里的 CSS 原样搬进来，只额外加相位定格。 */
${CSS}
${phaseCss}
</style></head>
<body>
<h1>dsh-sidebar-glow · 当前实现预览（样式抽自 src/client/index.jsx）</h1>
${cards}
</body></html>`;

writeFileSync(OUT, html, "utf8");
console.log(`已生成 ${OUT}（${Buffer.byteLength(html)} 字节）`);
