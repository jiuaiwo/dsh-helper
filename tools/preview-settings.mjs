#!/usr/bin/env node
/**
 * 设置卡片的**静态预览**：把六张卡片渲染成一张 HTML，用浏览器截一张图就能看版面。
 *
 * 为什么要有它：这张卡片改完必须重启宿主才能看到（客户端产物是启动时加载的），而"排版乱不乱"
 * 又是纯视觉问题 —— 2026-09-28 那次重排就是靠它先在本地看出来的（顺带发现浅色主题下
 * `--dsw-alias-border-l3` 只有 12% 黑，0.5px 的卡片边框几乎看不见，于是把边框改成 1px）。
 *
 * 渲染的是真实组件树：直接从 `src/client/index.jsx` 取 `SettingsCards`（宿主配置读与写之外
 * 的那六张卡片本体），所以预览与真机不会漂移。官方 primitives 用 `tools/primitives-stub.jsx`
 * 顶替（真包要宿主模块表才拿得到单例），替身的尺寸与配色照官方 CSS 写，观感一致。
 *
 * CSS 变量取的是宿主 `@deepseek-ai/dsh-client-ui-theme` 里的真实值（见下面 TOKENS）——
 * 宿主换主题/改 token 时要回来核对，否则预览会与真机不一致。
 *
 * 用法：
 *   node tools/preview-settings.mjs [输出 html 路径]
 *   # 然后截图（chromium 的 headless shell 就够）：
 *   "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new \
 *     --disable-gpu --hide-scrollbars --window-size=1100,1700 \
 *     --screenshot=/tmp/settings.png file://<输出 html 路径>
 */
import { existsSync } from "node:fs";
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const SELF_DIR = fileURLToPath(new URL(".", import.meta.url));
const HERE = process.env.DSH_HELPER_PATCH_REPO
  ?? (existsSync(join(SELF_DIR, "..", "lib", "index.js")) ? resolve(SELF_DIR, "..") : process.cwd());
const CLIENT_DIR = join(HERE, "src", "client");
const OUT = process.argv[2] ?? join(tmpdir(), "dsh-helper-settings.html");

// bundle 必须落在**仓库内**：它 require("react") 才能解析到本仓的 react（放 /tmp 会变成两份
// React，报 "Invalid hook call"）。node_modules/.cache 不进 git。
const CACHE = join(HERE, "node_modules", ".cache", "helper-patch-settings-preview");
mkdirSync(CACHE, { recursive: true });
const ENTRY = join(CACHE, "entry.jsx");
const BUNDLE = join(CACHE, "bundle.cjs");
writeFileSync(ENTRY, `export { SettingsCards } from ${JSON.stringify(join(CLIENT_DIR, "index.jsx"))};\n`);
await build({
  entryPoints: [ENTRY],
  outfile: BUNDLE,
  bundle: true,
  format: "cjs",
  platform: "node",
  external: ["react"],
  jsx: "transform",
  logLevel: "error",
  // 官方包在真产物里是外部 require（宿主模块表提供单例），这里指向最小替身。
  alias: { "@deepseek-ai/dsh-client-ui-primitives": join(SELF_DIR, "primitives-stub.jsx") },
});

const require = createRequire(import.meta.url);
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { SettingsCards } = require(BUNDLE);

/** host 配置读回来之后的样子（全开 + 一个后端），够覆盖所有分支的常规态。 */
const settings = {
  enabled: true,
  imageAsPicture: true,
  restartEnabled: true,
  scheduleEnabled: true,
  backend: "im-connect",
};

const html = renderToStaticMarkup(React.createElement(SettingsCards, {
  settings,
  pending: false,
  error: "",
  onSave: () => {},
}));

/** 宿主浅色主题的真实 token（@deepseek-ai/dsh-client-ui-theme 的 base）。 */
const TOKENS = `
:root{
  --dsw-alias-bg-base:#fff; --dsw-alias-bg-layer-1:#fff; --dsw-alias-bg-layer-2:#fff; --dsw-alias-bg-layer-3:#fff;
  --dsw-alias-label-primary:#0f1115; --dsw-alias-label-secondary:#61666b; --dsw-alias-label-caption:#adb2b8;
  --dsw-alias-label-primary-foreground:#fff;
  --dsw-alias-border-l1:#0000000a; --dsw-alias-border-l2:#0000001a; --dsw-alias-border-l3:#0000001f;
  --dsw-alias-interactive-bg-hover:#2631480f; --dsw-alias-brand-primary:#0f1115; --dsw-alias-state-error-primary:#ec1313;
  --dsw-radius-md:12px; --dsw-radius-sm:8px;
  --dsw-elevation-soft:0 0 0 .5px #00000014, 0 4px 16px 0 #00000008;
}
body{margin:0;padding:24px;background:var(--dsw-alias-bg-base);font-family:-apple-system,"PingFang SC",sans-serif}
/* 插件详情页的容器宽度：官方给每个直接子元素的是 .page>*{width:100%;max-width:960px} */
.page{width:100%;max-width:960px;margin:0 auto}
`;

writeFileSync(OUT, `<!doctype html><meta charset="utf-8"><title>辅助补丁 · 设置卡片预览</title>
<style>${TOKENS}</style>
<div class="page">${html}</div>
`);
process.stdout.write(`已生成 ${OUT}\n截图："/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new `
  + `--disable-gpu --hide-scrollbars --window-size=1100,1700 --screenshot=/tmp/settings.png file://${OUT}\n`);
