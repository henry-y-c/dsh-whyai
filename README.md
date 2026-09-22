# dsh-whyai

> **让 DSH Agent 找到合适的 YAI Partner，把专业方法接进正在做的事。**
>
> 能力来自 YAI，边界留在 `dsh-whyai`：四个受限工具，把 Partner 搜索、会话创建和消息发送纳入可批准、可取消、可审计的 DSH 调用链。

`dsh-whyai` 是一个第三方、非官方、同时提供 Host 工具与中文 Web 侧栏的 DeepSeek Harness 插件。当前版本为 **0.4.0**。

[GitHub · henry-y-c/dsh-whyai](https://github.com/henry-y-c/dsh-whyai) · [npm · dsh-whyai](https://www.npmjs.com/package/dsh-whyai)。可用版本以 npm registry 和 GitHub Releases 实际记录为准。

作者：**花辣子米**

## 为什么是 YAI × DSH

当你正在 DSH 中拆需求、复盘项目、打磨表达或评估方案时，Agent 可以组织任务、调用工具，却未必自带眼前问题所需的方法和专业上下文。YAI 的 Partner 围绕具体方法和任务设计；一堂的发布会文档把它比作分工明确的 AI 专家，并强调“每一个 Partner 只解决一个方向的问题”，而不是追求大而全。

一堂 CLI 把 YAI 能力开放给能够执行命令的 Agent。`dsh-whyai` 不试图把整套 CLI 或整套一堂系统交给 Agent，而只选择 Partner 协作所需的最小路径：

1. 根据当前问题搜索官方 Partner；
2. 创建一个可持续对话的远端会话；
3. 按部署权限策略发送明确文本；需要逐次确认时可开启插件 approval；
4. 把 Partner 的回答带回 DSH，继续本地任务。

这意味着：

- **找到更匹配的方法**：先看 Partner 的名称、简介和稳定 UUID，再决定请谁参与，而不是让 Agent 猜一个角色。
- **不把整个 CLI 交出去**：插件没有任意命令入口，也不会自动读取仓库、附件或完整 DSH 会话。
- **外发策略可控**：创建会话和发送消息默认不增加插件级确认，以减少重复点击；需要逐次点头时设置 `requireApproval: true`。无论是否启用确认，取消只会终止本地 CLI，不能承诺云端生成或计费立即停止。

这正是本项目的取舍：**能力可以继续扩展，权限必须先收窄。** YAI 提供 Partner 和专业能力，`dsh-whyai` 负责把调用边界做得可见。

进一步了解 YAI 与一堂 CLI：

- [一堂 CLI 安装页](https://ai.yitang.top/cli)
- [一堂 CLI 使用指南](https://yitanger.feishu.cn/wiki/XoFcwMmotigm7Ikv4RQc9TfQn0g)
- [YAI 使用指南](https://yitanger.feishu.cn/wiki/WPJWwKwI3iUCzqkGUzvc6i5MnNg)

> 使用 WhyAI CLI 需要有效的一堂 YAI 思考版或以上套餐，并会消耗套餐额度。订阅条件、权益和价格以一堂官方页面的最新说明为准。

## 功能

| 工具 | 用途 | 远端写入与批准 |
|---|---|---|
| `yai_status` | 检查 CLI 版本、登录状态与订阅访问状态 | 无远端写入，无需批准 |
| `yai_partners` | 搜索官方 Partner，并返回稳定 UUID | 无远端写入；查询词由 CLI 在本地过滤 |
| `yai_conversation_create` | 创建 Partner 会话 | 有远端写入；默认不增加插件级确认，可配置开启 |
| `yai_message_send` | 向已有会话发送明确文本 | 会外发数据并可能消耗额度；默认不增加插件级确认，可配置开启 |

新咨询刻意拆成“创建会话”和“发送消息”两步。这样在耗时且可取消的生成开始之前，远端 `conversation_id` 已经进入 DSH 会话记录，后续更容易查询和恢复。

## 主界面额度摘要

中文 YAI 摘要位于侧栏工作区下方、设置入口上方，无需打开设置页。宽栏展示剩余额度进度、CLI 访问资格、当前订阅到期与额度重置时间；窄栏点击 YAI 按钮打开原生顶层浮层，避免被侧栏裁剪。组件使用宿主主题变量与官方插槽，不注入或替换宿主 DOM。

卡片底部提供了『安装』与『登录』快捷操作：
- **安装**：在未安装 WhyAI CLI 时提供一键安装，通过受管子进程安全拉取并执行官方安装器，安装后自动适配标准安装路径（macOS/Linux: `~/.local/bin/whyai`，Windows: `%LOCALAPPDATA%\WhyAI\bin`），无须改写全局环境 PATH。
- **登录**：受管拉起 `whyai login --gateway https://ai.yitang.top` 进行账号授权登录，登录完成后二次校验登录状态，并自动刷新展示最新配额。
- **后台平滑刷新**：后台轮询在内存中保持平滑过渡，无白屏或骨架屏闪烁；移除持久化 `localStorage`，采用内存状态代次与严格请求取消机制，确保账号切换时无旧数据回灌。
- **退出授权**：数据卡片右下角提供『退出』按钮，点击后调用官方 `whyai logout` 注销会话并清理凭据，平滑恢复至未登录状态。

若同时安装 `dsh-usage-monitor` 0.4.0 或更高版本，YAI 会自动迁入它声明的 `sidebar.footer.usage-monitor.after` 可选子插槽，使两个完整卡片在宽栏上下排列、在窄栏纵向排列两个入口；该子插槽消失时会恢复到官方 `sidebar.footer.action`，因此两个插件没有运行时依赖、加载顺序要求或单独安装限制。

| CLI 字段 | 展示含义 |
|---|---|
| `available_percent` | 可用额度百分比；缺值显示未知，不当作零 |
| `eligible` | CLI 访问资格，不等同于是否已登录 |
| `valid_until` | `billing access` 返回的访问有效期，保留原字段，不推算重置 |
| `subscription_expires_at` | 从 `billing summary.plan_expires_at` 投影；仅 `plan_source=subscription` 时标记为订阅到期 |
| `next_reset_at` | 从 `billing summary.next_reset_at` 投影；缺值显示“暂未提供” |

**不根据到期时间推算额度重置。** `valid_until` 与订阅到期分别保留，即使值不同也不静默合并。已核对 WhyAI CLI 0.5.7 的只读账单结构；`subscriptions.ends_at` 和 `grants.expires_at` 不是下次重置时间，因此不增加这两次重复查询。

浏览器仅请求同源 `GET /api/whyai/access`；Host 先执行 DSH 会话与 Origin 校验，再按顺序运行只读 `whyai --json billing access` 与 `whyai --json billing summary`。成功响应只含上述五字段与 `billing_status` 读取状态，不传账号、订单、套餐原始响应或诊断。账单 summary 失败不抹掉独立 access 事实，而是清空两个账单日期并标注“账单日期暂不可用”；access 自身失败则清空整份旧结果。Host 对成功与失败缓存 30 秒、并发请求合并；总调用开始 10 秒后触发取消（含等待工具串行锁的时间），随后在有界 shutdown 期限内等待 CLI 静默；若无法确认静默则失败关闭（fail-closed），保留进程所有权并拒绝继续启动 CLI，不把回收失败当作成功。无 Web 服务的组合仍可使用四个工具。浏览器每 60 秒刷新，多个订阅者共用请求；隐藏页暂停并清旧值，恢复可见立即刷新，最后退订或插件卸载取消请求。浏览器完整响应限 16 KiB、请求和 body 总时限 15 秒。

## 安全与数据边界

- 插件不会自动读取仓库文件、附件、DSH 完整对话或 WhyAI 凭据。
- 标题和咨询正文通过 stdin 传给 CLI，不进入进程 argv。
- 不提供文件上传、Web 搜索、重新生成、Partner 修改或任意 CLI 命令透传。
- 工具结果不会暴露 `reasoning_content`、原始 `tool_executions`、stderr 或服务端原始响应体。
- 外部错误只映射为插件拥有的稳定错误码和泛化文案。
- Partner 和 conversation 必须使用 UUID；CLI 返回的身份必须与请求匹配。
- CLI 调用在单个插件实例内全局串行，并限制正文、stdout、stderr、运行时间和终止宽限期；shutdown 失败时 fail-closed，卸载后调用返回 `WHYAI_DISPOSED`。
- WhyAI 输出属于外部建议，不等于已经核实的事实。
- 取消会停止本地 CLI 进程，但不能证明云端生成或计费立即停止。

## 运行要求

- Node.js `^22.19 || >=24`
- DeepSeek Harness `0.1.5-rc.2`
- WhyAI CLI `0.5.7`（已核对协议，修复版真人验收边界见下文）
- 已登录且具备 CLI 访问资格的 WhyAI 账号

WhyAI CLI 会在业务命令前检查更新，因此后续版本仍需重新执行协议回归测试。插件会严格校验响应字段，但无法仅凭结构校验证明新版本语义完全兼容。

## 配置

默认配置如下：

```yaml
- id: whyai
  name: dsh-whyai
  config:
    cliPath: whyai
    timeoutMs: 180000
    graceMs: 2000
    stdoutMaxBytes: 4194304
    stderrMaxBytes: 262144
    promptMaxBytes: 131072
    partnerLimit: 10
    requireApproval: false
```

| 字段 | 含义 |
|---|---|
| `cliPath` | WhyAI CLI 的绝对路径或不含路径分隔符的可执行文件名 |
| `timeoutMs` | 单次 CLI 命令总时限 |
| `graceMs` | 终止子进程时从 TERM 升级到强制终止的宽限期 |
| `stdoutMaxBytes` | stdout 内存收集上限；超限即协议失败 |
| `stderrMaxBytes` | stderr 内存收集上限 |
| `promptMaxBytes` | 单条咨询正文的 UTF-8 字节上限 |
| `partnerLimit` | Partner 搜索默认返回数量 |
| `requireApproval` | 是否由本插件额外要求批准创建会话和发送消息；默认关闭。关闭不会绕过 DSH 上游权限策略 |

默认关闭意味着：当 DSH 上游策略已经判定为允许时，Agent 可以直接创建远端会话和发送明确文本，后者可能消耗 YAI 额度。插件仍不提供任意 CLI 透传、自动文件读取或附件上传。需要每次确认外发时，将 `requireApproval` 设为 `true`；该模式仍先遵循上游 waterfall 决策，只把既有 `allow` 升级为 `ask`，不会覆盖 `deny`。

WhyAI CLI 的用户级安装通常位于 `~/.local/bin/whyai`。该路径不属于可移植默认值；若 DSH 服务的 PATH 不包含 `~/.local/bin`，应在自己的 profile 行中配置实际绝对路径。

## 安装

### 从源码安装

先构建，再使用 `file:` 安装。不能使用裸路径，因为裸路径会形成 `link:`，可能使插件无法解析 DSH 的共享依赖。

```sh
npm ci --cache .npm-cache
npm run verify:release
dsh plugin --profile web add file:/absolute/path/to/dsh-whyai
```

### 从 npm 安装

从 [npm 版本列表](https://www.npmjs.com/package/dsh-whyai?activeTab=versions) 确认可用版本后，使用明确版本安装：

```sh
dsh plugin --profile web add dsh-whyai@0.4.0
```

安装、重启和运行验收是三个独立步骤。把 bundle 加入正式 profile 后需要重启对应 DSH 服务；不要在承载当前会话的进程内直接重启。

## 开发与验证

```sh
npm ci --cache .npm-cache
npm run verify
npm run verify:release
```

- `npm run verify`：清理构建、类型检查和模拟 CLI 单元测试。
- `npm run test:composition`：使用临时 `DSH_HOME`、真实 Loader、ToolRuntime 和 subprocess 运行 fixture CLI，不访问真实 WhyAI 后端。测试进程使用 POSIX 进程组有界回收，需 macOS/Linux 及向自有进程组发信号的权限；Windows 暂不支持此组合测试。
- `npm run pack:smoke`：构建 npm tarball，验证运行时导入和 NodeNext 类型消费。
- `npm run verify:release`：依次运行以上发布前检查。

本包包含 Host ESM 与 Client lazy-CJS 两种产物；浏览器只从宿主共享 React，不打包第二份宿主框架。接口使用本地结构类型，必须与真实组合测试一起核对，不能仅凭类型检查推定兼容。

验证基线：DSH `0.1.5-rc.2`，上游提交 `fb2c4b9e698e30edb738bca4cf0618587db7d203`。真实 DSH 组合使用 fixture CLI，已验证省略 `requireApproval`（默认 `false`）时的 create → send → repeat send，以及显式 `true` 时的批准拒绝；这不等于调用了真实 YAI 后端。隔离组合还覆盖认证拒绝、Origin 拒绝、方法限制、缓存并发和客户端资源；客户端回归覆盖插槽加载顺序、声明重建、独立回退与卸载。

发布审查中，经授权的真实 YAI 创建、发送和咖啡店评估已成功；安装 0.3.1 并核对 Host 产物一致后，既有会话重复发送也成功。未重启当前服务，因此该次真实调用不单独证明内存中已切换到修复版；修复版的确定性证据来自隔离 DSH 组合与单元测试。此前取消/命令失败未再复现，原始原因尚未确定，不宣称已定位。真实咨询须单独授权，计费和 UI 验收不由 fixture 测试替代。

## 文档与社区

- [贡献指南](CONTRIBUTING.md)
- [安全策略](SECURITY.md)
- [社区行为准则](CODE_OF_CONDUCT.md)
- [版本与发布流程](RELEASING.md)
- [变更记录](CHANGELOG.md)

## 许可证

项目使用 [MIT License](LICENSE)。`LICENSE` 保留 MIT 官方英文法律文本，其余项目文档以中文维护。
