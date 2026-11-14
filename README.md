# dsh-agent-session-tools

Host-only DSH 工具插件，向 Agent 暴露三个工具：

- `session_create`：新建会话，可指定绝对路径 `cwd` 或 `workspaceId`；不带位置参数时**沿用当前会话所属的
  Workspace**（v1.3.0 起，所以新会话会出现在同一个分组里，而不是掉进“未分类”）。默认沿用当前会话的模型
  与思考强度（`model` / `provider` / `reasoningEffort` 可覆盖，v1.2.0 起）。
- `session_inject`：向指定会话投递一条真实用户消息，支持 `queue` / `steer`。
- `session_error_audit`（v1.4.0 起，只读）：扫描本地会话日志（`~/.dsh/sessions`）里的工具调用错误，
  返回**有界**摘要（类别计数、错误最多的会话、最常被点名的文件/命令，约 40 行）；细节留在磁盘上，
  要看具体会话用 `read` 分页。

不注册 `session_list`、`session_cancel` 之类的其他会话操作。插件本身不实现会话逻辑，只调用宿主
`ctx.sessionController`（`@deepseek-ai/dsh-api-session-controller`）；审计工具只读文件，不碰宿主状态。

## 目录结构

与同工作区的 `adaptive-effort-scheduler` 对齐：TypeScript 源码 + `tsc` 构建到 `dist/`，
打包脚本借用宿主 checkout 的 `typescript` / `@deepseek-ai` 类型，本地不装依赖。

```
dsh-agent-session-tools/
  .gitignore               node_modules/ dist/ *.tgz SHA256SUMS.txt
  LICENSE                  MIT
  README.md
  package.json             入口 dist/index.js；dsh.bundle.patch；files 只含运行文件
  cordis.patch.yml         安装期 patch（insert 一行插件条目）
  cordis.yml               开发期 composition：name: ./dist/index.js，免打包直接挂
  icon.svg
  locale/en.json, zh.json  Plugin Manager 标题/描述
  src/index.ts             插件入口：name / inject / apply
  src/session-tools.ts     两个会话工具的 defineTool 定义与 execute（含模型选择解析）
  src/error-audit.ts       session_error_audit：日志扫描、错误分类、有界摘要
  src/checks.ts            纯函数：cwd 校验、空文本判定、失败包装、模型/思考强度解析、
                           重试账本（lookupRetry / rememberRetry）、Workspace 归属查找
  tests/checks.test.ts
  tests/session-tools.test.ts
  tests/error-audit.test.ts
  docs/wiki/               Code Wiki：概览 / 架构（mermaid）/ 模块 / 关键函数 /
                           工具契约 / 依赖 / 构建运行，共 8 页
  docs/GITHUB-PUSH-PIPELINE.md  本仓库沿用的 GitHub 推送链路（含 api.github.com 回退路径）
  scripts/build.mjs        tsc 运行器 + node_modules 垫片（借用宿主类型）
  tsconfig.json            → extends tsconfig.typecheck.json
  tsconfig.typecheck.json  严格类型检查（noEmit）
  tsconfig.build.json      产出 dist/ + .d.ts
  vitest.config.ts
  pack.ps1 / pack.cmd / pack.sh  一键：build → test → npm pack → 校验 tarball → SHA256
  dist/                    构建产物（gitignore）
  release/                 tarball + SHA256SUMS.txt（gitignore）
```

## 构建与打包

```sh
npm run typecheck          # tsc -p tsconfig.typecheck.json
npm run build              # tsc -p tsconfig.build.json → dist/
npm test                   # vitest run（垫片里会生成可用的 .bin/vitest.cmd）
pack.cmd                   # Windows 入口；等价于 .\pack.ps1 / ./pack.sh
.\pack.ps1 [-SkipTests] [-OutDir release] [-KeepOutDir]
```

`scripts/build.mjs` 把 `typescript`、`@types`、`@deepseek-ai/*` 链接进本目录
`node_modules` 垫片（gitignore）。来源查找顺序：`$DSH_NODE_MODULES` →
`$DSH_HOME/node_modules` → `.dsh-buildrc.json`（gitignore，`{"checkout": "<DSH 源码 checkout>"}`
或 `{"nodeModules": "<node_modules 目录>"}`）→ `./node_modules` → 该 checkout 的 `/media` 挂载
→ 兄弟项目。仓库里不含任何机器路径。相比 `adaptive-effort-scheduler` 的同名脚本改了四处，
都是为了在本机（Windows + 源码 checkout 布局）真的能构建：

1. checkout 候选除 `/media` 挂载翻译外也按字面路径试一次——Windows 上没有 `/media`，
   原来那一行永远落空，直接报 “No node_modules with typescript …”。
2. `@types` / `@deepseek-ai` 逐条目链接，不整目录链接：pnpm 的条目本身是相对符号链接，
   整目录 junction 会让它们指向错误位置（表现为 `Cannot find type definition file for 'node'`）。
3. checkout 布局下按 manifest `name` 扫描 `packages/<group>/<name>` 与 `vendor/<name>` 建链接：
   checkout 根的 `node_modules/@deepseek-ai` 只包含根包依赖的几个，插件用到的
   `dsh-tools` / `dsh-api-session-controller` / `dsh-session` 不在里面。
4. Windows 上 `.bin` 不整目录链接，改为写一个 `vitest.cmd` 指向借用的 `vitest/vitest.mjs`，
   这样 `npm test` 直接可用（原来只 `mkdir` 出一个空 `.bin`）。

`pack.*` 校验 tarball 必须含 `package.json`、`cordis.patch.yml`、`cordis.yml`、
`dist/index.js`、`dist/session-tools.js`、`dist/checks.js`，且不得含
`src/`、`tests/`、`scripts/`、`node_modules/`、`release/`，随后写
`release/SHA256SUMS.txt` 并打印安装命令。

## 兼容基线（本地取证，2026-11-06）

取证对象是**当前安装**的那一版 DSH（`@deepseek-ai/dsh 0.2.2-alpha.2`）。所有结论以安装内的
`packages/**/lib/**/*.d.ts`（插件编译时真正看到的声明）为准，`src/` 行号一并给出。
换版本时这些签名要重新核对 —— DSH 处于 developer preview，接口会漂。

### `ctx.sessionController` 服务

- 声明位置：`packages/api/session-controller/lib/types/index.d.ts:13-18`
  ```ts
  declare module '@deepseek-ai/cordis' {
      interface Context {
          /** Host Session business API and Remote namespace owner. */
          sessionController: SessionController;
      }
  }
  ```
  插件因此用 `inject = ['tools', 'sessionController']` 取用；服务键为 `sessionController`
  （由 `cordis_inspect_query` 的 Host `Service.listService` 目录确认，见该目录第 1440 行 `"key": "sessionController"`）。

### `create` 的实际签名

- 方法：`packages/api/session-controller/lib/types/index.d.ts:100`
  ```ts
  create(request: SessionCreateRequest): Promise<SessionCreateValue>;
  ```
  源码实现：`src/index.ts:303-306`（`@Remote('create')`），转发到
  `src/commands.ts:103-142`。
- 请求体：`lib/types/types.d.ts:263-272`（`src/types.ts:264-274`）
  ```ts
  export interface SessionCreateRequest {
      readonly workspaceId?: WorkspaceId;   // 与 cwd 互斥
      readonly cwd?: string;                // 独立字段，不是嵌套对象
      readonly sessionId?: SessionId;
      readonly agentPreset?: string;
  }
  ```
  ⇒ `cwd` 是对象里的独立字段，`create` 接受绝对路径 `cwd`。
  `commands.ts:104-106` 明确拒绝 `workspaceId` 与 `cwd` 同时给出；
  `commands.ts:116` 在两者都缺省时回落到宿主默认 `defaultCwd`。
- 返回值：`lib/types/types.d.ts:274-279`（`src/types.ts:276-282`）
  ```ts
  export interface SessionCreateValue {
      readonly sessionId: SessionId;
      readonly agentPreset?: string;
  }
  ```
  ⇒ 可投影字段只有 `sessionId` 与可选 `agentPreset`；没有 `title`，
  所以本插件不暴露 `title`（改名是另一个方法 `rename`）。

### `prompt` 的实际签名

- 方法：`lib/types/index.d.ts:170`
  ```ts
  prompt(request: SessionPromptRequest, signal: AbortSignal): Promise<SessionPromptValue>;
  ```
  源码：`src/index.ts:464-489`（`@Remote('prompt')`），业务在 `src/commands.ts:304-351`。
  ⇒ **`prompt` 有第二个必填 `signal` 参数**；本插件传入工具的 `exec.signal`。
- 请求体：`lib/types/types.d.ts:311-319`（`src/types.ts:320-329`）
  ```ts
  export interface SessionPromptRequest {
      readonly requestId: SessionRequestId;      // 必填，幂等键
      readonly sessionId: SessionId;
      readonly mode: 'queue' | 'steer';          // 必填
      readonly content: readonly PromptContentPart[];
      readonly clientTimeZone?: string;
  }
  ```
- 文本字段实名：**`content`**，但类型是**部件数组**而不是字符串
  （`lib/types/types.d.ts:66-73`，`src/types.ts:71-85`）：
  ```ts
  export type PromptContentPart =
    | { readonly type: 'text'; readonly text: string }
    | { readonly type: 'image'; readonly mediaType: ImageMediaType; readonly data: string; readonly name?: string }
    | { readonly type: 'file'; readonly receiptId: Branded<'file-upload-receipt-id'> }
  ```
  ⇒ 插件把 `message` 包成 `[{ type: 'text', text: message }]`。
- 返回值：`lib/types/types.d.ts:321-323` ⇒ `{ accepted: true }`。
- 幂等键确实生效：`src/commands.ts:306`
  `if (hasPromptRequest(agent, request.requestId)) return { accepted: true }`。
- `mode` 语义（`src/commands.ts:338-339` → `packages/core/agent/src/runtime-types.ts:246-260`）：
  `queue` → `agent.followup()`，排队成独立的一轮；
  `steer` → `agent.steer()`，最近的 step 边界消费（空闲会话则直接开启一轮）。
- 空内容宿主也会拒：`src/commands.ts:64-66` + `src/index.ts:467-469`
  （`gateway/bad-request`）；本插件在调用前先拒，错误更直白。

### `defineTool` / 参数 DSL / 输出契约

- `defineTool`：`packages/core/tools/lib/types/schema.d.ts:248`，
  选项形状 `DefineToolOptions`：`schema.d.ts:177-240`
  （`name`、`description`、`parameters`、`output.schema`、`output.render(args, value) → ContentBlock[]`、
  `execute(args, exec) → output.schema 的规范值`）。
- 参数 DSL：`schema.d.ts:19-84`——`parameters` 是隐式开放对象根，
  必填写成属性上的 `required: true`，`enum` / `default` / `description` 是节点注解；
  输出对象必须显式写 `additionalProperties`（`schema.d.ts:58-62`）。
- `ctx.tools`：`packages/core/tools/lib/types/index.d.ts:23-27`（`Context.tools: ToolsService`），
  `register(definition, options?): () => void`（同文件 `:50`，返回精确的反注册闭包）。
  本插件用 `ctx.effect(() => ctx.tools.register(...))`，把该闭包作为清理句柄交给 effect。
- `exec.signal`：`packages/core/tools/lib/types/contracts.d.ts:208` + `:190`（`ToolExecution.signal: AbortSignal`）。
- 插件导出形态：`apply(ctx)` + `export const name` + `export const inject`
  （`skills/cordis-plugin-development/references/host-plugin.md:57-64`）。

### 与任务文档的不一致之处（逐条）

1. 文档 §4.2 的调用形态 `{ requestId, sessionId, mode, content }` 中，本地 `content` 是
   **`PromptContentPart[]`**，不是字符串；文档暗示的 `content: message` 不成立。已按部件数组实现。
2. 文档未提到 `prompt` 的第二个参数：本地签名要求 `signal: AbortSignal`。已传 `exec.signal`。
3. 文档 §4.2 的参照返回 `{ accepted, sessionId, mode, requestId }` 不是宿主返回形状；
   宿主 `prompt` 只返回 `{ accepted: true }`。插件按宿主返回值投影成该参照形状（`sessionId`/`mode`/`requestId`
   取自入参），并在 canonical 中只声明这四个字段。
4. `mode` 与 `requestId` 在本地类型里都是**必填**字段（文档称 mode 可选、requestId 可选）；
   插件侧 `mode` 参数仍是可选并默认 `'queue'`，在调用前补全，不影响宿主契约。
5. `create` 的 `cwd` 与 `workspaceId` 互斥（文档未提，`commands.ts:121-122` 直接拒
   `gateway/bad-request`）。v1.3.0 起两个都暴露，并在插件侧先拒同给，错误更直白。
6. `SessionCreateValue` 不返回 `cwd`，因此 joined 时回显 Workspace 的 `path`（那正是宿主用的 cwd），
   未 join 又给了 `cwd` 时回显调用方给定值，两者都没有时渲染 `cwd: default`（真实默认由宿主决定）。

## 工具语义

- `session_create`
  - `cwd` 可选，给了就必须是**绝对路径**且当前可访问（`node:path` 的 `isAbsolute` 按宿主平台判定；
    相对路径、不存在的目录、非目录都直接拒，不猜基准目录）。
  - **落在哪个分组（v1.3.0）**：宿主 `create` 只接受 `workspaceId` **或** `cwd`，而且**只有
    `workspaceId` 会把会话挂到 Workspace 上**（`commands.ts:133` 用 `workspace.path` 当 cwd，
    `:147-157` 才 `attachSession`）。只给 `cwd` 建出来的会话不属于任何 Workspace，UI 就把它排在
    所有分组之外（“未分类”）。所以插件按这个顺序决定位置（`joinTarget`）：
    1. 显式 `workspaceId` → 直接透传（宿主校验，未知 id 报 `workspace/not-found`）；
    2. 显式 `cwd` → `workspaceRegistry.resolveByPath(cwd)`，命中就用它的 `workspaceId`（自动归组），
       **不**替调用方新建 Workspace（那会在用户的分组列表里留下条目）；没命中就按纯 `cwd` 创建，
       渲染里明说 `ungrouped`；
    3. 两个都没给 → 用 `exec.agent.id` 在 `workspaceRegistry.list()` 里找**当前会话所属的
       Workspace**，用它的 id（于是新会话和当前会话在同一组，目录也一致）；当前会话本身不在任何
       Workspace 时什么都不传，交给宿主的默认 cwd。
    `inject` 因此多了 `workspaceRegistry`（`@deepseek-ai/dsh-workspace`，`lib/types/index.d.ts:82`）。
    profile 里没挂 `workspace` 行的（比如裸 `headless`）插件会因 `inject` 不满足而不激活——
    `web` 有这一行。
  - `agentPreset` 可选，透传给宿主；preset 不存在时由宿主报错（`agent-preset/not-found`，不会留下会话）。
  - **模型与思考强度（v1.2.0）**：新建会话默认**沿用当前会话的模型与思考强度**（"同模型、同思考强度"），
    也可由调用方指定：
    - 当前会话的选择读自执行上下文里 live Agent 的运行时面 `exec.agent.model.current()`
      （agent loop 派发工具时传 `agent: this`，见 `packages/core/agent-loop/src/agent.ts:591`；
      运行时面声明在 `packages/core/agent/src/runtime-types.d.ts`，`Model.current()` 返回已记录的
      provider/model/reasoningEffort，且适配器**默认化**的 effort 不会被钉进去——照抄它正好是
      "同思考强度"而不是把一次默认值固化成显式选择）。上下文没有 Agent（例如非常规执行环境）时
      退化为"无模型可抄"，走部署默认，不报错。
    - 选模型走宿主唯一的选择命令 `sessionController.selectModel(request)`
      （`lib/types/index.d.ts:106`；请求体 `SessionSelectModelRequest extends ModelSelection`，
      `lib/types/types.d.ts:281-283`）：先 `create` 再 `selectModel`，宿主负责校验模型可用性
      （`requireModel` + `ctx.llm.resolveCallConfig`，`src/commands.ts`）并把选择持久化到该会话。
    - `model` 可选：给定则覆盖继承的模型。`provider` 省略时按宿主模型目录（`modelCatalog()`，
      `lib/types/index.d.ts:116`）反查：id 在目录里唯一才自动解析，多个 provider 都提供该 id 时
      报错并要求显式给 `provider`（`provider` 只能与 `model` 同用）。
    - `reasoningEffort` 可选：给定则覆盖继承的思考强度；省略则继承当前会话的 effort——换模型继承时
      若目录显示新模型不提供该 effort，降级为该模型的 `defaultEffort`（目录可见才校验/降级，看不到就
      交宿主裁决）。显式给的 effort 若目录可见且不提供，**在创建会话之前**就报错（不残留会话）。
    - 全部解析发生在 `create` 之前，所以能提前发现的错误（模型歧义、目录里没有、effort 不提供、
      `provider` 缺 `model`）都不会留下会话；只有宿主的可用性校验可能发生在创建之后，那时报错
      会带上已创建的 sessionId（`session_create: session <id> was created but its model selection
      failed: …`），调用方仍可向它 `session_inject`。
    - **宿主副作用（取证 `src/commands.ts` 的 `selectModel`）**：宿主在记录会话选择之外还会在后台
      把该选择存成**部署默认模型**（`ctx.agentDefaultModel.saveSelection`）。这是宿主命令的固有行为，
      对显式指定与默认继承一视同仁；不希望动部署默认时只能不用带模型选择的 `session_create`。
  - 新建的会话**是空闲的**：没有消息进来就不会执行任何东西；它继承本部署默认的 Agent preset 与文件策略。
  - 取消：`exec.signal` 已 aborted 时不发起创建。宿主 `create(request)` 不接收 signal
    （`lib/types/index.d.ts:100`），所以创建**无法中途取消**；`prompt` 接收 signal，已传 `exec.signal`。
  - 失败：包装成一条明确的工具错误（保留宿主 `RemoteError` 的 `code`），不抛裸异常。
- `session_inject`
  - 副作用：写入的是**真实用户消息**，进入目标会话的持久日志，不可撤销；插件不做内容审查。
  - 副作用还包括**唤醒目标会话**：消息被接受后目标会话会按它自己的 preset / 权限模式 / 文件策略继续执行
    （queue 注入后，目标会话会按它自己的 preset 跑一轮并回复）。
  - 可达范围：普通顶层会话。subagent 拥有的会话会被宿主拒掉：
    `session "…" is owned by subagent routing (session/agent-busy)`
    （`packages/api/session-controller/src/agent.ts:114-120`；这类会话的存储目录名也没有
    `session-` 前缀）。
  - `message` 必填，纯空白在插件侧先拒。
  - `requestId`（v1.1.0 起可选，幂等键）：
    - 省略 → 键为 `agent-tools:<rootCallId>`，即**每个模型 tool call 一个键**
      （`ToolRunContext extends ToolExecution`，`rootCallId` 见 `contracts.d.ts:208-212, 231`）；
      同一次 tool call 被执行器重新派发不会插两条。执行上下文没有 call id 时退回 `randomUUID()`。
    - 显式给 → 键为 `agent-tools:<给定值>`（4-150 个 `\w-` 字符）；如果给的就是上一次返回的完整键，
      原样使用。所以"重试"的正确做法是把上一次返回的 `requestId` 原封不动传回来。
    - 宿主侧去重：`src/commands.ts:306` `hasPromptRequest(agent, requestId)` 命中就直接
      `return { accepted: true }`，不再插入消息。一个键**不要**用于两条不同文本。
    - 加 `agent-tools:` 前缀是为了不和别的生产者（GUI 自己的 rpcId）撞键。
    - **去重有窗口缺口（1.1.0 起在本机复现过）**：宿主的 `hasPromptRequest` 只查 inbox 与已落盘历史
      （`src/commands.ts:542-553`），而消息一进 turn 就离开 inbox、它的 `user/message` 要等到
      turn 开始才写盘，所以这中间发出的同键第二次调用查不到任何东西，会再插一条。执行器还会把
      同一步里的两次调用**串行**跑完，所以单纯加并发锁没用。
    - v1.1.1：本注册实例内持有“已发起的 prompt”，同键并发合并成一次；同键不同文本直接报
      `… is already in flight with different text`。
    - v1.1.2：再加一张 60 秒的**已完成键账本**（`lookupRetry`/`rememberRetry`，上限 256 条，
      每次查询按龄清理，随注册实例释放）。同键同文本在窗口内直接复用上一次回执、不再调宿主；
      同键不同文本报 `… was already used for different text within 60s`。这把上面那个缺口堵上，
      跨进程/超窗的重试仍由宿主按历史去重。
  - `accepted: true` 只表示**已进 Agent 的 inbox**，不保证最终被处理：会话被销毁时 pending 会被
    记成取消并丢弃，之后唤醒该会话也不会补处理。长命 Host（如 web profile）里 queue 的 pending
    会正常成为下一个 turn，也会被投影缓存持久化
    （`storages/session_projcache/sessions/<id>.json` 的 `inbox.next-turn`）。
  - `mode`：`'queue'`（默认，落到 `target=next-turn`）或 `'steer'`（落到 `target=next-step`，
    `src/commands.ts:338-339`）。目标会话**正在跑 turn** 时：steer 在下一个 step 边界被吃进
    **同一个 turn**，queue 排队成**下一个 turn**。

### `session_error_audit`（v1.4.0）

只读的运维视角工具：扫 `~/.dsh/sessions` 下每个会话的 `session.v4.jsonl.zstd`，把工具调用与编辑的
`isError` 结果归类计数，回答“哪类错误在反复发生、哪些会话/文件最招错”。

- **有界输出**：类别取前 10、worst sessions 与 top offenders 各 `top` 行（默认 3，钳到 1-5），
  整份摘要约 40 行。错误正文与文件/命令在**提取时就截断**，所以内存平坦、会话细节绝不进上下文；
  要看某个会话用 `read` 分页读它的日志。
- **归类词表**（`classifyErrorText`，先具体后泛化）：`edit-mismatch`（`old_string was not found`）、
  `edit-stale`（文件被并发改过）、`edit-not-read`（改前没读）、`timeout`（执行超时）、
  `search-bad-path`（ripgrep 路径不存在）、`syntax`、`network`、`bad-args`、`enoent`、`other`。
  词表来自本机会话历史里真实反复出现的失败，用来验证“加了守卫之后该类错误是否下降”。
- **参数**：`since`（ISO 8601 下界，非 ISO 直接拒）、`cwd_contains`（按会话工作目录子串过滤）、
  `top`。损坏或读不了的日志文件**跳过而不是抛错**（`decodeSessionLines` 返回空数组）。
- 只用 `node:fs` / `node:zlib`（原生 `zstdDecompressSync`，一次同步解出拼接帧），不碰宿主服务。

## 依赖与前置条件

- 只在 Host 侧运行；`package.json` 不声明 `dsh.client`，patch 不插 Client 行。
- 需要 profile 里已挂载宿主行 `session-controller`（`@deepseek-ai/dsh-api-session-controller`）。
  `web` profile 有（`packages/bundle/web-app/cordis.patch.yml:117-118`）；
  `headless` profile **没有**，且它还缺 `session-controller` 注入所需的
  `connection` / `file-upload` / `workspace`（`packages/bundle/sdk-app/cordis.patch.yml:47-56`）。
  在没有该行的 profile 里，插件会因为 `inject` 未满足而不激活——这不是插件缺陷，是 profile 组合问题。
- `peerDependencies` 全是 `workspace:~` 的 dsh 自带包，运行期不安装；唯一的运行期 import 是
  `@deepseek-ai/dsh-tools` 的 `defineTool`，其余只参与类型。装进 profile 时 pnpm 会给一句
  peer 警告，与 `@local/adaptive-effort-scheduler` 的表现一致，不影响加载。
- 分发用 `release/` 的 tarball，不要直接 add 本地目录：`dsh plugin ... add <本地目录>` 装成
  `link:`，Node 从真实路径（你的工作区）解析 `@deepseek-ai/*` 会失败
  （`ERR_MODULE_NOT_FOUND: '@deepseek-ai/dsh-tools'`）。tarball 装进 profile 的
  `node_modules` 后，向上解析到 `<DSH_HOME>/profiles/node_modules/@deepseek-ai/*` 才成立。

## 安装

正式安装走 Release 资产（地址不带版本号，永远是最新一版）：

```sh
dsh plugin --profile <profile> add https://github.com/chocobo77/dsh-agent-session-tools/releases/latest/download/dsh-agent-session-tools.tgz
```

本机打包安装：

```sh
dsh plugin --profile <test-profile> remove dsh-agent-session-tools   # 首次安装可跳过
dsh plugin --profile <test-profile> add <release/dsh-agent-session-tools-<version>.tgz>
```

换版本时必须先 `remove` 再 `add`：只 `add` 时 pnpm 可能因同名同版本判为
“Already up to date” 而保留旧条目。DSH 按包名缓存已导入模块，禁用/启用不会重读；
替换已安装包必须重启 Host。

开发期免打包：`dsh --profile <profile> --patch ./cordis.yml`，把条目指到 `./dist/index.js`
（本目录的 `node_modules` 垫片让 `@deepseek-ai/*` 在运行期也能解析）。

## 变更记录

| 版本 | 变更 |
|---|---|
| 1.0.0 | `session_create` / `session_inject`：绝对路径 `cwd`、`queue` / `steer` 两种落点、宿主错误码原样保留 |
| 1.1.0 | `requestId` 可选幂等键；省略时用 `agent-tools:<rootCallId>` |
| 1.1.1 | 注册实例内的 in-flight 表：同键并发合并成一次，同键不同文本报错 |
| 1.1.2 | 60 秒已完成键账本：串行重试落在宿主去重窗口缺口内也只插入一次 |
| 1.2.0 | 模型选择 `model` / `provider` / `reasoningEffort`，默认继承调用方当前 route 与思考强度 |
| 1.3.0 | Workspace 归组：注入 `workspaceRegistry`，不带位置参数时沿用当前会话所属的 Workspace |
| 1.4.0 | 只读工具 `session_error_audit`（有界摘要）；Code Wiki 8 页 |

行为语义以上文「工具语义」与「兼容基线」为准。离线检查：`npm test`（`tests/` 三个文件）、
`node scripts/build.mjs tsconfig.typecheck.json`。
