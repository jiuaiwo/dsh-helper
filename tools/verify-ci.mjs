#!/usr/bin/env node
/**
 * 按 **CI 的方式**在本地把 gate 任务跑一遍：干净检出 + 干净依赖 + 换掉的 home。
 *
 * ## 为什么需要它
 *
 * 本机环境比 CI **富**，于是有一类问题本地永远绿、CI 一直红。2026-10-06 这个仓库第一次跑
 * CI 时连撞三个，全是同一副面孔：
 *
 *   ① `@deepseek-ai/cordis` 是 `@deepseek-ai/dsh-typert-protocol` 声明的 peer，而本仓 `.npmrc`
 *      开着 `legacy-peer-deps`，npm 不会自动装 peer → CI 的独立检出里没有它 → `Service` 类型
 *      解析不出来 → `this.ctx` 被判成非法属性（TS2339）。本地不报，是因为
 *      `~/web/t-team/node_modules` 里躺着 cordis，TS 向上查找命中了。
 *   ② `react` / `react-dom` 同理：只在 peerDependencies 里，`render-smoke` 却真的 require 它们。
 *   ③ `tools/host-smoke.mjs` 的「迁移幂等性」用例把旧数据路径写死成 `/Users/biaoge/...`，而引擎
 *      算的是 `homedir()/.t-team/schedule.json` —— 本机 home 恰好就是那个值，CI 是 `/home/runner`。
 *
 * ①② 靠「临时目录里没有上层 node_modules」暴露，③ 靠「换掉 HOME」暴露。本脚本把这两处补平。
 *
 * ## 用法
 *
 *   npm run verify:ci            # 全流程：临时目录 + npm ci + 六步 + 假 home
 *   npm run verify:ci -- --fast  # 只换 HOME 跑本地那套六步（跳过复制与 npm ci，几秒钟）
 *   npm run verify:ci -- --keep  # 保留临时目录，便于进去手查
 *
 * 刻意**不**并进 `npm run verify`：那是给发布预检用的，每次都复制一遍仓库 + `npm ci` 太慢，
 * 而 CI 那边本来就会跑。它是"本地想提前对齐 CI"时的显式动作。
 */
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = dirname(HERE);
const args = new Set(process.argv.slice(2));
const FAST = args.has('--fast');
const KEEP = args.has('--keep');

/** CI 里 gate 任务的步骤，顺序一致（第 1 步的"干净安装"由本脚本自己完成）。 */
const STEPS = [
  ['Typecheck', ['run', 'typecheck']],
  ['Client smoke', ['run', 'smoke']],
  ['Client render smoke', ['run', 'render-smoke']],
  ['Host smoke', ['run', 'host-smoke']],
];

const OK = '\u001b[32m', BAD = '\u001b[31m', DIM = '\u001b[2m', RESET = '\u001b[0m';
let failed = 0;

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function run(label, cmdArgs, options = {}) {
  const started = Date.now();
  const result = spawnSync(npm, cmdArgs, {
    cwd: options.cwd ?? REPO,
    encoding: 'utf8',
    env: { ...process.env, ...(options.env ?? {}) },
    stdio: options.quiet ? 'pipe' : 'inherit',
  });
  const ms = Date.now() - started;
  if (result.status === 0) {
    console.log(`  ${OK}✓${RESET} ${label} ${DIM}(${ms} ms)${RESET}`);
  } else {
    failed += 1;
    console.log(`  ${BAD}✗${RESET} ${label} ${DIM}(退出码 ${String(result.status)}, ${ms} ms)${RESET}`);
    if (options.quiet) {
      const tail = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim().split('\n').slice(-15).join('\n');
      if (tail !== '') console.log(tail.replace(/^/gm, '      '));
    }
  }
  return result.status === 0;
}

/** 换掉 HOME 跑那批可能依赖 home 的步骤 —— CI 与本机的 home 不同，这里特意也让它不同。 */
function stepsWithForeignHome(cwd, home) {
  console.log(`\n${DIM}用临时 HOME 跑（模拟 CI 的 home，本机是另一个值）：${home}${RESET}`);
  let allOk = true;
  for (const [label, cmdArgs] of STEPS) {
    allOk = run(label, cmdArgs, { cwd, env: { HOME: home, USERPROFILE: home }, quiet: true }) && allOk;
  }
  return allOk;
}

console.log(`\n═══ 模拟 CI（${FAST ? '--fast：只换 HOME' : '完整：干净目录 + npm ci + 假 home'}）═══`);

if (FAST) {
  const home = mkdtempSync(join(tmpdir(), 'hp-ci-home-'));
  try {
    stepsWithForeignHome(REPO, home);
  } finally {
    if (!KEEP) rmSync(home, { recursive: true, force: true });
    else console.log(`  ${DIM}临时 HOME 保留在 ${home}${RESET}`);
  }
} else {
  const dir = mkdtempSync(join(tmpdir(), 'hp-ci-'));
  const home = mkdtempSync(join(tmpdir(), 'hp-ci-home-'));
  try {
    console.log(`${DIM}临时检出：${dir}${RESET}`);
    // 复制时排除 node_modules（正是要让它缺席）与 .git（CI 是 checkout 出来的，不带上层依赖）。
    cpSync(REPO, dir, {
      recursive: true,
      filter: (src) => {
        const rel = src.slice(REPO.length);
        return !rel.startsWith('/node_modules') && !rel.startsWith('/.git') && !rel.endsWith('/.DS_Store');
      },
    });
    // 干净安装：与 CI 的 `npm ci --ignore-scripts` 一致。
    if (!run('npm ci --ignore-scripts', ['ci', '--ignore-scripts'], { cwd: dir, quiet: true })) {
      console.log(`  ${BAD}干净安装就失败了，后面的步骤没有意义${RESET}`);
    } else {
      stepsWithForeignHome(dir, home);
      // 客户端产物可复现：构建一遍，产物必须与仓库里那份逐字节一致。
      if (run('Client bundle is reproducible', ['run', 'build'], { cwd: dir, quiet: true })) {
        const a = readFileSync(join(REPO, 'lib', 'client.js'));
        const b = readFileSync(join(dir, 'lib', 'client.js'));
        const same = a.length === b.length && a.equals(b);
        if (same) console.log(`  ${OK}✓${RESET} 产物与仓库里的 lib/client.js 逐字节一致`);
        else {
          failed += 1;
          console.log(`  ${BAD}✗${RESET} 产物与仓库里的 lib/client.js 不一致 —— 改了 src/client 却忘了 npm run build`);
        }
      }
      // 发布包形态（CI 的最后一步）。
      run('Package shape (npm pack --dry-run)', ['pack', '--dry-run', '--ignore-scripts'], { cwd: dir, quiet: true });
    }
  } finally {
    if (!KEEP) {
      rmSync(dir, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    } else {
      console.log(`  ${DIM}临时目录保留在 ${dir}${RESET}`);
    }
  }
}

if (!existsSync(join(REPO, 'package-lock.json'))) {
  console.log(`  ${BAD}没有 package-lock.json —— CI 用的是 npm ci，缺它跑不起来${RESET}`);
  failed += 1;
}

console.log(failed === 0
  ? `\n${OK}CI 模拟全部通过${RESET}\n`
  : `\n${BAD}CI 模拟有 ${failed} 处失败${RESET} —— 这正是 CI 会红的地方\n`);
process.exit(failed === 0 ? 0 : 1);
