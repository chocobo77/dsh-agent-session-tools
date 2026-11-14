# 07 · 构建与运行

## 1. 前置条件

| 项 | 要求 | 说明 |
|---|---|---|
| Node.js | `>= 22.19.0`（pack 脚本强制检查） | `engines` 口径；zstd 原生支持 |
| 类型来源 | 可被 `scripts/build.mjs` 找到的 deps root | DSH checkout / 兄弟插件项目 / `$DSH_NODE_MODULES`；详见 [06 §3](06-dependencies.md) |
| 本仓库 | **不需要 `npm install`** | 依赖经垫片链接借用 |

> 若所有候选都找不到：`No node_modules with typescript and the @deepseek-ai
> types found. Point DSH_NODE_MODULES at a node_modules directory (or DSH_HOME
> at a DSH checkout) and retry.` —— 按报错设置环境变量即可。

## 2. 命令速查（package.json scripts）

| 命令 | 实际执行 | 用途 |
|---|---|---|
| `npm run typecheck` | `node scripts/build.mjs tsconfig.typecheck.json` | 严格类型检查（noEmit，覆盖 `src/` + `tests/`） |
| `npm run build` | `node scripts/build.mjs tsconfig.build.json` | 产出 `dist/*.js` + `.d.ts` |
| `npm test` | `vitest run` | 三个测试文件（覆盖见 §覆盖要点） |
| `npm run prepack` | `npm run build` | `npm pack` 前自动构建 |
| `./pack.ps1` | build → test → npm pack → 校验 → SHA256 | 一键发布（Windows） |
| `./pack.sh` | 同上（bash 复刻） | 一键发布（Linux/macOS/Git Bash） |
| `./pack.cmd` | 转发 pack.ps1 | cmd 入口 |

`pack.ps1` 参数：`-OutDir release`（默认）、`-SkipTests`、`-KeepOutDir`（默认先
清空输出目录）；`pack.sh` 对应 `--out-dir DIR` / `--skip-tests` / `--keep-out-dir`。

## 3. TypeScript 配置三件套

```
tsconfig.json（编辑器）─extends→ tsconfig.typecheck.json ←extends─ tsconfig.build.json
```

| 关键开关 | 值 | 影响 |
|---|---|---|
| `target / module` | `es2024 / esnext` | 现代语法直出 |
| `moduleResolution` | `bundler` | 允许 `allowImportingTsExtensions`（源码里 `./checks.ts` 后缀导入） |
| `exactOptionalPropertyTypes` | true | 可选属性**不容许显式 undefined**——解释了源码里大量 `...(x === undefined ? {} : { x })` 展开写法 |
| `noUnusedLocals/Parameters` | true（typecheck） | build 配置里关掉 locals（`ctx` 占位参数不报错） |
| `rewriteRelativeImportExtensions` | true（build） | 产物中 `.ts` 导入重写为 `.js`，`dist` 内相对引用成立 |
| include | typecheck 含 `src+tests`；build 只含 `src` | 测试参与类型检查（v1.2.0 起） |

## 4. 测试

### 运行

```sh
npm test                 # vitest run（垫片 .bin/vitest.cmd → 借用的 vitest.mjs）
npx vitest run --config vitest.config.ts   # 任何可用的 vitest 均可
```

`vitest.config.ts`：`include: ['tests/**/*.test.ts']`、`environment: 'node'`、
`pool: 'forks'`。测试直接跑 **TS 源码**（不需要先 build）；`@deepseek-ai/*`
由垫片解析。

### 覆盖要点

| 测试文件 | 覆盖 |
|---|---|
| `checks.test.ts` | `ownerWorkspace` 三分支；重试账本（窗口/过期清理/异文拒绝/上限）；`promptRequestId` 三来源与非法 token；`hasText`；`describeFailure`（code 保留、非 Error）；`checkedCwd`（相对/存在/缺失/非目录，用 tmpdir 建真实目录）；`providerOfModel`（唯一/未列出含失败 provider/歧义）；`checkedEffort`（提供/不提供列可选项/无清单透传）；`carriedEffort`（无 effort/保留/降级 defaultEffort/无清单透传） |
| `session-tools.test.ts` | 注册三个工具 + disposer 反注册；`create` 请求体形状（省略 cwd 不塞空字段）、cwd/workspaceId 互斥、相对路径与取消**在调宿主前**拦截、Workspace 三级归组（沿用当前会话/反查/显式 id/不造 Workspace）、模型继承全矩阵（整体抄/同 id 沿用路由/目录反查/歧义与未知模型创建前拒/provider 缺 model/effort 校验与降级/无模型施 effort 被拒/selectModel 失败点名 sessionId）、render 各行；`inject` 请求形状（text 部件数组、mode、键来源）、显式 requestId 重试、异文拒绝、并发合并、串行重试合并、signal 透传、宿主错误带 code |
| `error-audit.test.ts` | 分类词表与顺序、归因正则、参数默认/钳制/ISO 校验、损坏字节容错 |

### 编写测试的既定模式

`tests/session-tools.test.ts:17-68` 的 `makeContext` 手写 fake ctx：`effect`
即跑即存 disposer、`tools.register` 只记录、`sessionController` 可注入失败/
延迟、`workspaceRegistry` 可配置。新增工具行为时沿用该模式（fake 最小、
断言"调用宿主前拦截"看 `recorded.*` 是否为空）。

## 5. 打包（pack.*）

`pack.ps1` / `pack.sh` 流程（两份脚本逻辑一一对应）：

1. **Node 版本检查**（`>= 22.19.0`）；
2. **构建**：`node scripts/build.mjs tsconfig.build.json`；
3. **测试**（可用参数跳过）：优先垫片 `.bin` 里的 vitest，缺失则回退
   `npx vitest run`；
4. **npm pack**：`npm pack --ignore-scripts --pack-destination <OutDir>`；
5. **tarball 校验**（两份清单）：
   - 必含：`package/package.json`、`package/cordis.patch.yml`、`package/cordis.yml`、
     `package/dist/index.js`、`package/dist/session-tools.js`、`package/dist/checks.js`；
   - 必不含：`package/(src|tests|scripts|node_modules|release)/…`；
6. **SHA256**：写 `<OutDir>/SHA256SUMS.txt`，打印安装命令。

> ⚠️ 维护注意：第 5 步必含清单**尚未包含 `dist/error-audit.js`**（v1.4.0 新模块）。
> tarball 本身不受影响（`files: ["dist"]` 全量携带），但建议补上断言，见
> [01 §5](01-overview.md)。

## 6. 安装与升级（部署到 DSH profile）

```sh
# 首次安装
dsh plugin --profile <profile> add release/dsh-agent-session-tools-<version>.tgz

# 换版本：必须先 remove 再 add
dsh plugin --profile <profile> remove dsh-agent-session-tools
dsh plugin --profile <profile> add release/dsh-agent-session-tools-<version>.tgz
```

- **只 `add` 不 `remove`**：pnpm 可能因同名同版本判为 "Already up to date" 而
  保留旧条目；
- DSH 按包名缓存已导入模块：**替换已安装包必须重启 Host**；
- 只装 tarball，不装本地目录（`link:` 安装的运行期解析失败，见
  [06 §4](06-dependencies.md)）；
- profile 需含 `session-controller`（及 inject 所需的 `workspace` 等）宿主行。

## 7. 开发期免打包加载

```sh
dsh --profile <profile> --patch ./cordis.yml
```

`cordis.yml` 把插件条目直接指到 `./dist/index.js`——改完源码 `npm run build`
后插件重启（apply 重跑）即生效，无需重新安装。本目录的 node_modules 垫片同时
服务运行期解析（`cordis.yml` 头注释）。

一次性验证 profile 的用法（不碰主力 profile）：

```sh
dsh --profile ast-verify --from-default-profile headless
# headless 模板缺宿主行，用 patch 叠加层补：
#   insert: session-controller / connection / file-upload / workspace
#   并打开被 headless 关掉的 credentials / authorization / deepseek-account
```

## 8. 故障排查速查

| 症状 | 原因 | 处置 |
|---|---|---|
| `Cannot find type definition file for 'node'` | scope 目录被整目录链接，pnpm 相对链接断裂 | 重跑 build（脚本已改为逐条目链接；旧垫片会被自动清理重建） |
| `No node_modules with typescript …` | 找不到可用 deps root | 设 `DSH_NODE_MODULES` 或 `DSH_HOME` |
| `npm test` 报 vitest 缺失/原生绑定崩溃 | 垫片 `.bin` 没建好，或借用的 vitest 跨 OS | 重跑 build（非 Windows 有冒烟探测）；或 `npx vitest run --config vitest.config.ts` |
| 插件不激活（工具列表里没有 session_*） | profile 缺 `session-controller` 等 inject 依赖行 | 换 `web` profile，或用 patch 补行 |
| 运行期 `ERR_MODULE_NOT_FOUND: '@deepseek-ai/dsh-tools'` | 以本地目录 `link:` 安装 | 卸载后改装 tarball |
| `npm pack` 后校验失败 | 构建产物缺失 | 看 build 步骤输出；确认 `dist/` 生成完整 |
| 模型报错 `… the Host model catalog is unavailable` | 目录取不到且给了未带 provider 的 `model` | 显式传 `provider` |
| `session_error_audit` 没扫到东西 | `~/.dsh/sessions` 不存在或布局不同 | 确认标准 DSH 安装与存储位置 |

## 9. 版本发布清单（维护者）

1. 改 `package.json` 的 `version`；
2. `npm run typecheck && npm test && npm run build` 全绿；
3. `./pack.ps1`（或 `pack.sh`）→ 检查 tarball 条目数与 SHA256SUMS.txt；
4. 若新增了 `dist/` 模块：**同步更新 pack.* 的必含清单**（当前欠
   `dist/error-audit.js` 一条）；
5. 同步 README（当前 README 落后 v1.4.0：仍写"两个工具"）；
6. `dsh plugin remove` + `add` 新 tarball + **重启 Host**；
7. 现场 smoke：`session_create {}`（应落在当前 Workspace）、
   `session_inject`（queue/steer）、`session_error_audit {}`（应返回有界汇总）。
