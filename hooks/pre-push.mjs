#!/usr/bin/env node
/**
 * pre-push —— 拦住「改了代码却忘了发布」。
 * 安装：node release.mjs hooks install      卸载：node release.mjs hooks uninstall
 * 绕过：git push --no-verify
 *
 * 规则（只检查推送到 main / master 的情况）：
 *   最新 tag 之后还有 commit（说明有未发布的改动）时，
 *   若 package.json 的 version 仍等于最新 tag 的版本号 → 拦下，提示先跑 release.mjs；
 *   若版本号已经改过（说明走过发布流程）→ 放行。
 *   没有 package.json 的项目只提醒，不拦。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const PROTECTED = ['main', 'master']
const git = (args, cwd) => spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true })
const out = (r) => (r.stdout || '').trim()
const ok = (r) => r.status === 0

function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve('')
    let s = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (d) => { s += d })
    process.stdin.on('end', () => resolve(s))
    setTimeout(() => resolve(s), 1500)
  })
}

async function main() {
  const input = await readStdin()
  const toProtected = input
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .some((l) => {
      const remoteRef = l.split(/\s+/)[2] || ''
      return remoteRef.startsWith('refs/heads/') && PROTECTED.includes(remoteRef.slice(11))
    })
  if (!toProtected) return 0

  const rootR = git(['rev-parse', '--show-toplevel'])
  if (!ok(rootR)) return 0
  const root = out(rootR)

  const tagR = git(['describe', '--tags', '--abbrev=0'], root)
  const tag = ok(tagR) ? out(tagR) : ''
  const countR = git(['rev-list', '--count', tag ? tag + '..HEAD' : 'HEAD'], root)
  const pending = ok(countR) ? Number(out(countR)) : 0
  if (pending === 0) return 0

  const pkgPath = join(root, 'package.json')
  if (!existsSync(pkgPath)) {
    console.log('\n!  ' + (tag || '（还没有 tag）') + ' 之后有 ' + pending + ' 个 commit 还没发布。')
    console.log('   这个项目没有 package.json，无法核对版本；记得打 tag、建 Release。\n')
    return 0
  }

  let version = null
  try { version = JSON.parse(readFileSync(pkgPath, 'utf8')).version || null } catch { return 0 }
  const tagVersion = tag ? tag.replace(/^v/, '') : null

  if (tagVersion && version === tagVersion) {
    console.error('')
    console.error('x  拦下了：' + tag + ' 之后还有 ' + pending + ' 个 commit，但 package.json 的版本号还是 ' + version + '。')
    console.error('   装了旧版的人不会看到任何更新提示 —— 先把版本发出去：')
    console.error('')
    console.error('     node <release-tools>/release.mjs . --notes "这次改了什么"')
    console.error('')
    console.error('   确实不需要发版（只改了注释/文档）可以绕过：git push --no-verify')
    console.error('')
    return 1
  }
  if (tagVersion && version !== tagVersion) {
    const probe = git(['tag', '-l', 'v' + version], root)
    if (!(ok(probe) && out(probe) === 'v' + version)) {
      console.log('\n!  版本号已改成 ' + version + '，但 tag v' + version + ' 还没打（或还没推）。\n')
    }
  }
  return 0
}

main().then((c) => process.exit(c)).catch((e) => { console.error(e.message); process.exit(0) })
