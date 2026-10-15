# 更新日志

## v0.1.1 — 2026-10-15

- 新增 tools/get-github-token.ps1：绕过失效的 git credential fill，直接从 Windows 凭据管理器读 token。README 补充 --repo 说明。

本文件由 release.mjs 维护。

## v0.1.0 — 2026-10-15

- First release. One command to publish a repo: bump version, write CHANGELOG, commit, tag, push, and create the GitHub Release. Also ships an optional pre-push hook that blocks a push when the version was never bumped.
