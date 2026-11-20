// push-github-api.mjs — 通过 api.github.com 的 Git Data API 推送本地提交
// 来源：docs/GITHUB-PUSH-PIPELINE.md（dsh-infinite-context），在逐字复用的基础上补两处：
//   1) **首次推送空仓库**：远端没有 refs/heads/<branch> 时不再报错，而是从根提交开始建
//      （根提交用 `git diff-tree -r --raw` 的全量新增，tree 不带 base_tree，parents 为空，
//      分支用 POST /git/refs 建立）。
//   2) **Release 资产上传**：GH_ASSET 指定的文件以 GH_ASSET_NAME 上传，方便
//      `releases/latest/download/<name>.tgz` 这种稳定安装地址。
// 用法：
//   GH_OWNER=owner GH_REPO=repo GH_BRANCH=main GH_TAG=v1.4.0 GH_RELEASE_NAME="v1.4.0 — 标题" \
//   GH_RELEASE_BODY_FILE=notes.md GH_ASSET=release/pkg-1.4.0.tgz GH_ASSET_NAME=pkg.tgz \
//   GIT_BIN="C:\\Program Files\\Git\\cmd\\git.exe" node scripts/push-github-api.mjs
// 可选：GH_BASE_SHA=<远端当前 main>（默认自动读取）
// 仅在 git push 通道被阻断（github.com:443 的 smart HTTP 被重置）而 api.github.com 可达时使用；
// git push 正常时首选普通 push。
import { execFileSync, execSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { basename } from 'node:path'

const OWNER = process.env.GH_OWNER
const REPO = process.env.GH_REPO
const BRANCH = process.env.GH_BRANCH ?? 'main'
const GIT = process.env.GIT_BIN ?? 'git'
const TAG = process.env.GH_TAG
const RELEASE_NAME = process.env.GH_RELEASE_NAME ?? TAG
const RELEASE_BODY = process.env.GH_RELEASE_BODY_FILE
  ? readFileSync(process.env.GH_RELEASE_BODY_FILE, 'utf8')
  : (process.env.GH_RELEASE_BODY ?? '')
const ASSET = process.env.GH_ASSET
const ASSET_NAME = process.env.GH_ASSET_NAME ?? (ASSET ? basename(ASSET) : undefined)
if (!OWNER || !REPO) throw new Error('GH_OWNER / GH_REPO required')

// --- token：从 git 凭据库读取，绝不打印 ---
const cred = execSync(`"${GIT}" credential fill`, {
  input: 'protocol=https\nhost=github.com\n\n',
  encoding: 'utf8',
  env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
})
const token = cred.match(/^password=(.*)$/m)?.[1]
if (!token) throw new Error('no GitHub token in the credential store')

const H = {
  Authorization: `Bearer ${token}`,
  Accept: 'application/vnd.github+json',
  'user-agent': 'push-github-api',
  'content-type': 'application/json',
}
async function api(method, pathname, body) {
  // 上游那份脚本把所有路径都拼在 /repos/<owner>/<repo> 后面，于是 `GET /user` 变成
  // /repos/<owner>/<repo>/user 而 404。这里按路径性质分流：/user 与 /repos/… 是绝对路径，
  // 其余（/git/…、/releases）挂在仓库命名空间下。
  const absolute = pathname === '/user' || pathname.startsWith('/repos/')
  const r = await fetch(`https://api.github.com${absolute ? pathname : `/repos/${OWNER}/${REPO}${pathname}`}`, {
    method, headers: H, body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await r.text()
  let json
  try { json = JSON.parse(text) } catch { json = text.slice(0, 400) }
  if (r.status >= 300) throw new Error(`${method} ${pathname} -> ${r.status}: ${JSON.stringify(json).slice(0, 400)}`)
  return json
}
const git = (args) => execFileSync(GIT, args, { maxBuffer: 1 << 28 })
const gitText = (args) => git(args).toString('utf8')

// --- 0) 权限与远端基线（空仓库合法）---
const me = await api('GET', '/user')
const repo = await api('GET', '/repos/' + OWNER + '/' + REPO)
if (!repo.permissions?.push) throw new Error('token has no push permission')
let remoteRef = null
try {
  remoteRef = await api('GET', `/git/ref/heads/${BRANCH}`)
} catch (error) {
  // 空仓库返回 409 "Git Repository is empty."，分支不存在才是 404；两种都按首次推送处理。
  if (!/-> (404|409)/.test(error.message)) throw error
}
// GitHub 的 Git Data API 在**完全没有提交**的仓库上直接 409（连 POST /git/trees 都不给建）。
// 所以先用 Contents API 造一个种子提交，让 Git Data API 可用；重放时根提交仍然没有 parent，
// 最后 force 把分支移到重放出来的 tip 上，种子提交变成游离对象 —— 分支历史里只有本地提交。
let seeded = false
if (remoteRef === null && !process.env.GH_BASE_SHA) {
  await api('PUT', `/repos/${OWNER}/${REPO}/contents/.github-bootstrap.md`, {
    message: 'chore: bootstrap repository so the Git Data API accepts objects',
    content: Buffer.from('Seeded to unblock the Git Data API; the branch is moved over this commit.\n').toString('base64'),
  })
  seeded = true
}
let baseSha = process.env.GH_BASE_SHA ?? remoteRef?.object.sha
let baseCommit = baseSha ? await api('GET', `/git/commits/${baseSha}`) : null
console.log(baseSha
  ? `pushing to ${OWNER}/${REPO}#${BRANCH} from ${baseSha.slice(0, 7)} as ${me.login}`
  : `replaying from the root commit onto ${OWNER}/${REPO}#${BRANCH} as ${me.login}${seeded ? ' (seeded via Contents API)' : ''}`)

// --- 1) 要重放的提交（旧→新）---
// Git Data API 造出来的 commit sha 和本地 sha **不同**（tree/parent 相同但签名对象不同），
// 所以远端 head 不能直接当 `git rev-list` 的基线。用 .git/dsh-github-push-map 记住
// 「本地 sha → 远端 sha」，下次据此算增量；没有映射（首次推送、或映射丢失）就从头重放。
const mapFile = `${gitText(['rev-parse', '--git-dir']).trim()}/dsh-github-push-map`
const pushMap = new Map(
  (existsSync(mapFile) ? readFileSync(mapFile, 'utf8') : '')
    .split('\n').filter(Boolean)
    .map(line => { const [local, remote] = line.split('\t'); return [remote, local] }),
)
let baseLocal = baseSha ? pushMap.get(baseSha) : undefined
if (baseSha && !baseLocal) {
  console.log(`remote head ${baseSha.slice(0, 7)} has no local mapping; replaying from the root commit`)
  baseSha = null
  baseCommit = null
  seeded = remoteRef !== null
}
const range = baseSha ? `${baseLocal}..HEAD` : 'HEAD'
const shas = gitText(['rev-list', '--reverse', range]).trim().split(/\s+/).filter(Boolean)
// --- 2) 逐个提交：blob → tree → commit ---
let baseTree = baseCommit?.tree.sha
let parent = baseSha ?? null
const map = new Map()
if (shas.length === 0) console.log('nothing to push (remote is already at or ahead of HEAD)')
for (const sha of shas) {
  const meta = gitText(['show', '-s', '--format=%an%x00%ae%x00%at%x00%cn%x00%ce%x00%ct%x00%B', sha])
  const [an, ae, at, cn, ce, ct, ...rest] = meta.split('\x00')
  const message = rest.join('\x00').replace(/\n+$/, '')
  // `--root` 是必需的：根提交没有 parent，不带它 `diff-tree` 一行都不输出，
  // 于是 tree 的 entries 为空、POST /git/trees 报 422 "Invalid tree info"。
  const raw = gitText(['diff-tree', '-r', '--root', '--no-renames', '--no-commit-id', '--raw', sha])
    .trim().split('\n').filter(Boolean)
  const entries = []
  for (const line of raw) {
    const m = line.match(/^:(\d{6}) (\d{6}) ([0-9a-f]{40}) ([0-9a-f]{40}) ([A-Z])\t(.+)$/)
    if (!m) throw new Error('unparsed diff-tree line: ' + line)
    const [, srcMode, , , newSha, status, p] = m
    if (status === 'D' || /^0+$/.test(newSha)) {
      // 删除条目要带**旧 mode**：GitHub 文档的删除写法是 sha:null 配文件原有 mode；
      // 删除行的新 mode 是 000000，不在合法 mode 集里，会被 trees 端点 422 拒掉。
      entries.push({ path: p, mode: srcMode, type: 'blob', sha: null })
    } else {
      const blob = await api('POST', '/git/blobs', {
        content: git(['show', `${sha}:${p}`]).toString('base64'),
        encoding: 'base64',
      })
      entries.push({ path: p, mode: newMode, type: 'blob', sha: blob.sha })
    }
  }
  const tree = await api('POST', '/git/trees', {
    ...(baseTree === undefined ? {} : { base_tree: baseTree }),
    tree: entries,
  })
  const commit = await api('POST', '/git/commits', {
    message, tree: tree.sha, parents: parent === null ? [] : [parent],
    author: { name: an, email: ae, date: new Date(Number(at) * 1000).toISOString() },
    committer: { name: cn, email: ce, date: new Date(Number(ct) * 1000).toISOString() },
  })
  map.set(sha, commit.sha)
  console.log(`  ${sha.slice(0, 7)} -> ${commit.sha.slice(0, 7)}  ${message.split('\n')[0].slice(0, 72)}`)
  baseTree = tree.sha
  parent = commit.sha
}

// --- 2.5) 移动分支【之前】先验证 tree ---
// 重放出的 tip 已经是远端对象；tree 与本地 HEAD 不一致就直接失败——此时分支 ref
// 还没动，远端保持原状。（先移 ref 再验证的旧顺序会在失配时把远端分支留在坏
// commit 上，还顺手把它写进 push map。）
const localTree = gitText(['rev-parse', 'HEAD^{tree}']).trim()
const remoteHead = await api('GET', `/git/commits/${parent}`)
if (remoteHead.tree.sha !== localTree) throw new Error(`tree mismatch: ${remoteHead.tree.sha} != ${localTree}`)
console.log('tree verified:', localTree)

// --- 3) 移动分支 ---
// 首次推送（或远端基线不是本地对象）时根提交没有 parent，只能 force 到重放出来的 tip：
// 种子提交因此变成游离对象，分支历史里只有本地提交。常规增量推送仍然 force:false，
// 远端被别人推进时会失败而不是覆盖。
if (baseSha === null) {
  try {
    await api('PATCH', `/git/refs/heads/${BRANCH}`, { sha: parent, force: true })
  } catch (error) {
    if (!/-> 404/.test(error.message)) throw error
    await api('POST', '/git/refs', { ref: `refs/heads/${BRANCH}`, sha: parent })
  }
} else {
  await api('PATCH', `/git/refs/heads/${BRANCH}`, { sha: parent, force: false })
}
console.log('branch updated:', parent)
const previous = existsSync(mapFile) ? readFileSync(mapFile, 'utf8').split('\n').filter(Boolean) : []
const fresh = [...map].map(([local, remote]) => `${local}\t${remote}`)
const kept = previous.filter(line => !map.has(line.split('\t')[0]))
writeFileSync(mapFile, [...kept, ...fresh].slice(-100).join('\n') + '\n')
console.log(`push map saved: 本次 ${map.size} 个提交，文件里共 ${Math.min(kept.length + fresh.length, 100)} 条（下次按它算增量）`)

// --- 4) 可选：annotated tag + release + 资产（重复运行时是「重新发版」而非报错）---
if (TAG) {
  const tagLocal = gitText(['rev-parse', `${TAG}^{}`]).trim()
  // tag 必须落在**它自己的 commit** 上：map 只装本次重放，旧 tag 的映射在刚写好的
  // map 文件里（kept+fresh）。查不到就失败——`?? parent` 的旧回退会把上一轮推过
  // 的 tag 静默移到本次 tip（HEAD），release 资产与 commit 错位；100 条窗口把旧
  // 映射驱逐后更是必然踩中。宁可停机重放，不可错发版。
  const persisted = new Map(
    readFileSync(mapFile, 'utf8').split('\n').filter(Boolean)
      .map(line => { const [local, remote] = line.split('\t'); return [local, remote] }),
  )
  const tagCommit = persisted.get(tagLocal)
  if (tagCommit === undefined) throw new Error(`tag ${TAG} 指向 ${tagLocal}，不在 push map（可能已被 100 条窗口驱逐）；拒绝把 tag 移到 HEAD`)
  const tagObj = await api('POST', '/git/tags', {
    tag: TAG, message: RELEASE_NAME, object: tagCommit, type: 'commit',
    tagger: { name: me.login, email: `${me.login}@users.noreply.github.com`, date: new Date().toISOString() },
  })
  try {
    await api('POST', '/git/refs', { ref: `refs/tags/${TAG}`, sha: tagObj.sha })
  } catch (error) {
    // 标签已存在（重跑/改内容重发）：把标签移到新的 tag 对象上。
    if (!/-> 422/.test(error.message)) throw error
    await api('PATCH', `/git/refs/tags/${TAG}`, { sha: tagObj.sha, force: true })
    console.log('tag moved:', TAG, '->', tagCommit)
  }
  console.log('tag points at:', tagCommit)
  if (RELEASE_BODY) {
    let release
    try {
      release = await api('GET', `/releases/tags/${TAG}`)
    } catch (error) {
      if (!/-> 404/.test(error.message)) throw error
    }
    if (release === undefined) {
      release = await api('POST', '/releases', {
        tag_name: TAG, name: RELEASE_NAME, body: RELEASE_BODY, draft: false, prerelease: false,
      })
      console.log('release created:', release.html_url)
    } else {
      release = await api('PATCH', `/releases/${release.id}`, {
        tag_name: TAG, name: RELEASE_NAME, body: RELEASE_BODY,
      })
      console.log('release updated:', release.html_url)
      for (const asset of release.assets ?? []) {
        await api('DELETE', `/releases/assets/${asset.id}`)
        console.log('  old asset removed:', asset.name)
      }
    }
    if (ASSET) {
      const bytes = readFileSync(ASSET)
      const up = await fetch(`https://uploads.github.com/repos/${OWNER}/${REPO}/releases/${release.id}/assets?name=${encodeURIComponent(ASSET_NAME)}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'user-agent': 'push-github-api', 'content-type': 'application/gzip' },
        body: bytes,
      })
      const json = await up.json().catch(() => ({}))
      if (up.status >= 300) throw new Error(`asset upload -> ${up.status}: ${JSON.stringify(json).slice(0, 300)}`)
      console.log(`asset: ${json.name} (${json.size} bytes) ${json.browser_download_url}`)
    }
  }
}
