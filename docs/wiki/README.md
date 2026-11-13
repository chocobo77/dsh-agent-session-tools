# dsh-agent-session-tools · Code Wiki

> 基于工作区源码（package.json `version: 1.4.0`）生成，生成日期 2026-11-14。
> 行号引用（如 `src/index.ts:19`）相对仓库根目录；`dist/` 为构建产物，不作为分析对象。

## 项目一句话

`dsh-agent-session-tools` 是一个 **DSH（deepseek-harness）宿主侧（Host-only）工具插件**：
它自己不实现任何会话逻辑，而是把宿主 `SessionController` 的既有能力包装成三个可被
Agent 直接调用的工具，通过 cordis 插件机制挂进宿主。

| 工具 | 作用 |
|---|---|
| `session_create` | 新建会话：可指定 `cwd` / `workspaceId` / `agentPreset` / 模型与思考强度；默认沿用当前会话的模型、思考强度与所属 Workspace |
| `session_inject` | 向指定会话投递一条**真实用户消息**（进入目标会话持久日志），支持 `queue` / `steer` 两种注入时机，内置三层幂等去重 |
| `session_error_audit` | 扫描持久化会话日志（`~/.dsh/sessions`）中的 `isError` 工具结果，返回**有界**的分类汇总（约 40 行以内） |

## 导航

| 文档 | 内容 |
|---|---|
| [01 项目概览](01-overview.md) | 定位、设计原则、功能特性、版本沿革、已知注意事项 |
| [02 整体架构](02-architecture.md) | 宿主-插件关系、cordis 插件契约与生命周期、三个工具的数据流、部署拓扑 |
| [03 目录与模块](03-modules.md) | 完整目录树、文件清单、各模块职责边界 |
| [04 关键函数参考](04-key-functions.md) | `checks.ts` / `session-tools.ts` / `error-audit.ts` / `index.ts` 全部导出的说明 |
| [05 工具契约](05-tool-contracts.md) | 三个工具的参数表、输出 schema、错误码、幂等与边界语义 |
| [06 依赖关系](06-dependencies.md) | 运行期/类型期依赖、peerDependencies、构建垫片（shim）机制、profile 前置条件 |
| [07 构建与运行](07-build-and-run.md) | typecheck / build / test / pack 命令、安装与升级、开发期加载、故障排查 |

## 快速上手（30 秒版）

```sh
npm run typecheck    # 严格类型检查（tsc -p tsconfig.typecheck.json）
npm run build        # 编译到 dist/（tsc -p tsconfig.build.json）
npm test             # vitest run —— 3 个文件 78 项测试
./pack.ps1           # 一键：build → test → npm pack → 校验 → SHA256SUMS.txt
dsh plugin --profile <profile> add release/dsh-agent-session-tools-<version>.tgz
```

> 本仓库**不安装依赖**：`scripts/build.mjs` 会把 `typescript` 与 `@deepseek-ai/*` 类型包从
> DSH checkout 或兄弟项目**链接**进本目录 `node_modules` 垫片。详见
> [06 依赖关系](06-dependencies.md)。

## 三分钟读懂代码

1. [src/index.ts](../../src/index.ts)（23 行）—— 插件入口：`name` / `inject` / `apply`，
   注册三个工具并交出反注册句柄。
2. [src/session-tools.ts](../../src/session-tools.ts) —— `session_create` / `session_inject`
   的 `defineTool` 定义、模型选择解析与 Workspace 归组。
3. [src/error-audit.ts](../../src/error-audit.ts) —— `session_error_audit`：日志扫描、
   错误分类与有界汇总渲染。
4. [src/checks.ts](../../src/checks.ts) —— 两个会话工具共享的**纯函数**校验层
   （cwd 校验、幂等键、重试账本、模型目录解析等），单测直接驱动。
