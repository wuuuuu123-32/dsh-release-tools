# dsh-release-tools

一条命令完成一次发布：**bump 版本 → 记 CHANGELOG → 提交 → 打 tag → 推送 → 建 GitHub Release**，
顺手拦下最烦人的那种事故——「代码改了、推上去了，版本号忘了动」。

```bash
node release.mjs          # 发布当前项目
node release.mjs --dry-run # 先空跑看看
```

零依赖，只要 Node 18+ 和 git。

## 为什么需要它

DSH 插件市场（dshmarket）是这样判断「有没有新版本」的：github 来源的插件，拿你 lockfile 里锁的 commit
和远端 HEAD 比，不一样就提示可更新。所以 **push 了就会被看到** —— 但用户看到的只是「有一堆新提交」，
真正的版号和「这次改了什么」得靠 **bump 版本 + 打 tag + 建 Release** 才有。

忘了 bump 版本，等于用户永远收不到像样的更新提示。这个工具的 pre-push 钩子就会在推 main 时把这种提交拦下来。

## 用法

```bash
# 扫一遍工作区，看看哪些项目有「还没发布的东西」（不改动任何文件）
node release.mjs scan D:/dsh/config --depth 2

# 发布当前项目，自动判断该升 patch / minor 还是 major
node release.mjs

# 指定说明和标题
node release.mjs . --notes "修复了退出时崩溃" --title "稳定性修复"

# 只推代码，不建 Release / 不写 CHANGELOG
node release.mjs --no-release --no-changelog

# 仓库还没有 origin 时，显式指定推到哪儿
node release.mjs . --repo wuuuuu123-32/my-plugin
```

版本号怎么定（`--bump auto`，默认）：

| commit 主题 | 结果 |
|---|---|
| `feat: ...` | minor |
| `feat!: ...` 或正文含 `BREAKING CHANGE` | major |
| 其它 | patch |
| 项目从没打过 tag | 沿用 package.json 里现有的版本号，直接发首次版本 |

## 钩子：让「忘了发版」根本推不上去

```bash
node release.mjs hooks install D:/dsh/config/my-plugin       # 装 pre-push
node release.mjs hooks uninstall D:/dsh/config/my-plugin     # 卸载
```

装完后，往 main / master 推送时，如果「最新 tag 之后还有 commit，但 package.json 的版本号没变」，
会被直接拦下并提示先发版。确实不需要发版时用 `git push --no-verify` 绕过。

没有 package.json 的项目只提醒、不拦（纯文档仓库也能装）。

## 凭据

推送优先用环境变量 `GITHUB_TOKEN` / `GH_TOKEN`；没有就调 `git credential fill`（Git Credential Manager）。
token 只用于拼一次性的推送 URL 和调 GitHub API —— **不写进 remote 配置、不落盘**，日志里也会脱敏。

> Windows 上请在 **PowerShell** 里运行。在 bash / Git Bash 下，GCM 拿不到凭据，
> 会报 `could not read Username for 'https://github.com'`。

实测 `git credential fill` 并非处处可用（这台机器上 GCM 不在 PATH，会报
`fatal: Cannot prompt because user interactivity has been disabled.`）。凭据本身还躺在
Windows 凭据管理器里，可以绕过 git 直接读：

```powershell
$env:GITHUB_TOKEN = & tools/get-github-token.ps1
node release.mjs .
```

`tools/get-github-token.ps1` 读 `git:https://github.com` 这条凭据并输出 token；它只在你显式运行时读一次，
不缓存、不落盘。（脚本是纯 ASCII —— 含 BOM 的 .ps1 会让 Windows PowerShell 5.1 解析出错。）

## 子命令一览

| 命令 | 作用 |
|---|---|
| `release [目录]` | 默认子命令，完整走一遍发布 |
| `check <目录...>` | 只报告状态，不改动任何东西 |
| `scan <根目录> [--depth N]` | 扫出下面的 git 仓库，逐个 check |
| `hooks install\|uninstall [目录...]` | 装 / 卸 pre-push 钩子 |

选项：`--bump <kind>` `--notes <文本>` `--title <文本>` `--repo <owner/name>` `--dry-run` `--no-changelog` `--no-release` `--force` `--depth <N>`

退出码：0 成功 / 1 有问题（check 发现未发布改动，或发布失败）/ 2 参数或前置条件错误。

## License

MIT
