#!/usr/bin/env node
/**
 * release.mjs —— 一条命令完成一次发布，杜绝「改了代码，却忘了 bump 版本 / 打 tag / 建 Release」。
 *
 * 子命令（默认 release）：
 *   node release.mjs [目录] [--bump patch|minor|major|auto] [--notes "要点"] [--title "标题"]
 *                    [--dry-run] [--no-changelog] [--no-release]
 *   node release.mjs check <目录...>           只检查，不改动任何东西
 *   node release.mjs scan <根目录> [--depth N] 扫描下面的 git 仓库并逐个检查
 *   node release.mjs hooks install|uninstall [目录...]
 *
 * release 做的事：
 *   1. 读 package.json 版本与最新 git tag，算出下一个版本号（auto 时看 commit 前缀：feat→minor，feat!/BREAKING→major，其余→patch）
 *   2. 改 package.json 的 version，往 CHANGELOG.md 插入一节
 *   3. git add -A → commit「发布 vX.Y.Z」→ 打 tag vX.Y.Z
 *   4. push 分支与 tag（优先 GCM 凭据；不行则用 token 拼 URL，始终不改动 remote 配置）
 *   5. 调 GitHub API 建 Release，说明取 CHANGELOG 里刚写入的那一节
 *
 * 凭据来源：环境变量 GITHUB_TOKEN / GH_TOKEN，其次 `git credential fill`（Git Credential Manager）。
 * token 只存在于内存与子进程参数里，不写进仓库文件，也不进 remote 配置；日志里会脱敏。
 *
 * 退出码：0 成功；1 失败；2 参数/前置条件错误。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve, basename } from 'node:path'

const HELP = `用法：
  node release.mjs [目录] [--bump patch|minor|major|auto] [--notes "要点"] [--title "标题"]
                   [--dry-run] [--no-changelog] [--no-release]
  node release.mjs check <目录...>
  node release.mjs scan <根目录> [--depth N]
  node release.mjs hooks install|uninstall [目录...]

选项：
  --bump <kind>   版本递增方式，默认 auto
  --notes <文本>  Release / CHANGELOG 的说明；缺省取最后一次 commit 的主题
  --title <文本>  Release 标题，缺省 vX.Y.Z
  --dry-run       只打印将要做什么，不写文件、不提交、不推送
  --no-changelog  不碰 CHANGELOG.md
  --no-release    只推代码，不建 GitHub Release
  --force         忽略「该版本 tag 已存在」之类的软性阻拦
`

// ---------- 基础工具 ----------
const isWin = process.platform === 'win32'

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, ...opts })
  if (r.error) {
    if (opts.allowFail) return r
    throw new Error(`${cmd} 无法执行：${r.error.message}`)
  }
  if (r.status !== 0 && !opts.allowFail) {
    const tail = ((r.stderr || '') + (r.stdout || '')).trim()
    throw new Error(`${cmd} ${args.join(' ')} 退出码 ${r.status}\n${tail}`)
  }
  return r
}
const git = (args, cwd, allowFail = false) => run('git', args, { cwd, allowFail })
const out = (r) => ((r.stdout || '').trim())
const ok = (r) => r.status === 0
const C = { red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', dim: '\x1b[2m', off: '\x1b[0m' }
const say = (...a) => console.log(...a)
const warn = (...a) => console.log(C.yellow + '! ' + C.off + a.join(' '))
const bad = (...a) => console.log(C.red + 'x ' + C.off + a.join(' '))
const good = (...a) => console.log(C.green + '√ ' + C.off + a.join(' '))

function parseArgs(argv) {
  const known = ['release', 'check', 'scan', 'hooks', 'help', '--help', '-h']
  let sub = 'release'
  const rest = [...argv]
  if (rest[0] && known.includes(rest[0]) && !rest[0].startsWith('-')) sub = rest.shift()
  const opts = { positional: [], bump: 'auto', notes: null, title: null, dryRun: false, changelog: true, release: true, force: false, depth: 1 }
  while (rest.length) {
    const a = rest.shift()
    if (a === '--bump') opts.bump = rest.shift()
    else if (a === '--notes') opts.notes = rest.shift()
    else if (a === '--title') opts.title = rest.shift()
    else if (a === '--depth') opts.depth = Number(rest.shift())
    else if (a === '--dry-run' || a === '-n') opts.dryRun = true
    else if (a === '--no-changelog') opts.changelog = false
    else if (a === '--no-release') opts.release = false
    else if (a === '--force' || a === '-f') opts.force = true
    else if (a === '--help' || a === '-h') opts.help = true
    else if (a.startsWith('-')) throw Object.assign(new Error('未知选项 ' + a), { code: 2 })
    else opts.positional.push(a)
  }
  return { sub, opts }
}

// ---------- 仓库信息 ----------
function isRepo(dir) {
  const r = git(['rev-parse', '--git-dir'], dir, true)
  return ok(r)
}
function remoteRepo(dir) {
  const r = git(['remote', 'get-url', 'origin'], dir, true)
  if (!ok(r)) return null
  const url = out(r)
  const m = /github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?$/i.exec(url)
  return m ? { owner: m[1], repo: m[2], url } : { owner: null, repo: null, url }
}
function readPkg(dir) {
  const p = join(dir, 'package.json')
  if (!existsSync(p)) return null
  try { return { path: p, data: JSON.parse(readFileSync(p, 'utf8')) } } catch { return null }
}
function writeVersion(pkgPath, version) {
  const src = readFileSync(pkgPath, 'utf8')
  const re = /("version"\s*:\s*")([^"]*)(")/
  if (!re.test(src)) throw new Error('package.json 里找不到 version 字段')
  writeFileSync(pkgPath, src.replace(re, `$1${version}$3`), 'utf8')
}
function latestTag(dir) {
  const r = git(['describe', '--tags', '--abbrev=0'], dir, true)
  return ok(r) && out(r) !== '' ? out(r) : null
}
function currentBranch(dir) {
  const r = git(['rev-parse', '--abbrev-ref', 'HEAD'], dir, true)
  return ok(r) ? out(r) : 'main'
}
function versionFromTag(tag) { return tag ? tag.replace(/^v/, '') : null }
function bumpVersion(v, kind) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v || '')
  if (!m) throw new Error(`版本号格式不认识：${v}（只支持 x.y.z）`)
  let [a, b, c] = [Number(m[1]), Number(m[2]), Number(m[3])]
  if (kind === 'major') { a += 1; b = 0; c = 0 }
  else if (kind === 'minor') { b += 1; c = 0 }
  else { c += 1 }
  return `${a}.${b}.${c}`
}
function subjectsSince(tag, dir) {
  const args = tag ? ['log', '--pretty=format:%s', `${tag}..HEAD`] : ['log', '--pretty=format:%s']
  const r = git(args, dir, true)
  if (!ok(r)) return []
  return out(r).split('\n').map((s) => s.trim()).filter(Boolean)
}
function countSince(tag, dir) {
  const r = git(['rev-list', '--count', tag ? `${tag}..HEAD` : 'HEAD'], dir, true)
  return ok(r) ? Number(out(r)) || 0 : 0
}
function dirtyFiles(dir) {
  const r = git(['status', '--porcelain'], dir, true)
  if (!ok(r)) return []
  return out(r).split('\n').map((s) => s.trim()).filter(Boolean)
}
function decideBump(subjects) {
  let major = false
  let minor = false
  for (const s of subjects) {
    if (/^[a-z]+(\([^)]*\))?!:/.test(s) || /BREAKING[ -]CHANGE/i.test(s)) major = true
    else if (/^feat(\([^)]*\))?:/.test(s)) minor = true
  }
  return major ? 'major' : minor ? 'minor' : 'patch'
}

// ---------- 凭据 ----------
function githubToken() {
  for (const k of ['GITHUB_TOKEN', 'GH_TOKEN']) if (process.env[k]) return process.env[k].trim()
  const r = spawnSync('git', ['credential', 'fill'], {
    input: 'protocol=https\nhost=github.com\n\n',
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, GCM_INTERACTIVE: 'never' },
  })
  if (r.status !== 0) return null
  const m = /^password=(.*)$/m.exec(r.stdout || '')
  return m ? m[1].trim() : null
}
const scrub = (s, token) => (token ? String(s).split(token).join('***') : String(s))

// ---------- CHANGELOG ----------
function changelogSection(version, date, notes) {
  const lines = [`## v${version} — ${date}`, '']
  for (const n of notes.split(/\r?\n/).map((s) => s.replace(/^[-*]\s*/, '').trim()).filter(Boolean)) {
    lines.push(/^[-*]/.test(n) ? n : `- ${n}`)
  }
  lines.push('')
  return lines.join('\n')
}
function updateChangelog(dir, section, dryRun) {
  const p = join(dir, 'CHANGELOG.md')
  if (!existsSync(p)) {
    const head = `# 更新日志\n\n本文件由 release.mjs 维护。\n\n`
    if (!dryRun) writeFileSync(p, head + section, 'utf8')
    return p
  }
  const src = readFileSync(p, 'utf8')
  const lines = src.split('\n')
  let insertAt = lines.findIndex((l) => /^#\s/.test(l) || /^##\s/.test(l))
  insertAt = insertAt === -1 ? 0 : insertAt + 1
  // 跳过紧随标题的空行
  while (insertAt < lines.length && lines[insertAt].trim() === '') insertAt += 1
  const next = [...lines.slice(0, insertAt), section, ...lines.slice(insertAt)]
  if (!dryRun) writeFileSync(p, next.join('\n'), 'utf8')
  return p
}
function changelogBodyFor(dir, version) {
  const p = join(dir, 'CHANGELOG.md')
  if (!existsSync(p)) return null
  const lines = readFileSync(p, 'utf8').split('\n')
  const start = lines.findIndex((l) => l.startsWith(`## v${version}`))
  if (start === -1) return null
  let end = lines.findIndex((l, k) => k > start && l.startsWith('## '))
  if (end === -1) end = lines.length
  return lines.slice(start, end).join('\n').trim()
}

// ---------- GitHub Release ----------
async function createRelease({ owner, repo, tag, title, body, token }) {
  const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/releases`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'content-type': 'application/json',
      'user-agent': 'dsh-release-tools',
    },
    body: JSON.stringify({ tag_name: tag, name: title, body, draft: false, prerelease: /-/.test(tag) }),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`GitHub Release 创建失败（HTTP ${res.status}）：${text.slice(0, 300)}`)
  return JSON.parse(text)
}

// ---------- 主流程：release ----------
async function doRelease(opts) {
  const dir = resolve(opts.positional[0] || '.')
  if (!isRepo(dir)) { bad(`${dir} 不是一个 git 仓库`); return 2 }
  const pkg = readPkg(dir)
  const repo = remoteRepo(dir)
  const branch = currentBranch(dir)
  const tag = latestTag(dir)
  const tagVersion = versionFromTag(tag)
  const pkgVersion = pkg?.data?.version ?? null
  const base = pkgVersion ?? tagVersion
  if (!base) { bad('既没有 package.json 的 version，也没有任何 tag，无法推断版本号（先用 --bump 显式指定也需一个起点）'); return 2 }

  const subjects = subjectsSince(tag, dir)
  const firstRelease = tag === null
  const kind = opts.bump !== 'auto' ? opts.bump : firstRelease ? 'none' : decideBump(subjects)
  if (!['patch', 'minor', 'major', 'none'].includes(kind)) { bad(`--bump 只支持 patch|minor|major|auto，收到 ${opts.bump}`); return 2 }
  const nextVersion = kind === 'none' ? base : bumpVersion(base, kind)
  const nextTag = `v${nextVersion}`
  const notes = opts.notes ?? (subjects[0] || `发布 ${nextTag}`)
  const title = opts.title ?? nextTag
  const date = new Date().toISOString().slice(0, 10)

  say(`\n${C.dim}仓库${C.off} ${dir}`)
  say(`${C.dim}远程${C.off} ${repo?.owner ? `${repo.owner}/${repo.repo}` : repo?.url ?? '(没有 origin)'}`)
  say(`${C.dim}分支${C.off} ${branch}`)
  say(`${C.dim}当前${C.off} package.json=${pkgVersion ?? '-'} 最新 tag=${tag ?? '-'}`)
  say(`${C.dim}待发布${C.off} ${tag ?? '初始'} 之后 ${subjects.length} 个 commit`)
  for (const s of subjects.slice(0, 10)) say(`   ${C.dim}·${C.off} ${s}`)
  if (subjects.length > 10) say(`   ${C.dim}…${C.off}`)
  say(`${C.dim}计划${C.off} ${base} → ${C.green}${nextVersion}${C.off}（${kind}${firstRelease ? '，首次发布沿用现有版本号' : ''}） tag ${nextTag}`)
  if (opts.dryRun) { warn('--dry-run：到此为止，什么都没改'); return 0 }

  const existing = git(['tag', '-l', nextTag], dir, true)
  if (ok(existing) && out(existing) === nextTag && !opts.force) {
    warn(`tag ${nextTag} 已存在；若确认要重做请加 --force`)
    return 1
  }

  // 1) 版本号 + CHANGELOG
  if (pkg && pkg.data.version !== nextVersion) {
    writeVersion(pkg.path, nextVersion)
    say(`√ 已改 ${basename(pkg.path)} → ${nextVersion}`)
  }
  if (opts.changelog) {
    const section = changelogSection(nextVersion, date, notes)
    const p = updateChangelog(dir, section, false)
    say(`√ 已更新 ${basename(p)}`)
  }
  // 2) 提交 + tag
  const dirty = dirtyFiles(dir)
  if (dirty.length === 0 && subjects.length === 0) { warn('没有任何改动，也没有新 commit，无需发布'); return 1 }
  git(['add', '-A'], dir)
  git(['commit', '-m', `发布 ${nextTag}`, '-m', notes], dir)
  say(`√ 已提交 发布 ${nextTag}`)
  const tagExists = ok(git(['tag', '-l', nextTag], dir, true)) && out(git(['tag', '-l', nextTag], dir, true)) === nextTag
  git(tagExists ? ['tag', '-f', nextTag] : ['tag', nextTag], dir)
  say(`√ 已${tagExists ? '强制重打' : '打'} tag ${nextTag}`)
  const sha = out(git(['rev-parse', 'HEAD'], dir))
  // 3) 推送
  const token = githubToken()
  let pushOk = false
  if (repo?.owner && token) {
    const url = `https://x-access-token:${token}@github.com/${repo.owner}/${repo.repo}.git`
    const r1 = run('git', ['push', url, `HEAD:refs/heads/${branch}`], { cwd: dir, allowFail: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })
    if (ok(r1)) {
      const r2 = run('git', ['push', url, `${opts.force ? '+' : ''}refs/tags/${nextTag}`], { cwd: dir, allowFail: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })
      if (ok(r2)) { pushOk = true; good(`已推送 ${branch} 与 ${nextTag}`) }
      else bad('推送 tag 失败：' + scrub((r2.stderr || r2.stdout || '').trim(), token))
    } else bad('推送分支失败：' + scrub((r1.stderr || r1.stdout || '').trim(), token))
  }
  if (!pushOk) {
    const r1 = git(['push', 'origin', branch], dir, true)
    if (ok(r1)) {
      const r2 = git(['push', 'origin', nextTag], dir, true)
      if (ok(r2)) { pushOk = true; good('已推送（走 git 自身凭据）') }
    }
    if (!pushOk) warn('推送没成功。若在 bash 下运行，请改到 pwsh 里跑（GCM 凭据），或设置 GITHUB_TOKEN')
  }
  // 4) Release
  if (opts.release && pushOk && repo?.owner) {
    if (!token) { warn('拿不到 GitHub 凭据，跳过 Release；可在网页上手动建，或设置 GITHUB_TOKEN') }
    else {
      const body = changelogBodyFor(dir, nextVersion) ?? notes
      try {
        const rel = await createRelease({ owner: repo.owner, repo: repo.repo, tag: nextTag, title, body, token })
        good(`Release 已建：${rel.html_url}`)
      } catch (e) {
        // tag 刚推上去时 API 偶发 422，重试一次
        try {
          await new Promise((r) => setTimeout(r, 2500))
          const rel = await createRelease({ owner: repo.owner, repo: repo.repo, tag: nextTag, title, body, token })
          good(`Release 已建：${rel.html_url}`)
        } catch (e2) { bad('Release 创建失败：' + e2.message) }
      }
    }
  }
  say(`\n${C.green}完成${C.off} ${repo?.owner ? `https://github.com/${repo.owner}/${repo.repo}` : ''} ${sha.slice(0, 7)} ${nextTag}`)
  return 0
}

// ---------- 检查 ----------
function checkRepo(dir) {
  const name = basename(dir)
  if (!isRepo(dir)) return { dir, name, skip: true }
  const pkg = readPkg(dir)
  const tag = latestTag(dir)
  const tagVersion = versionFromTag(tag)
  const version = pkg?.data?.version ?? tagVersion
  const dirty = dirtyFiles(dir)
  const pending = countSince(tag, dir)
  const issues = []
  if (dirty.length) issues.push(`未提交改动 ${dirty.length} 项`)
  if (pkg && tag && pkg.data.version !== tagVersion) issues.push(`package.json=${pkg.data.version} 与 tag ${tag} 不一致`)
  if (pending > 0) issues.push(`${tag ?? '初始'} 后有 ${pending} 个未发布 commit`)
  const subjects = subjectsSince(tag, dir)
  const kind = decideBump(subjects)
  return { dir, name, version, tag, dirty: dirty.length, pending, issues, nextVersion: pending > 0 ? bumpVersion(version, kind) : null, kind }
}
function printCheck(results) {
  let bad_ = 0
  for (const r of results) {
    if (r.skip) continue
    if (r.issues.length === 0) { good(`${r.name.padEnd(28)} ${r.version ?? '-'} 已是最新`); continue }
    bad_ += 1
    bad(`${r.name.padEnd(28)} ${r.version ?? '-'} → 建议 ${r.nextVersion ?? '?'}  ${r.issues.join('；')}`)
  }
  if (bad_ === 0) say(`\n${C.green}全部干净${C.off}`)
  else say(`\n${C.yellow}${bad_} 个仓库有未发布的改动${C.off} —— 在其中跑 node ${isWin ? 'D:/dsh/config/release-tools/release.mjs' : 'release.mjs'} 即可发布`)
  return bad_ === 0 ? 0 : 1
}
function walkRepos(root, depth) {
  const found = []
  const visit = (d, left) => {
    if (left < 0) return
    let entries = []
    try { entries = readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.') || e.name === 'node_modules') continue
      const p = join(d, e.name)
      if (existsSync(join(p, '.git'))) { found.push(p); continue }
      if (left > 0) visit(p, left - 1)
    }
  }
  visit(root, depth)
  return found
}

// ---------- hooks ----------
const HOOK_BODY = `#!/bin/sh
# 由 dsh-release-tools 安装：防止「改了代码却忘了 bump 版本」被推上去。
# 绕过：git push --no-verify   卸载：node release.mjs hooks uninstall
exec "@NODE@" "@RELEASE_TOOLS@/hooks/pre-push.mjs"
`
function installHooks(dirs) {
  const home = resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
  let n = 0
  for (const d of dirs) {
    const gitDir = git(['rev-parse', '--git-dir'], d, true)
    if (!ok(gitDir)) { warn(`${d} 不是 git 仓库，跳过`); continue }
    const hooksDir = join(d, out(gitDir), 'hooks')
    const p = join(hooksDir, 'pre-push')
    if (existsSync(p) && !readFileSync(p, 'utf8').includes('dsh-release-tools')) {
      warn(`${d} 已有一个非本工具的 pre-push，保留不动`)
      continue
    }
    const body = HOOK_BODY.replace('@RELEASE_TOOLS@', home.replace(/\\/g, '/')).replace('@NODE@', process.execPath.replace(/\\/g, '/'))
    writeFileSync(p, body, 'utf8')
    say(`√ 已安装 pre-push：${p}`)
    n += 1
  }
  return n
}

// ---------- 入口 ----------
async function main() {
  let parsed
  try { parsed = parseArgs(process.argv.slice(2)) } catch (e) { bad(e.message); say(HELP); return 2 }
  const { sub, opts } = parsed
  if (opts.help || sub === 'help') { say(HELP); return 0 }
  if (sub === 'release') return doRelease(opts)
  if (sub === 'check') {
    const dirs = (opts.positional.length ? opts.positional : ['.']).map((d) => resolve(d))
    return printCheck(dirs.map(checkRepo))
  }
  if (sub === 'scan') {
    const root = resolve(opts.positional[0] || '.')
    const repos = walkRepos(root, Math.max(0, (opts.depth || 1) - 1))
    say(`扫描到 ${repos.length} 个 git 仓库\n`)
    return printCheck(repos.map(checkRepo))
  }
  if (sub === 'hooks') {
    const action = opts.positional.shift() || 'install'
    const dirs = (opts.positional.length ? opts.positional : ['.']).map((d) => resolve(d))
    if (action === 'uninstall') {
      for (const d of dirs) {
        const g = git(['rev-parse', '--git-dir'], d, true)
        if (!ok(g)) continue
        const p = join(d, out(g), 'hooks', 'pre-push')
        if (existsSync(p) && readFileSync(p, 'utf8').includes('dsh-release-tools')) { writeFileSync(p, '', 'utf8'); say(`√ 已清空 ${p}`) }
      }
      return 0
    }
    installHooks(dirs)
    return 0
  }
  say(HELP)
  return 2
}

main().then((code) => process.exit(code ?? 0)).catch((e) => { bad(e.message); process.exit(1) })
