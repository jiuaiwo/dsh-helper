# 发布到 npm

面向维护者。装/用的说明看 [README](../README.md)，实现约定看 [DEVELOPMENT](./DEVELOPMENT.md)。

## 当前状态

| 项 | 值 |
| --- | --- |
| 包名 | `dsh-helper`（registry 上**未被占用**） |
| registry | `https://registry.npmjs.org/` |
| GitHub 仓库 | `jiuaiwo/dsh-helper`，**private**；`origin` 走 Host 别名 `github-jiuaiwo` |
| 已发布版本 | **0.5.0**（2026-09-26；0.4.0 及更早只存在于本地 git 历史） |
| 当前开发版本 | **0.5.1**（未发布） |

一次性准备（已完成）：`origin` 已配好（`~/.ssh/config` 的 `github-jiuaiwo` 别名 + 钥匙串凭据）。
npm 需先 `npm login`（发布过 2FA，长期建议用 Automation token）。

## 发布前预检

按顺序跑，任何一步不过就停：

```bash
cd dsh-helper

# 1. 工作树干净（有未提交的已跟踪文件时 npm version 会拒绝）
git status --short

# 2. 自检：typecheck + build + 客户端冒烟 + 渲染冒烟 + host 冒烟
npm run verify

# 3. 构建产物与源码同步：build 之后工作树必须仍干净
git status --short          # 有 diff 就说明 lib/client.js 没提交

# 4. 未跟踪文件不能落在 files 白名单里
git status --porcelain --untracked-files=all | grep '^??'

# 5. 打包清单与体积
npm pack --dry-run
```

第 4 步是踩过的坑：**未跟踪文件只要落在 `files` 白名单内就会被 `npm pack` 打进包**，而它不在 git 里——
tag 指向的提交重建不出同一个包。第 5 步期望清单应有 `lib/`、`src/host/`、`icon.svg`、`cordis.patch.yml`、
`README.md`、`CHANGELOG.md`、`LICENSE`、`docs/*.md`、`docs/*.png`；**不应**出现 `tools/`、`src/client/`、`docs/superpowers/`。

## 发布步骤

> **版本号随提交走**：每次 git 提交都先把 `package.json` 的版本号升一级、变化写进 CHANGELOG
>（用户 2026-09-26 定的规矩）。所以**发布时不要再跑 `npm version`** —— 那会把已经提交好的版本
> 又升一级，发出去的号与 CHANGELOG、tag 就对不上。`package.json` 里那个号就是待发版本。

```bash
# 推荐：直接走运维台 —— 它会造发布快照、把 tag 落在快照上再推，不会带出本地历史
bash ops/tz.sh publish --current

# 手工等价流程（照这个顺序做，别改成 git push --follow-tags）：
# 1. 给当前版本打 annotated tag（版本号已在提交里升好）
V="$(node -p 'require("./package.json").version')"
git tag -a "v$V" -m "v$V"

# 2. 造一条无父提交的发布快照（树 = 当前提交的树），并把 tag 指过去
SNAP="$(git commit-tree "$(git rev-parse 'HEAD^{tree}')" -m "dsh-helper $V")"
git update-ref refs/heads/github "$SNAP"
git tag -fa "v$V" -m "v$V" "$SNAP"

# 3. 只推快照与 tag（远端 main 永远 1 条，不含开发历史）
git push -f origin refs/heads/github:refs/heads/main
git push origin "refs/tags/v$V"

# 4. 发布（2FA）
npm publish
```

- 版本号策略：按语义化版本，**每次提交都升一级**（默认 `patch`，破坏性改动——改包名/路由前缀/
  配置目录——走 minor/major），并把用户可见的变化写进 CHANGELOG 顶部「未发布」段落。
- 打 tag 用 `git tag -a`（annotated）而不是 `git tag`：发布 tag 要与 GitHub 上的 Release、npm
  上的号一一对应（轻量 tag 在 `--follow-tags` 时代还会被静默忽略 —— 结果就是「发出去了却没 tag」）。
- **别用 `git push --follow-tags`**（2026-10-06 定）：远端 `main` 只收一条**无父提交的发布快照**，
  tag 必须落在快照上。tag 自带父链 —— 在本地 `main` 上打 tag 再 `--follow-tags`，即使分支推送被
  non-fast-forward 拒绝、命令退出码非 0，**tag 照样推成功**，从远端 clone 顺着它就能看到全部开发
  提交（实测复现）。`ops/git-hooks/pre-push` 是拦这件事的闸，
  安装：`git config core.hooksPath ops/git-hooks`。
  （`npm version` 本来也会生成 annotated tag，但按上面那条规矩发布时**不要**用它。）
- `prepublishOnly` 已挂上 `npm run verify && npm pack --dry-run`（0.12.0 起），所以 `npm publish`
  自己会跑一遍完整门禁（typecheck + build + 三套冒烟 + 打包清单）。上面第 2 步的手动
  `npm run verify` 仍然值得先跑：失败在本地比失败在 publish 中途好收拾。
  这条曾经写着"本包没有把 build/verify 挂到发布钩子，必须手动跑" —— 那个缺口就是
  「改了但忘了跑自检」能一路走到发布的原因，现在由钩子与 CI 双重兜住。
- CI（`.github/workflows/ci.yml`）跑的是同一套门禁，另加一条"客户端产物可复现"
  （构建后 `git diff --exit-code -- lib/client.js`）：改了 `src/client/` 却忘记 `npm run build` 时，
  仓库里那份产物会悄悄落后于源码，而装到宿主上跑的正是产物。
- 非 scoped 包默认 public，`publishConfig.access: "public"` 只是显式声明。
- 发完把 CHANGELOG 里 `## [x.y.z] — 未发布` 改成带日期的正式标题。

## 发布后验证

```bash
npm view dsh-helper version dist.tarball
npm view dsh-helper           # 确认 repository / homepage / license / keywords
```

再打开 `https://www.npmjs.com/package/dsh-helper` 确认 README 渲染与「Repository」链接
（private 仓库下访客点 Repository 会是 404；包本身仍是公开的——npm 是独立 registry，仓库私有不影响发布与安装）。

## 发布后收尾（资源改走 CDN）

私有仓库 + 公开包的组合下，npm 页面会把 README 相对路径按 `repository` 重写到 GitHub，访客无权限——
**相对图片会全裂、相对链接点开 404**。所以**发布成功后立刻**把 README 里的引用换成 CDN 绝对地址：

| 原引用 | 换成 |
| --- | --- |
| `./docs/unread.png` | `https://cdn.jsdelivr.net/npm/dsh-helper/docs/unread.png` |
| `./docs/DEVELOPMENT.md`、`./docs/PUBLISHING.md` | 同上（`files` 已含 `docs/*.md`） |
| `./CHANGELOG.md`、`./LICENSE` | 同上；`LICENSE` 也可不动（npm 页面自带入口） |

不带版本号 = 始终指向 latest。改完提交推送，再刷新 npm 页面确认图能显示。

> ⚠️ **顺序不能反**：必须在包已发布之后才改。改在前、包还没发时 jsDelivr 上根本没有这个包，
> GitHub 上你自己看 README 反而会裂图。

最后**装到真实 profile 里跑一遍**（从 npm 装是另一条代码路径，`npmName` 非 null 时宿主会做 peer 兼容性判定）：

```bash
cd ~/.dsh/profiles/web
pnpm add dsh-helper@0.5.1
# 确认 dsh.profile.bundles 里有 dsh-helper，然后重启 DSH
```

验的是：设置卡片在、侧栏「定时任务」能开、`send_file_to_im` 能投递、「重启」按钮状态正确。

## 失败与回滚

| 情况 | 处置 |
| --- | --- |
| 预检通过、tag 已打，但 `npm publish` 失败 | 不要升版。修好原因后重跑 `npm publish`（版本号不变，只要该版本 registry 上不存在） |
| 包已发出但有问题 | 72 小时内可 `npm unpublish dsh-helper@0.5.1`；超时只能 `npm deprecate` 并尽快发修复版 |
| 需要重发同一版本号 | 不可能，registry 不接受同号覆盖，只能升版本 |
| `git push` 失败 | 不影响已完成的 `npm publish`。补推这两条：`git push -f origin refs/heads/github:refs/heads/main` 与 `git push origin refs/tags/vX.Y.Z`，否则 tag 只在本机 |
