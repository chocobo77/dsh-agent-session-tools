# 01 · 项目概览

## 1. 定位

`dsh-agent-session-tools` 是 DSH（deepseek-harness）的一个 **Host-only 插件**
（`package.json` 不声明 `dsh.client`，patch 也不插 Client 行）。它解决的问题：

- Agent 在对话中需要**开新会话**或**向别的会话递消息**，但宿主的会话 API
  （`ctx.sessionController`）只有宿主内部与 RPC 通道可达；
- 本插件把这两个能力注册进 `ctx.tools`，让模型可以像调用普通工具一样调用它们；
- 额外提供一个**只读的运维审计工具** `session_error_audit`，扫描本地会话日志
  统计工具调用错误趋势。

插件的核心立场（README「工具语义」一节反复强调）：

- **宿主优先**：所有校验、持久化、去重的最终裁决权在宿主；插件只做"能让错误
  更直白、更早发生"的前置检查；
- **无自有状态**：插件不存任何会话数据；仅有的两块内存状态（in-flight 表、
  60 秒重试账本）随注册实例生灭；
- **失败要说人话**：宿主 `RemoteError` 的 `code`（如 `session/not-found`）被保留
  在错误文本里，模型拿到的是一行可行动的失败说明，而不是裸异常。

## 2. 功能特性

### session_create
- 不带位置参数时**沿用当前会话所属的 Workspace**（新会话与当前会话同组、同目录）；
- 默认**继承当前会话的模型与思考强度**（读 live Agent 的运行时面
  `exec.agent.model.current()`）；`model` / `provider` / `reasoningEffort` 可覆盖；
- `cwd` 必须是**当前可访问的绝对目录**（相对路径、不存在、非目录都在调用宿主
  之前拒绝，不猜基准目录）；
- 只给 `cwd` 时先按路径反查 Workspace（`resolveByPath`），命中则自动归组；
  不替调用方新建 Workspace；
- 模型/effort 的**可命名错误**（歧义模型、目录里没有、effort 不提供、`provider`
  缺 `model`）全部发生在 `create` **之前**，失败不残留会话。

### session_inject
- 投递的是**真实用户消息**：进入目标会话持久日志、不可撤销、会**唤醒**目标会话；
- `queue` → 排成独立下一轮；`steer` → 最近 step 边界被吃进当前轮；
- **三层幂等**：
  1. 省略 `requestId` 时键为 `agent-tools:<rootCallId>`（每个模型 tool call 一个键，
     执行器重新派发不会插两条）；
  2. 注册实例内的 **in-flight 表**：同键并发合并成一次宿主调用；同键不同文本直接报错；
  3. **60 秒已完成键账本**（上限 256 条）：堵住"宿主去重窗口缺口"——消息离开
     inbox 但尚未落盘期间的同键重试；
- `exec.signal` 透传给宿主 `prompt(request, signal)`，注入可随工具调用取消。

### session_error_audit（v1.4.0 新增）
- 递归扫描 `~/.dsh/sessions/<workspace>/<session>/*.jsonl[.zstd]`，用 Node 原生
  `zstdDecompressSync` 解码 zstd 帧；
- 逐行解析 JSONL 事件（`session` / `tool/call` / `tool/result`），对 `isError` 的
  工具结果做**分类**（edit-mismatch、edit-stale、timeout、syntax、network 等 10 类）
  与**归因**（错误文本中引号里的文件路径 / 命令头）；
- 输出**硬性有界**：分类表 ≤10 行 + worst sessions/top offenders ≤5 行（`top`
  参数钳制 1–5，默认 3），总长约 40 行；错误正文截断在 200 字符且**不进入对话**，
  明细留在磁盘上。

## 3. 设计原则（代码中可验证）

| 原则 | 体现 |
|---|---|
| 纯函数校验层 | `checks.ts` 全部导出为无副作用函数，单测直接驱动（`tests/checks.test.ts`） |
| 提前失败 | 一切能在调用宿主前发现的错误都在之前抛出（相对 cwd、空文本、非法 requestId、模型歧义…），测试断言 `recorded.create` 为空 |
| 取消友好 | 入口与"选择解析完成后"各查一次 `exec.signal`（创建无法中途取消，所以解析后的复查是最后一个免费取消点） |
| 有界输出 | audit 工具的 summary、render 的单行文本、重试账本的 256 条上限，都防止对话膨胀 |
| 宿主兼容 | 输出形状按宿主实际返回投影（README「与任务文档的不一致之处」逐条记录了取舍） |

## 4. 版本沿革

| 版本 | 要点 | 出处 |
|---|---|---|
| 1.0.0 | `session_create` / `session_inject` 基础语义；现场轮次 A 验证 | README 轮次 A |
| 1.1.0 | `requestId` 可选幂等键：省略 → `agent-tools:<rootCallId>`；实测发现宿主去重窗口缺口 | README 轮次 B/C |
| 1.1.1 | in-flight 并发合并（同键并发只调一次宿主；同键异文报错） | README |
| 1.1.2 | 60 秒已完成键账本（`lookupRetry`/`rememberRetry`），堵住串行重试缺口 | README 轮次 C |
| 1.2.0 | 模型与思考强度继承（`model`/`provider`/`reasoningEffort`）；测试纳入类型检查范围 | git tag `3e9f0fa` |
| 1.3.0 | Workspace 归组：注入 `workspaceRegistry`，`joinTarget` 三级解析；无位置参数时沿用当前会话所属 Workspace | README 轮次 D/E |
| 1.4.0（当前工作区） | 新增 `session_error_audit`（`src/error-audit.ts`，未入库为 untracked 文件）；测试扩到 78 项 | 工作区 `git status` |

## 5. 已知注意事项（文档与代码的滞后点）

生成 Wiki 时核对出的、对维护者有用的不一致（均为可验证事实）：

1. **README 落后于工作区**：README 开头仍写"向 Agent 暴露两个工具"、"不注册
   其他工具"，但当前 `src/index.ts:22` 已注册第三个工具 `session_error_audit`，
   且 `tests/session-tools.test.ts:107` 的注册断言是三个名字。README 的
   「验证结果」也停在 v1.2.0 的 63 项（现为 78 项）。
2. **pack 校验清单未含新模块**：`pack.ps1:90-91` 与 `pack.sh:96-97` 的 tarball
   必含清单只有 `dist/index.js`、`dist/session-tools.js`、`dist/checks.js`，
   没有断言 `dist/error-audit.js`。tarball 本身不受影响（`package.json` 的
   `files: ["dist"]` 会带上整个 dist/），只是发布前的最后一道断言没覆盖新文件。
3. **`ErrorRecord` 接口暂未被运行时路径引用**：`src/error-audit.ts:23-28` 导出的
   `ErrorRecord`（cwd/tool/taskHead/text）目前没有被 `scanLines`/`auditSessions`
   构造，属预留形状。
4. README 中记录的现场验证轮次（A–E）针对旧版本语义，仍是理解宿主行为的最佳
   取证材料，但结论应以当前源码为准。
