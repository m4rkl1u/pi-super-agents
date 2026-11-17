# 基于 Pi 的 Super Agent：研究与落地建议

## 结论

**值得迁移的是「持续工作的授权与任务系统」，不是 DSH 本身，也不是更多 Agent 角色。**

**用户已明确产品方向：独立的 Slack 式 TUI 工作台。** 人可以创建多个 Agent，左侧选择群组或 Agent，向群组发消息，或进入单个 Agent 的真实上下文输入 prompt；Agent 能相互通信。后续需求已将早期“仅 `@` 唤醒”更新为：**无 `@` 的群消息交给该群专属助手，明确 `@` 时仅投递指定成员；助手回复不自唤醒。**

落地方案是 **Pi SDK 独立会话 + pi-tui 工作台 + 持久消息路由**。群助手长期保留，可为公开人类任务自动创建有短名和职责的 worker；默认无须逐次批准，可开启审批。worker 可归档，其公开成果按成员权限检索复用。`pi-subagents` 不是当前核心依赖。当前契约见 **[系统设计](./system-design.md)**，实现和验证状态见 **[README](../README.md)**。

下文保留初次研究的原型证据和适配分析；第 5、6 节是已被替代的任务助手方案，不是当前实现说明。研究事实固定于所列提交和本机版本，不构成生产上线承诺。

## 1. Target and Scope

- 目标：<https://github.com/deepseek-ai/dsh-superagent-prototype>
- 检查版本：`8c32a9dc5d72c033816c6a8110b37f40cf94fba4`，提交时间 `2026-10-31T20:06:31+08:00`。
- 研究范围：理念、领域模型、授权、执行、提示词、架构文档，以及 Engine、端口、SQLite Store、Effects、DSH Executor、GitHub 通知、插件入口和包导出。
- 本机基线：`@earendil-works/pi-coding-agent@1.5.0`，`pi-subagents@0.84.0`。
- 当前工作目录：`/Users/didi/git/pi-workspace`；研究开始时为空目录，不是 Git 仓库。
- 目标修改检查：克隆只用于读取，没有安装依赖、构建、运行服务或测试、修改源码。
- 原型声明：MIT 许可的研究原型，不是 DeepSeek 官方产品，不具备生产就绪承诺，也不等同于文章提到的所有内部实现。[D1]

## 2. Super Agent 的核心概念

### 2.1 优化目标是减少人的注意力消耗

普通 coding agent 通常等待一轮用户输入；该原型把 Agent 放在持续接收团队事件的位置。它应当自行处理已授权范围内的技术工作，只有结果、阻塞、需要人决策时才打扰人。

这不是“让模型不断自己找事做”。工作只能来自允许的明确指派，或人预先写明的主动规则。通知也不应成为逐步播报内部思考的流水账。[D2][] [D4][]

### 2.2 任务不是聊天记录

原型的主链路是：[D3][] [D7][]

```text
GitHub / Feishu
    → Trigger（不可变事件）→ Thread（讨论上下文）
    → Gate（程序检查权限）→ Assessment（模型判断语义）
    → Decision → Ticket + Mandate（任务与授权范围）
    → Assignment（一次执行尝试）→ Worker Session
    → Report → Outbox → 原讨论渠道
```

- **Ticket**：为什么做、做什么、做到哪一步；不随一次模型调用结束而消失。
- **Mandate**：谁授权、允许什么、来自哪个策略版本；模型不能自行扩大。
- **Assignment**：一次尝试，允许失败、重试和恢复，不等于新任务。
- **Subscription**：让后续讨论/CI 结果进入已有任务；提供上下文，不授予额外权限。
- **Session**：执行上下文和对话历史，不应承担任务数据库的全部职责。

主 Agent 负责接单、路由和对外沟通；Worker 自己调查代码、选择技术方案、实施和验证。原型明确不要求主 Agent 先把所有实现细节设计完才分派。[D2][] [D6][]

### 2.3 授权和语义判断分离

先由程序检查事件来源、发送者、监听范围、策略版本，再让模型判断是否值得做、是否重复、属于哪个范围。[D4][] [D8][]

主动工作有三种模式：

| 模式 | 推断出的主动任务 | 允许的明确指派 |
|---|---|---|
| `off` | 不接 | 可接 |
| `observe` | 记录本来会接的任务，不执行 | 可接 |
| `auto` | 匹配已启用规则后才可接 | 可接 |

`observe` 不是整个系统的只读模式：明确指派仍可能启动工作。人停止的任务不能因为机器人/CI 后续消息而复活；普通恢复还需要重新核对授权。策略变更也不是“立即杀掉所有工作”的同义词，应区分暂停接单、撤销某个授权和终止执行。

### 2.4 可靠性来自状态和核对，不来自“更长的 prompt”

原型使用 SQLite 事务保存领域状态与待执行效果，由 Effects/Outbox 在提交后执行，并记录输入是否交付、是否进入 worker 历史。[D9]

GitHub 回复附带消息 ID 标记，重试前检查是否已经发出，减少重复评论。[D10]

这是持久化、重试与幂等设计，**不代表所有外部操作都具有 exactly-once 保证**。例如启动进程或创建 PR 后、记录回执前发生崩溃，恢复时必须核对已有事实，不能直接重做。

## 3. Candidates：哪些能复用

| 候选 | 确认程度 / 边界 | 可用接口与前提 | 建议 |
|---|---|---|---|
| 完整 DSH 原型 | 已确认 / source-level 插件包 | 包根导出 `apply`、`Config` 和 core 符号；依赖 DSH/Cordis 注入服务，包标记 `private: true`。[D11] | 适合 DSH 部署研究，不适合当作 Pi 的即插即用库。 |
| 原型领域模型 | 逻辑可迁移；独立包边界未确认 | `Engine`、`Executor`、`Policy`、`Repositories` 等结构清晰；core 的外部 import 仅见 `node:crypto`，但没有独立的 `./core` 包导出。[D8][] [D11][] | 借鉴契约和测试场景；不要把私有路径导入当成受支持 API。若未来维护 fork，需另行评估依赖、升级与许可保留。 |
| DSH 管理 HTTP API | 已确认 / API-level，但非唯一外部接口 | 文档说明 loopback 管理路由；检查 Host/Origin 与 `x-orchestrator-request: 1`，不是远程认证协议。[D12] | 不是替换 DSH 执行器的捷径，也不应直接暴露公网。 |
| Pi SDK | 已确认 / source-level | `createAgentSession()`、`SessionManager`、resource loader、custom tools；本机 SDK 文档与示例。[P1] | 独立服务的执行基础；不要另写模型/tool loop。 |
| Pi RPC | 已确认 / command/protocol-level | 长驻 `pi --mode rpc`，JSONL 双向协议，SDK `RpcClient`。[P2] | 需要子进程边界或非 TS 宿主时可选；不是安全沙箱。 |
| Pi 扩展 | 已确认 / source-level | `registerTool`、`registerCommand`、事件、状态/UI；扩展拥有宿主 OS 权限。[P3] | 做用户入口和控制层，默认不把队列塞进 prompt 或会话日志。 |
| pi-subagents | 已确认 / 扩展与公开 API | event-bus RPC、structured delegation、capability ceiling、preflight、run/missions/schedules；需要活跃宿主上下文。[P4][] [P5][] | 适合任务助手和临时委派；当前工作台需要长期平级成员，首版优先直接使用 Pi SDK 会话。 |

**API/REST Reference Project：不适用。** 主要可复用边界是 Pi 的源码级 SDK/扩展契约；没有创建 REST 示例项目，也没有复制原型实现。

## 4. 本机 Pi 已具备的能力与缺口

### 已具备

- Pi：模型接入、工具执行、持久化会话、compaction、steer/follow-up、abort、生命周期事件。
- pi-subagents：前台/后台子会话、状态/恢复/停止、结构化结果、并发限制、worktree、mission 与 receipts、定时任务、supervisor 问答、现成 Fleet UI。[P4][]–[P7][]

### 仍需新增或核实

1. 外部事件如何认证、归并到 Thread、去重，以及谁有权下单。
2. 原型意义上的 Mandate、主动规则、任务状态与线程订阅。
3. 领域状态与执行副作用的可靠交付、崩溃窗口核对。
4. 外部消息的 Outbox、投递回执、隐私边界和通知降噪。
5. 常驻进程托管与重启恢复；现有 mission 账本不是自动调度恢复器。
6. 任务完成的业务证据，而不是把 runner `completed` 当成“PR 已合并”。

对于任务助手路线，现有 mission 可作为任务在人侧的展示/关联记录，但不要建立两套互相争抢权威的状态机：Super Agent 数据库拥有授权、接单与投递事实；Pi 拥有对话历史；pi-subagents 拥有 run 生命周期和执行产物。当前工作台路线暂不引入 mission 或完整 Ticket 引擎，具体见新设计。

## 5. 原始任务助手架构（已由工作台方案替代）

```text
入口：Pi 命令；之后按需求增加 GitHub / IM
                     │
            Super Agent 控制层
      身份与授权 → 去重/Thread → 接单判断
                     │
        SQLite：Ticket / Mandate / Input
           Assignment / Effect / Outbox
                     │
        pi-subagents 公开异步 RPC（优先）
                     │
       Pi worker：任务目录 + 持久化会话
                     │
        结构化结果 / 验证证据 / 需人决策
                     │
          状态核对 → Outbox → 原渠道
```

### 5.1 先复用执行器，而非重写执行器

在当前 Pi 中加载一个项目级扩展，通过 `subagents:rpc:v1:*` 的公开接口进行异步启动、状态查询、steer、resume 和 stop。启动前探测 `ping` 的 capabilities，不导入 `pi-subagents/src/...` 内部实现。[P5]

前台的 `pi-subagents/delegation` 适合一次有界的结构化评估；它不是后台 RPC 的替代品。初版不需要评审委员会或多层 Agent 树。

### 5.2 交互式与常驻式是部署选择，不是两套任务逻辑

- **个人版本**：控制层运行在当前 Pi 中，命令提交任务、查看状态、处理决策；退出宿主后不承诺继续接收新事件。
- **团队版本**：受托管的长驻宿主加载同一控制层与执行适配器；入口可以是 GitHub/IM。保持固定的父会话身份，重启后恢复原会话并核对持久化 run。
- **需要去掉 pi-subagents 依赖时**：再实现基于 Pi SDK 的 Executor；不要第一版同时维护两条执行路径。

常驻宿主可以基于 Pi SDK/RPC，但其与已安装扩展的恢复、唤醒、身份绑定需要专门验证，不应因为 API 存在就宣称组合已可生产使用。

### 5.3 必须处理的适配细节

- **结束信号**：Pi `agent_end` 后可能自动重试/恢复；使用 `agent_settled` 判定本轮稳定结束。业务完成还需结构化 report 和验收证据。[P1][] [P2][]
- **发送不等于完成**：RPC 接受 `prompt`、steer 返回 queued/delivered、worker 完成、业务验收，是不同事实。
- **不能盲目重发启动**：pi-subagents 支持按 `rpc-spawn-<requestId>` 查关联运行，但文档明确这不是幂等 spawn。丢失回复时先核对，证据缺失则标为待人工核对，而不是自动重发。[P5]
- **恢复有所有权约束**：resume 检查父会话、恢复元数据、能力上限与 lease。不能随便新开一个父会话并假定能接管旧 worker。[P5]
- **后台任务不等于常驻宿主**：子进程可以在父会话退出后继续，但监听器已停止；服务不能仅凭父会话暂时 idle 就回收它。[P5]
- **worktree 生命周期不同**：pi-subagents 的 managed worktree 通常在产物捕获后清理；原型目录按 Ticket 长期保留。若要多轮 PR 跟进，可由控制层创建并保留每 Ticket worktree，给 worker 显式 `cwd`，不启用第二套自动 worktree；不要两个系统同时负责删除。[P7]
- **资源不能无意继承**：专用服务显式配置 agentDir、资源加载、工具和凭据。SDK 的 MCP/codemode 等需显式加载并触发扩展绑定，不能假定自动等同于当前交互式 Pi。[P1]
- **mission 完成不能充当业务完成**：普通自动 mission 与显式验收 mission 的完成条件不同；必须以 Super Agent 的业务验收状态为准。[P6]

## 6. 原始任务助手实施顺序（已由工作台方案替代）

### 阶段 A：明确指派的闭环

建议先做：单仓库、单 worker、单入口；一个任务对应一个独立上下文和目录。

最小能力：

1. 接收明确任务，记录请求者、来源、事件 ID、范围和验收条件。
2. 程序授权通过后，事务创建任务与启动意图。
3. 通过现有公开执行接口运行 worker。
4. 记录结构化 `ready` / `blocked` / `failed`、证据、产物与需人决策。
5. 提供状态、停止、人工恢复与一次结果通知。
6. 重启核对已有运行；结果不明确时保留现场，不自动重复写入。

首版不自动合并、不部署、不允许 worker 改授权策略；未明确授权的跨项目操作不执行。没有必要先做 Web 面板，使用 Pi 的现有命令与 Fleet UI。

### 阶段 B：外部事件与跟进

只接一个真实渠道，补 Thread 订阅、人工回复、PR/CI 状态、通知去重和 Outbox 重试。PR 创建后是否完成由验收条件决定；需要持续交付的任务必须继续跟踪，而非因一轮模型结束而关闭。

### 阶段 C：有限主动性

增加一条具体规则并以 `observe` 运行，例如“记录默认分支 CI 失败的候选修复任务，但不自动执行”。观察误接单率和噪音后，再经明确批准开启该规则的 `auto`。规则应注明允许的事件/人/仓库/操作范围、停止条件与资源限制。

**暂不做**：多仓库自动规划、通用 DAG 引擎、向量记忆库、多个协调 Agent、完整 DSH 面板、无限递归、自动合并/部署。没有证据表明这些是第一版闭环的前提。

## 7. 验收与安全底线

至少覆盖以下测试，再接真实写权限：

| 场景 | 预期 |
|---|---|
| 非授权人、伪造来源、提示注入要求放宽权限 | 不创建执行授权；外部文本不能改变程序策略。 |
| 同一事件重复到达 | 不重复建任务或重复发确认。 |
| `observe` 下的主动候选 / 允许的明确请求 | 前者只记录，后者仍可执行；测试二者区别。 |
| 状态事务回滚 | 不启动 worker、不发外部消息。 |
| 启动已发生但回复丢失、服务崩溃 | 核对 run 关联；未知则停在待核对，不盲目重复启动。 |
| 人工停止后 CI/机器人消息到达 | 不恢复任务。 |
| 上下文新增了越界要求 | 重新请求授权，不能静默扩大 Mandate。 |
| worker 回合结束但测试失败或 PR 未满足要求 | 不宣称业务完成。 |
| 私聊内容要写入公开 GitHub | 按通道和内容策略阻止泄露。 |
| 发出回复后崩溃再重试 | 检查投递回执/幂等标记，避免重复通知。 |
| 父会话重载、退出、换会话 | 核对控制权和恢复能力，不能误接管或丢弃在跑的任务。 |

**worktree、独立 cwd、子进程、工具名字白名单都不是 OS 沙箱。** 原型也明确承认这一点。worker 拥有任意 shell 和宿主凭据时，prompt 中的“禁止合并”不构成可强制执行的边界。[D5][] [P3][] [P5][]

接真实外部内容前，使用专用低权限身份和受限运行环境；服务管理凭据不交给 worker。无写权限阶段只交付 patch；允许发 PR 后仍保留分支保护和人工合并。对于会扩大影响的操作，在实际工具/API/凭据层检查权限，而不仅是在接单时判断。

## 8. 已确认、假设与待决策

**已确认**：原型设计与上面的关键源码机制；本机 Pi/扩展版本；上述公开 SDK、RPC 和扩展文档契约。

**建议而非原型事实**：所有 Pi 适配设计。最初的单 worker 任务助手建议已被用户明确的 Slack 式多 Agent 工作台方向替代。

**用户后续确认**：独立 TUI 应用，不是 `/team` 扩展；每群保留专属助手，无 `@` 时由它响应，明确 `@` 时定向投递。助手自动命名派工，审批可配置；人能继续与助手交谈或向 worker 追加指令。归档复用公开成果，创建/运行时遵循适用 AGENTS.md。

**研究与实现验证分开**：初次研究未运行原型测试，也未验证完整 Pi 工作台；后续已完成的本地 SDK 模拟、恢复与终端冒烟见 [README 验证记录](../README.md#验证)。真实线上模型、实机输入法、负载与成本仍未验证。GitHub/IM、无人值守常驻不属于当前首版，未进行完整安全审计。

## 参考证据

### DeepSeek 原型（固定提交，避免后续变更影响结论）

- [D1 README](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/README.md)
- [D2 理念](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/docs/000-philosophy.md)
- [D3 领域模型](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/docs/001-domain.md)
- [D4 授权](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/docs/002-authorization.md)
- [D5 执行与安全限制](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/docs/003-execution.md)
- [D6 提示词与角色](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/docs/004-prompts.md)
- [D7 架构](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/docs/007-architecture.md)
- [D8 Engine](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/src/core/engine.ts) / [ports](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/src/core/ports.ts)
- [D9 Store](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/src/app/store.ts) / [Effects](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/src/app/effects.ts)
- [D10 GitHub 回复去重](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/src/sources/github-channel.ts)
- [D11 包契约](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/package.json) / [插件入口](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/src/index.ts)
- [D12 部署/API](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/docs/006-deployment.md) / [HTTP 检查](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/src/app/http.ts)

### 本机已安装版本的文档

- P1：`/Users/didi/.pi/agent/install/releases/1.5.0/node_modules/@earendil-works/pi-coding-agent/docs/sdk.md`；`examples/sdk/12-full-control.ts`、`examples/sdk/14-codemode-mcp.ts`（均位于同一安装包下）。
- P2：`/Users/didi/.pi/agent/install/releases/1.5.0/node_modules/@earendil-works/pi-coding-agent/docs/cli-integration.md`。
- P3：`/Users/didi/.pi/agent/install/releases/1.5.0/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md`。
- P4：`/Users/didi/.pi/agent/npm/node_modules/pi-subagents/README.md`。
- P5：`/Users/didi/.pi/agent/npm/node_modules/pi-subagents/docs/extension-api.md`。
- P6：`/Users/didi/.pi/agent/npm/node_modules/pi-subagents/docs/missions.md`。
- P7：`/Users/didi/.pi/agent/npm/node_modules/pi-subagents/docs/workflows.md`。
- P8：`/Users/didi/.pi/agent/install/releases/1.5.0/node_modules/@earendil-works/pi-coding-agent/docs/tui.md`。
- P9：`/Users/didi/.pi/agent/install/releases/1.5.0/node_modules/@earendil-works/pi-coding-agent/examples/sdk/11-sessions.ts`。
- P10：`/Users/didi/.pi/agent/install/releases/1.5.0/node_modules/@earendil-works/pi-tui/dist/index.d.ts`；`/Users/didi/.pi/agent/install/releases/1.5.0/node_modules/@earendil-works/pi-coding-agent/dist/index.d.ts`（公开布局、会话和消息渲染组件导出）。

[D1]: https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/README.md
[D2]: https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/docs/000-philosophy.md
[D3]: https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/docs/001-domain.md
[D4]: https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/docs/002-authorization.md
[D5]: https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/docs/003-execution.md
[D6]: https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/docs/004-prompts.md
[D7]: https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/docs/007-architecture.md
[D8]: https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/src/core/engine.ts
[D9]: https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/src/app/store.ts
[D10]: https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/src/sources/github-channel.ts
[D11]: https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/package.json
[D12]: https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/docs/006-deployment.md
[P1]: /Users/didi/.pi/agent/install/releases/1.5.0/node_modules/@earendil-works/pi-coding-agent/docs/sdk.md
[P2]: /Users/didi/.pi/agent/install/releases/1.5.0/node_modules/@earendil-works/pi-coding-agent/docs/cli-integration.md
[P3]: /Users/didi/.pi/agent/install/releases/1.5.0/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md
[P4]: /Users/didi/.pi/agent/npm/node_modules/pi-subagents/README.md
[P5]: /Users/didi/.pi/agent/npm/node_modules/pi-subagents/docs/extension-api.md
[P6]: /Users/didi/.pi/agent/npm/node_modules/pi-subagents/docs/missions.md
[P7]: /Users/didi/.pi/agent/npm/node_modules/pi-subagents/docs/workflows.md
