# GitHub 推送链路（api.github.com Git Data API）

> 适用：本机 **无法直连 `github.com:443`**（`git push` 报 `Failed to connect` / `Recv failure: Connection was reset`），
> 但 **`api.github.com` 可达**，且本机已存 GitHub 凭据（Windows Credential Manager / `git credential`）。
> 本文把「本地提交 → GitHub」的完整链路整理成可复用流程，供其他会话/项目直接套用。

## 1. 先判断走哪条路

| 现象 | 可用链路 |
| --- | --- |
| `git push` 正常 | 普通 `git push`（首选） |
| `git push` 超时，但 `ssh -T -p 443 git@ssh.github.com` 返回 `Hi <user>!` | SSH over 443：`git remote set-url origin ssh://git@ssh.github.com:443/<owner>/<repo>.git` |
| `github.com:443` 不通，`api.github.com` 通 | **本文的 Git Data API 链路** |
| 全部不通 | 只能等网络/代理；不要盲目重试 |

快速判断：

```powershell
git ls-remote --heads origin          # 失败 = github.com 的 git 通道不通
curl -sS -o NUL -w "%{http_code}" https://api.github.com/   # 200/401 = API 可达
ssh -o ConnectTimeout=8 -p 443 -T git@ssh.github.com        # Hi ... = SSH 可用
```

## 2. 原理

`git push` 走的是 `github.com/<owner>/<repo>.git/info/refs`（smart HTTP），被阻断时无法推送。
GitHub REST API 走 `api.github.com`，其中的 **Git Data API** 允许在服务端创建
blob → tree → commit → ref，等价于“把本地提交放上 GitHub”。

**关键差异**：API 重放会生成**新的 commit SHA**（作者/提交者/父提交都保留，但对象是新建的）。
只要最终 `tree` SHA 与本地一致，**代码内容逐字节相同**；本地与远端的历史 SHA 会分叉，
需要时在有网络的环境 `git fetch` 对齐即可。

## 3. 前置检查

```powershell
# 1) 取 token（不要打印到日志）
git credential fill
# 输入：
# protocol=https
# host=github.com
# （空行）
# 输出里的 password= 就是 token

# 2) 找 git 可执行文件的绝对路径（Windows 上 execFileSync('git') 可能启动失败）
where git
# 典型：C:\Program Files\Git\cmd\git.exe

# 3) 记录本地基线
git rev-parse HEAD
git rev-parse HEAD^{tree}
```

API 侧验证（脚本会做）：

- `GET /user` → 200，且 `x-oauth-scopes` 含 `repo`；
- `GET /repos/{owner}/{repo}` → `permissions.push === true`；
- `GET /git/ref/heads/{branch}` → 远端当前 SHA。

## 4. 推送算法（逐步）

1. `git rev-list --reverse <remoteMain>..HEAD` 得到要重放的提交（旧→新）。
2. `GET /git/commits/<remoteMain>` → `tree.sha` 作为 `baseTree`。
3. 对每个提交：
   - 元数据：`git show -s --format=%an%x00%ae%x00%at%x00%cn%x00%ce%x00%ct%x00%B <sha>`
     （作者/邮箱/时间、提交者/邮箱/时间、完整消息）
   - 变更：`git diff-tree -r --no-renames --no-commit-id --raw <sha>`
     - `A`/`M`：`git show <sha>:<path>` → base64 → `POST /git/blobs`
     - `D`：tree entry `{ path, mode, type: "blob", sha: null }`
   - `POST /git/trees`：`{ base_tree: baseTree, tree: entries }` → 新 tree SHA
   - `POST /git/commits`：`{ message, tree, parents: [prev], author, committer }` → 新 commit SHA
   - 更新 `baseTree` / `prev`
4. `PATCH /git/refs/heads/{branch}`：`{ sha: prev, force: false }`（应快进成功）。
5. 校验：`GET /git/commits/<newHead>` 的 `tree.sha` **必须等于**本地 `HEAD^{tree}`。

## 5. Tag 与 Release

```text
POST /git/tags        { tag, message, object: <commit>, type: "commit", tagger }
POST /git/refs        { ref: "refs/tags/<tag>", sha: <tag object sha> }
POST /releases        { tag_name, name, body, draft: false, prerelease: false }
```

## 6. 可直接复用的脚本

> 本节与 `scripts/push-github-api.mjs` 同步，以脚本文件为准。

现行脚本即 `scripts/push-github-api.mjs` 全文（已含 §7 列出的四处修复），在**有完整 git 历史的本地仓库根目录**运行：

```js
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
```

> Windows 提示：`GIT_BIN` 建议用 `where git` 的绝对路径（如 `C:\Program Files\Git\cmd\git.exe`）。
> Node 24 自带 `fetch`，无需安装依赖。

## 7. 坑与注意事项

- **SHA 会分叉**：API 重放生成新 commit；本地 `origin/main` 仍指向旧 SHA，且新对象不在本地库，
  `git update-ref refs/remotes/origin/main <new>` 会报 `nonexistent object`。有网络时 `git fetch` 对齐即可。
- **重命名**：用 `--no-renames` 拆成 `A`+`D`，避免解析 `R100`。
- **二进制**：`git show` 取到 Buffer，直接 base64；不要按 UTF-8 转。
- **符号链接 / 子模块**：`mode 120000` 是 symlink（内容为链接目标，按 blob 处理）；`mode 160000` 是 submodule，
  需要 `type: "commit"` 和子模块 SHA，不能当 blob。
- **大文件**：单 blob 上限 100 MB；大文件用 Git LFS 或分块，API 链路不适合。
- **并发**：先读远端 `main`，重放期间被他人推进时 `PATCH`（force:false）会失败；重新读取后重放。
- **限流**：认证 5000 次/小时；每个提交约 `变更文件数 + 2` 次调用。
- **Token 安全**：只从 `git credential fill` 读，绝不写进仓库、日志或命令行参数。
- **回退**：`PATCH /git/refs/heads/{branch}` 到旧 SHA（`force:true`），或正常 `git revert`。
- **不要**在脚本里 `console.log(token)`；错误信息里也不要拼接 token。

## 8. 验收清单

- [ ] `GET /git/ref/heads/{branch}` 的 SHA == 脚本输出的最终 commit；
- [ ] `GET /git/commits/<sha>` 的 `tree.sha` == 本地 `git rev-parse HEAD^{tree}`；
- [ ] `GET /contents/<关键文件>?ref=<sha>` 内容正确；
- [ ] `GET /git/ref/tags/<tag>` → tag object → 目标 commit；
- [ ] Release 页面可打开。

## 7. 本仓库脚本补的四处（首次推送时踩到的）

`scripts/push-github-api.mjs` 是上面那份脚本的复用版，首次推送时撞到四个问题，都已修：

| 现象 | 原因 | 处理 |
|---|---|---|
| 脚本一执行就 `GET /user -> 404` | 上游 `api()` 把**所有**路径拼在 `/repos/<owner>/<repo>` 之后，`/user` 变成仓库命名空间下的 `/user` | `/user` 与 `/repos/…` 视为绝对路径，其余（`/git/…`、`/releases`）才挂仓库命名空间 |
| 空仓库上 `POST /git/trees -> 409 Git Repository is empty.` | Git Data API 在**没有任何提交**的仓库上完全不可用 | 先用 Contents API（`PUT /contents/.github-bootstrap.md`）造一个种子提交，重放时根提交仍无 parent，最后 `PATCH …/refs/heads/<branch> {force:true}` 把分支移到重放 tip，种子提交变成游离对象 —— **分支历史里只有本地提交** |
| `POST /git/trees -> 422 Invalid tree info`（entries 为空） | 根提交没有 parent，`git diff-tree -r --raw <sha>` 一行都不输出 | 加 `--root`：根提交的全量新增才会被列出来 |
| 第二次推送把全部历史重放一遍（远端 sha 与本地不同） | Git Data API 造出的 commit 对象与本地不同 sha，远端 head 不能直接当 `git rev-list` 基线 | `.git/dsh-github-push-map` 记「本地 sha → 远端 sha」，据此算 `<localBase>..HEAD`；第二次推送只重放增量提交 |

顺带支持**同版本重发**：tag 已存在时 `PATCH …/refs/tags/<tag> {force:true}` 移动标签；
Release 已存在时 `PATCH /releases/<id>` 更新正文、先删旧资产再上传新资产
（`GH_ASSET` / `GH_ASSET_NAME`，得到 `releases/latest/download/<name>.tgz` 这种稳定安装地址）。


最后一道校验是 `tree verified`：远端 tip 的 tree sha 必须等于本地 `HEAD^{tree}`，
不等就报错退出 —— 这是「推上去的东西和本地一致」的唯一硬证据。
