# 04 · 关键类与函数参考

> 本文档按模块列出全部导出（含重要内部函数）。签名做了排版简化；行为描述以
> 源码 + 单测为准。无独立的"类"——项目全部由函数与接口构成。

## 1. src/checks.ts —— 纯函数校验层

### 1.1 `checkedCwd`

- **位置**：`src/checks.ts:18-30`
- **签名**：`checkedCwd(value: string): string`
- **职责**：只接受"当前可访问的绝对目录"作为会话工作目录。
- **行为**：
  1. `isAbsolute(value)` 不成立 → 抛 `cwd must be an absolute directory, got "<value>"`；
  2. `statSync` 失败 → 抛 `cwd is not accessible (<errno code>): <value>`；
  3. 不是目录 → 抛 `cwd is not a directory: <value>`；
  4. 通过则**原样返回**（不规范化、不解析符号链接）。
- **设计**：不猜基准目录——相对路径直接拒绝，而不是替调用方补全。
- **测试**：`tests/checks.test.ts:114-143`（相对路径 / 存在目录 / 缺失 / 非目录）。

### 1.2 `requestIdPrefix`

- **位置**：`src/checks.ts:33`
- **值**：`'agent-tools:'`
- **职责**：幂等键命名空间，避免与其他生产者（如 GUI 自己的 rpcId）撞键。

### 1.3 `promptRequestId`

- **位置**：`src/checks.ts:48-63`
- **签名**：`promptRequestId(value: string | undefined, callId: string | undefined): string`
- **职责**：为一次注入确定幂等键。三种来源：
  | 输入 | 结果 |
  |---|---|
  | 省略 + 有 `callId` | `agent-tools:<callId>`（每个模型 tool call 一个键，重派发去重） |
  | 省略 + 无 `callId` | `agent-tools:<randomUUID()>`（兜底唯一） |
  | 显式给值 | 合法 token（`/^[\w-]{4,150}$/`）→ 加前缀；已带前缀且整体合法（`agent-tools:` + 4–150 个 `\w-`）→ **原样返回**（即"把上次返回的 requestId 原封不动传回来"） |
- **抛错**：非法 token（含空格、过短、前缀后过短）。
- **测试**：`tests/checks.test.ts:66-88`。

### 1.4 重试账本：`lookupRetry` / `rememberRetry` / `RetryRecord`

- **位置**：`src/checks.ts:66-123`
- **常量**：`retryWindowMs = 60_000`、`retryLedgerLimit = 256`
- **`RetryRecord<T>`**：`{ message: string; receipt: T; at: number }`
- **`lookupRetry(ledger, key, message, now)`**：先按龄清理过期条目，再查键：
  - 未命中/过期 → undefined（调用方继续正常流程）；
  - 命中但文本不同 → 抛 `requestId "…" was already used for different text within 60s`（一个键绝不许覆盖两条不同文本）；
  - 命中且文本相同 → 返回记录（调用方直接复用回执，不调宿主）。
- **`rememberRetry(ledger, key, record)`**：写入后按插入序裁剪到上限（`Map` 保持
  插入序，最旧的先删）。
- **为什么存在**：宿主去重只覆盖 inbox + 已落盘历史，"消息离开 inbox 但尚未落盘"
  的窗口内同键重试会插两条；本账本把该窗口堵住（详见
  [02 整体架构 §6](02-architecture.md)）。
- **测试**：`tests/checks.test.ts:37-64`。

### 1.5 `ownerWorkspace`

- **位置**：`src/checks.ts:131-137`
- **签名**：`ownerWorkspace<T extends { id: string; sessionIds: readonly string[] }>(workspaces: readonly T[], sessionId: string | undefined): T | undefined`
- **职责**：按 Workspace 的**有序会话账号**（`sessionIds`）反查某会话所属 Workspace；
  无 sessionId 或无归属 → undefined（对应"当前会话不在任何 Workspace，交给宿主
  默认 cwd"的分支）。
- **测试**：`tests/checks.test.ts:8-25`。

### 1.6 `hasText`

- **位置**：`src/checks.ts:144-146`
- **职责**：`value.trim().length > 0`。空与纯空白都判 false，`session_inject`
  在调用宿主前先拒。

### 1.7 `describeFailure` / `codeOf`

- **位置**：`src/checks.ts:154-165`
- **`codeOf(error)`**：宽容读取 `error.code`（仅当为非空 string 时返回），非对象/
  无 code 一律 undefined。
- **`describeFailure(tool, error)`**：产出 `"<tool>: <message>( (<code>))?"` 形式的
  Error。非 Error 值（如字符串）经 `String(error)` 归一。宿主 `RemoteError` 的
  code（`session/not-found`、`agent-preset/not-found`…）因此保留在模型可见的
  错误文本里。
- **测试**：`tests/checks.test.ts:102-112`。

### 1.8 模型目录四件套

- **`SelectionChoice`**（`src/checks.ts:172-176`）：`{ provider, model, reasoningEffort? }`
  ——`session_create` 交给宿主 `selectModel` 的最终选择。
- **`entryOf` / `effortList`**（`:179-186`，内部）：`catalog.groups` 按 provider id
  定位 group、按 model id 定位条目及其 `reasoning.efforts`。
- **`providerOfModel(model, catalog)`**（`:198-207`）：
  - 目录里恰好一个 provider 提供该 model id → 返回它；
  - 零个 → 抛 `model "…" is not listed in the Host model catalog`，若目录记录了
    加载失败的 provider（`catalog.failures`）则一并列出（帮助区分"没这模型"与
    "provider 掉线"）；
  - 多个 → 抛 `model "…" is offered by several providers (a, b); pass provider to pick one`
    ——**绝不猜路由**。
- **`checkedEffort(effort, provider, model, catalog)`**（`:220-227`）：可见目录
  列出了 efforts 且不含该值 → 抛错并列出可选项；目录看不到该路由（加载失败、
  未知 provider）→ **透传**，交给宿主 `selectModel` 裁决。显式 effort 校验失败
  发生在 create 之前，不残留会话。
- **`carriedEffort(effort, provider, model, catalog)`**（`:241-254`）：继承场景——
  同路由总是接受；异路由在新模型的可见 efforts 不含该值时**降级**为新模型的
  `reasoning.defaultEffort`（调用方要的是"同思考强度"，不是在新模型上验证失败）；
  目录看不到则原样透传。
- **测试**：`tests/checks.test.ts:145-213`（唯一/歧义/未列出、可见提供/不提供/
  无清单透传、继承保留/降级/无清单）。

## 2. src/session-tools.ts —— 会话工具

### 2.1 `currentSelection`

- **位置**：`src/session-tools.ts:47-63`
- **签名**：`currentSelection(exec: { readonly agent?: unknown }): SelectionChoice | undefined`
- **职责**：从 live Agent 运行时面读当前会话的模型选择。类型契约只宽泛声明
  `agent`，这里用结构性类型断言访问 `agent.model.current()`，整体 try/catch：
  读不到 / 抛错 / 返回 undefined 一律视为"无模型可抄"，走部署默认，不报错。
- **语义细节**：适配器只是**默认化**的 effort 不会被钉进 `current()` 的状态，
  照抄它等于"同思考强度"而非把一次默认值固化成显式选择（模块注释 `:38-46`）。

### 2.2 `lookupCatalog`

- **位置**：`src/session-tools.ts:70-76`
- **职责**：`modelCatalog()` 失败 → undefined。**目录故障不阻断不需要它的选择**：
  整体继承（不换模型、不查 effort）全程可以不碰目录。

### 2.3 `resolveSelection`（`session_create` 的核心解析）

- **位置**：`src/session-tools.ts:91-146`
- **签名**：`resolveSelection(ctx, args: { model?, provider?, reasoningEffort? }, exec): Promise<SelectionChoice | undefined>`
- **决策表**（undefined 返回 = 新会话走部署默认）：

  | 调用方给了 | 当前会话有选择 | 目录可用 | 结果 |
  |---|---|---|---|
  | 什么都不给 | 是 | 不需要 | 原样返回 current（宿主校验副本） |
  | 什么都不给 | 否 | 不需要 | undefined（部署默认） |
  | 只给 effort | 否 | — | **抛错**：effort 无模型可施加 |
  | 只给 effort | 是 | 是 | `{current.provider, current.model, checkedEffort(...)}` |
  | 只给 effort | 是 | 否 | effort 透传（宿主裁决） |
  | 给 model（无 provider）| 同 id 已在当前路由 | 不需要 | provider 沿用 current.provider |
  | 给 model（无 provider）| 其他/无 current | 是 | `providerOfModel` 反查 |
  | 给 model（无 provider）| 其他/无 current | 否 | **抛错**：目录不可用，要求显式 provider |
  | 给 model + effort | — | 是 | `checkedEffort`（不提供即抛） |
  | 给 model + effort | — | 否 | 透传 |
  | 给 model，继承 effort | 有继承值 | 是 | `carriedEffort`（可降级 defaultEffort） |
  | 给 model，继承 effort | 有继承值 | 否 | 原样携带 |
  | 只给 provider | — | — | **抛错**：provider 必须与 model 同用 |

  另：三个参数任何纯空白取值在入口即抛（`:96-104`）。
- **设计**：全部解析发生在 `create` **之前**，可命名错误不残留会话；只有宿主
  自己的可用性校验可能发生在创建之后。

### 2.4 `resolveProvider`

- **位置**：`src/session-tools.ts:149-155`
- **职责**：目录不可用时**显式报错**（`the Host model catalog is unavailable … pass provider explicitly`），
  而不是静默猜路由；可用时转 `providerOfModel`。

### 2.5 `joinTarget`

- **位置**：`src/session-tools.ts:174-183`
- **签名**：`joinTarget(ctx, args: { cwd?, workspaceId? }, exec): Promise<Workspace | undefined>`
- **三级解析**（与 README「工具语义」的落点规则一致）：

  | 输入 | 行为 |
  |---|---|
  | 显式 `workspaceId` | `registry.get(id)` 透传；未知 id 由宿主报 `workspace/not-found` |
  | 显式 `cwd` | `registry.resolveByPath(checkedCwd(cwd))`：命中 → 用该 Workspace 的 id（自动归组）；未命中 → undefined（纯 cwd 创建，**不替调用方新建 Workspace**） |
  | 两者皆无 | `ownerWorkspace(registry.list(), exec.agent?.id)`：沿用当前会话所属 Workspace；当前会话不在任何 Workspace → undefined |
- **为什么存在**：宿主 `create` 只有 `workspaceId` 会把会话挂上 Workspace；只给
  `cwd` 的会话是"未分类"，UI 把它排在所有分组之外。

### 2.6 `createSessionTool` → 工具 `session_create`

- **位置**：`src/session-tools.ts:185-300`
- **execute 主流程**（`:242-298`，时序见 [02 §5](02-architecture.md)）：
  1. 入口取消检查（`:243`）；
  2. `cwd` × `workspaceId` 互斥（`:244-246`）；
  3. `await resolveSelection(...)`（`:247`）；
  4. **解析后取消复查**（`:251`，注释：解析新增了 await 点，取消可能落在原入口
     检查之后；创建无法中途取消，这是最后一个免费取消点）；
  5. `await joinTarget(...)`（`:252`）；
  6. 组装 `SessionCreateRequest`（`:253-256`）：joined → `{workspaceId: joined.id}`；
     未 joined 但给了 cwd → `{cwd: checkedCwd(args.cwd)}`（再校验一次是幂等的，
     且保证**省略时不塞空字段**——测试 `session-tools.test.ts:128-134` 断言请求体
     是 `{}`）；`agentPreset` 有则透传；
  7. `sessionController.create(request)`，失败走 `describeFailure`（`:258-262`）；
  8. 位置投影（`:265-267`）：joined 时回显 Workspace 的 `path`（那正是宿主用的
     cwd）与 `workspaceId/workspaceTitle`；未 joined 给了 cwd 回显调用值；
  9. 有选择则 `selectModel(...)`（`:275-289`），回执里的 `selected` 投影进输出；
     失败则抛**点名已创建会话**的错误（`:290-297`）。
- **输出 schema**（`:216-229`）：`sessionId`（必填）+ `cwd` / `workspaceId` /
  `workspaceTitle` / `agentPreset` / `provider` / `model` / `reasoningEffort`（可选），
  `additionalProperties: false`。
- **render**（`:230-240`）：单行文本，形如
  `session created: <id> (workspace: DSH, cwd: …) (preset: standard) (model: prov-a/m1, effort: high)`；
  未归组时显式渲染 `(cwd: …|default, ungrouped)`——如实告知"这个会话不在任何分组"。

### 2.7 `injectSessionTool` → 工具 `session_inject`

- **位置**：`src/session-tools.ts:307-406`
- **闭包状态**（随注册实例生灭，`:316-324`）：
  - `inFlight: Map<key, { message, result: Promise<InjectReceipt> }>` —— 进行中的
    prompt；同键并发合并，同键异文拒绝；
  - `settled: Map<key, RetryRecord<InjectReceipt>>` —— 完成回执，60 秒窗口、256 上限。
- **execute 主流程**（`:366-404`，时序见 [02 §6](02-architecture.md)）：
  取消检查 → `hasText` → `promptRequestId` → `lookupRetry`（命中直接返回回执）→
  `inFlight`（异文抛 / 同文 `await started.result`）→ 构造
  `SessionPromptRequest`（`content: [{ type: 'text', text: message }]`——宿主的
  content 是**部件数组**不是字符串）→ `prompt(request, exec.signal)` →
  `rememberRetry` → 返回 receipt；`finally` 中从 `inFlight` 移除。
- **输出 schema**（`:350-360`）：`accepted` / `sessionId` / `mode` / `requestId`
  全必填。render 单行：`message accepted: session <id> (mode: queue, request: <key>)`。

## 3. src/error-audit.ts —— 错误审计

### 3.1 `parseAuditArgs`

- **位置**：`src/error-audit.ts:43-49`
- **职责**：`since` 必须能 `Date.parse`（否则抛 ISO 错误）；`top` 取整后钳制
  1–5，缺省 3；`cwd_contains` 透传。
- **测试**：`tests/error-audit.test.ts:38-47`。

### 3.2 `classifyErrorText`

- **位置**：`src/error-audit.ts:57-68`
- **职责**：**顺序敏感**的错误分类词表，先具体后通用：

  | 顺序 | 判定（substring/regex） | 类别 |
  |---|---|---|
  | 1 | `old_string was not found` | `edit-mismatch` |
  | 2 | `file changed since it was read` | `edit-stale` |
  | 3 | `has not been read` | `edit-not-read` |
  | 4 | `execution deadline` | `timeout` |
  | 5 | `IO error for operation` | `search-bad-path` |
  | 6 | `/Expected\|Unexpected token\|Expression expected\|ReferenceError\|invalid syntax\|SyntaxError/u` | `syntax` |
  | 7 | `fetch failed` \| `tool call timed out` | `network` |
  | 8 | `missing required property` \| `invalid arguments` | `bad-args` |
  | 9 | `ENOENT` | `enoent` |
  | 10 | 兜底 | `other` |
- **测试**：`tests/error-audit.test.ts:9-28`（含"具体优先于通用"的顺序断言）。

### 3.3 `offenderOf`

- **位置**：`src/error-audit.ts:71-77`
- **职责**：从错误文本提取归因：优先 `in "…"` 与 `(modify|write|edit|read) "…"`
  的引号内容；其次 `command:"…"` 的命令头（10–80 字符）；否则空串。
  汇总时与工具名拼成 `<tool> → <file/command>`（截断 80 字符）。

### 3.4 `defaultSessionsRoot` / `decodeSessionLines`

- **位置**：`src/error-audit.ts:80-99`
- `defaultSessionsRoot()`：`join(homedir(), '.dsh', 'sessions')` —— 会话存储根。
- `decodeSessionLines(bytes)`：`zstdDecompressSync` 一次解码**拼接帧**（文件含
  独立头帧 + 数据帧）；空输入或损坏 → `[]`（跳过该文件，审计不因坏文件失败）。
  `.jsonl` 直读按 `\n` 切分。

### 3.5 `auditSessions`

- **位置**：`src/error-audit.ts:109-145`
- **职责**：三层 `readdirSync(withFileTypes)` 遍历（工作区目录 → 会话目录 →
  `.jsonl[.zstd]` 文件）；对每个文件 `scanLines` 得到 `{cwd, errors, offenders}`；
  聚合 `categories`（类别计数）、`perSession`（按 cwd 或会话目录名计数）、
  `offenders`；最后 `renderSummary`。
- **过滤**：`since` 下界在 `scanLines` 内按事件 `time` 判；`cwd_contains` 在文件
  级结果上判。
- **有界性**：内存平坦（错误文本抽取即截断），只返回 summary。

### 3.6 `scanLines`（内部）

- **位置**：`src/error-audit.ts:148-186`
- **事件处理**：
  | 事件 | 字段 | 动作 |
  |---|---|---|
  | `session` | `event.cwd` | 记录会话工作目录（缺省 `'?'`） |
  | `tool/call` | `data.callId` → `data.name` | 建立 callId→工具名映射 |
  | `tool/result` | `data.message.{isError, content, toolCallId}`、`event.time` | `isError === true` 且 `time ≥ since`：`plainText(content)` 截 200 字符 → `classifyErrorText` 入列；offender 入列 `<工具名> → <归因>` |
- 无错误的会话返回 undefined（不计入 `scanned`）。

### 3.7 `renderSummary`（内部）

- **位置**：`src/error-audit.ts:208-227`
- **输出形状**（有界 ~40 行）：
  ```
  session_error_audit: <total> tool errors across <scanned> sessions with errors
  — categories —
  <计数右对齐>  <类别>            （≤10 行）
  — worst sessions —
  <计数>  <cwd>                  （top 行，默认 3）
  — top offenders (tool → file/command) —
  <计数>  <tool → file>          （top 行）
  ```
- `topEntries`（`:200-202`）：计数降序、键 `localeCompare` 升序——**确定性输出**。

### 3.8 `auditSessionTool`

- **位置**：`src/error-audit.ts:237-263`
- 参数：`since`（可选 ISO 8601）、`cwd_contains`（可选子串）、`top`（默认 3，钳 1–5）。
- 输出：`{ summary: string }`（必填），render 原样输出 summary 文本。
- `ctx` 未使用（`void ctx`），保留参数以与兄弟工具签名对齐。

## 4. src/index.ts

| 导出 | 说明 |
|---|---|
| `name = 'agent-session-tools'` | cordis 插件名 |
| `inject = ['tools', 'sessionController', 'workspaceRegistry']` | 服务依赖，缺一则不激活 |
| `apply(ctx)` | 注册三个工具；`ctx.effect` 持有各 `register` 返回的反注册闭包 |

## 5. 导出面（package.json `exports`）

| 子路径 | 对应 dist |
|---|---|
| `.` | `dist/index.js`（+ `.d.ts`）—— 插件本体 |
| `./session-tools` | `dist/session-tools.js` —— 工具定义（供宿主/测试引用） |
| `./checks` | `dist/checks.js` —— 纯函数层 |
| `./locale/*.json` / `./icon` / `./package.json` | 本地化与元数据 |
