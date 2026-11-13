# 05 · 工具契约（面向模型与调用方的完整语义）

> 本文是三个工具的"使用说明书 + 行为边界"，描述的是**当前源码**的契约；
> README 中记录的宿主行为取证（2026-11-06，`@deepseek-ai/dsh 0.2.2-alpha.2`）
> 仍是理解宿主侧的权威材料。

## 1. `session_create`

**一句话**：新建一个普通顶层会话并返回其 id；默认落在当前会话的 Workspace、
沿用当前会话的模型与思考强度；新建的会话是**空闲的**，没有消息进来不会执行任何东西。

### 参数

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `cwd` | string | 否 | 新会话的**绝对**目录；相对路径/不存在/非目录在调用宿主前拒绝。与 `workspaceId` 互斥 |
| `workspaceId` | string | 否 | 新会话加入的 Workspace（UI 分组）；会话拥有该 Workspace 目录；未知 id 由宿主报 `workspace/not-found`。与 `cwd` 互斥 |
| `agentPreset` | string | 否 | 覆盖部署默认 Agent preset；未知由宿主报 `agent-preset/not-found`（不残留会话） |
| `model` | string | 否 | 覆盖继承的模型；`provider` 省略时须在宿主模型目录中唯一 |
| `provider` | string | 否 | 仅用于消歧多 provider 同名模型；**不能脱离 `model` 单独给** |
| `reasoningEffort` | string | 否 | 覆盖继承的思考强度；省略则继承（新模型不提供时降级为其 `defaultEffort`） |

### 归组决策（`joinTarget`）

1. 显式 `workspaceId` → 直接透传；
2. 显式 `cwd` → 按路径反查已注册 Workspace：命中 → 自动归组；未命中 → 纯 `cwd`
   创建，输出渲染 `ungrouped`（**不会替你新建 Workspace**，避免污染分组列表）；
3. 都不传 → 沿用**当前会话**所属的 Workspace；当前会话也不属于任何 Workspace
   （如 headless 会话）→ 不传位置参数，交给宿主默认 cwd。

分组重要时请显式给 `workspaceId` 或确认 cwd 已注册——工具描述里也是这么写的。

### 模型选择

- 默认：整体抄当前会话（provider + model + effort）；无 Agent 可读 → 部署默认；
- 全部可命名错误（空白取值、`provider` 缺 `model`、模型歧义、目录未列出、
  effort 不提供）都在 **create 之前**抛出，不残留会话；
- 宿主的可用性校验可能发生在创建之后——此时错误文本**点名已创建的 sessionId**
  （`session <id> was created but its model selection failed: …`），该会话仍可
  被 `session_inject`。

### 输出

```jsonc
{
  "sessionId": "session-…",        // 必填
  "cwd": "…",                       // 未归组且给了 cwd 时回显；joined 时为 Workspace.path
  "workspaceId": "…",               // joined 时存在
  "workspaceTitle": "…",            // joined 时存在
  "agentPreset": "…",               // 宿主实际落定的 preset（可能与请求不同）
  "provider": "…", "model": "…",    // 有模型选择时存在
  "reasoningEffort": "…"            // 选择带 effort 时存在
}
```

render（模型看到的一行）：
`session created: <id> (workspace: <title>, cwd: <path>) (preset: <p>) (model: <provider>/<model>, effort: <e>)`
未归组时为 `(cwd: <cwd|default>, ungrouped)`。

### 已知宿主副作用（README 取证）

宿主 `selectModel` 除记录会话选择外，还会把该选择**存成部署默认模型**
（`ctx.agentDefaultModel.saveSelection`）——对显式指定与默认继承一视同仁。
不希望动部署默认时，只能不用带模型选择的 `session_create`。

### 取消与失败

- `exec.signal` 已 aborted：入口即拒；解析期间取消（解析有 await 点）在创建前
  被复查到；**创建一旦开始无法中途取消**（宿主 `create` 不接收 signal）；
- 失败均包装为 `session_create: <宿主消息> (<code>)`。

## 2. `session_inject`

**一句话**：向既有会话投递一条**真实用户消息**——进入目标会话持久日志、不可撤销、
不审查内容，且会**唤醒**目标会话按它自己的 preset/权限/文件策略继续执行。

### 参数

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `sessionId` | string | ✔ | 目标会话 id（通常来自 `session_create` 的返回） |
| `message` | string | ✔ | 消息文本；纯空白在插件侧先拒 |
| `mode` | `'queue' \| 'steer'` | 否（默认 `queue`） | `queue`：排成目标会话的**下一轮**；`steer`：在最近 step 边界被吃进**当前轮**（空闲会话则直接开一轮） |
| `requestId` | string | 否 | 幂等键，**只用于重试**：传回上一次调用返回的完整 requestId 保证至多插入一次 |

### 幂等键规则（`promptRequestId`）

| 调用方式 | 实际键 |
|---|---|
| 省略 `requestId` | `agent-tools:<rootCallId>` —— 每个模型 tool call 一个键；执行器重派发同一步不重插 |
| 无 call id 的执行环境 | `agent-tools:<randomUUID()>` |
| 给 token（4–150 个 `[\w-]`） | `agent-tools:<token>` |
| 给上一次返回的完整键 | 原样使用 —— **重试的正确姿势** |

### 三层去重（插件侧两层 + 宿主一层）

| 层 | 覆盖场景 | 行为 |
|---|---|---|
| in-flight 表（注册实例内存） | 同键**并发**重叠 | 同键同文 → 合并等待同一 Promise；同键异文 → 抛 `… is already in flight with different text` |
| 60 秒已完成账本（上限 256） | 同键**串行**重试落在宿主去重窗口缺口内 | 同键同文 → 直接复用上次回执，不调宿主；同键异文 → 抛 `… was already used for different text within 60s` |
| 宿主 `hasPromptRequest` | 键已进 inbox 或已落盘 | 命中 → 直接 `{accepted: true}`，不插入 |

> **一个键绝不许用于两条不同文本**——否则轻则报错、重则绕过去重。

### 输出

```jsonc
{ "accepted": true, "sessionId": "…", "mode": "queue|steer", "requestId": "agent-tools:…" }
```
render：`message accepted: session <id> (mode: <m>, request: <key>)`。

### 边界与已知限制（README 现场取证）

- `accepted: true` 只表示**已进目标会话 inbox**，不保证最终被处理：
  - 一次性 headless 运行中入队成功但进程随后退出 → 该副本随会话销毁丢弃，
    事后唤醒也不补处理；
  - 长命 Host（web profile）中 queue 的 pending 会正常成为下一轮并被投影缓存持久化；
- subagent 拥有的会话被宿主拒：`session "…" is owned by subagent routing (session/agent-busy)`；
- 目标会话**正在跑 turn** 时：steer 在下一 step 边界进入同一 turn；queue 排成下一 turn；
- 注入无法撤回——消息落的是目标会话的持久日志。

## 3. `session_error_audit`

**一句话**：只读扫描本地持久会话日志，返回**有界**的错误汇总（类别计数、最差
会话、高频肇事者），明细永远留在磁盘上。

### 参数

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `since` | string | 否 | ISO 8601 时间下界；非 ISO 在插件侧拒绝 |
| `cwd_contains` | string | 否 | 会话工作目录子串过滤 |
| `top` | number | 否 | worst sessions / top offenders 的行数；默认 3，钳制 1–5 |

### 扫描对象

```
~/.dsh/sessions/<workspace 目录>/<session 目录>/*.jsonl[.zstd]
```

- `.jsonl.zstd` 用 Node 原生 `zstdDecompressSync` 一次解码拼接帧；损坏文件按空
  处理并跳过（审计不失败）；
- 关心三类事件：`session`（cwd）、`tool/call`（callId→工具名）、`tool/result`
  （`isError === true` 的结果）。

### 分类词表（顺序敏感）

`edit-mismatch` → `edit-stale` → `edit-not-read` → `timeout` → `search-bad-path` →
`syntax` → `network` → `bad-args` → `enoent` → `other`
（先匹配先得；完整判定见 [04 §3.2](04-key-functions.md)）。

### 输出示例（有界，约 40 行封顶）

```
session_error_audit: 12 tool errors across 4 sessions with errors
— categories —
   5  edit-mismatch
   3  syntax
   2  timeout
…
— worst sessions —
   6  D:\code\DSH\demo
   4  D:\code\DSH\plugin-live-test
…
— top offenders (tool → file/command) —
   4  edit → D:\code\DSH\demo\apps\radar.html
   2  bash → npm run build
…
```

### 使用场景与边界

- 周期性审计错误趋势、验证某类 guardrail 是否真的压下了某类失败；
- **只读**：不修改任何文件；
- 有意不返回错误原文（截断 200 字符且只进汇总统计）——要看明细，用 read 翻
  特定会话日志；
- `~/.dsh/sessions` 不存在时 `readdirSync` 会抛错——本工具假定标准 DSH 安装布局。

## 4. 三工具对比速查

| | session_create | session_inject | session_error_audit |
|---|---|---|---|
| 副作用 | 创建会话 + （可选）模型选择 + 宿主部署默认模型 | 目标会话持久日志 + 唤醒 | 无（只读） |
| 依赖宿主服务 | tools / sessionController / workspaceRegistry | tools / sessionController | 无（直接读文件系统） |
| 可取消 | 解析阶段可取消；创建后不可 | 透传 signal 给 prompt | 否 |
| 幂等 | 无（重复调用重复创建） | 三层去重 | 无 |
| 输出 | 投影对象 + 单行 render | 回执 + 单行 render | 多行 summary |
| 失败残留 | 可命名错误无残留；selectModel 失败残留会话 | 失败即失败，无残留 | — |
