# dsh-whyai 项目约定

本插件是 DSH 0.1.5-rc.2 的 Host 工具与 Web 侧栏 WhyAI CLI 适配器。版本与验收状态以 `package.json`、[CHANGELOG](CHANGELOG.md) 和 [README](README.md) 为准，不把机器专属安装记录写入公开文档。

公开目标：[GitHub · henry-y-c/dsh-whyai](https://github.com/henry-y-c/dsh-whyai) 与 [npm · dsh-whyai](https://www.npmjs.com/package/dsh-whyai)；作者为花辣子米。目标已确认不代表已创建仓库或已发布包。

## 不可破坏的边界

- 只暴露 `yai_status`、`yai_partners`、`yai_conversation_create`、`yai_message_send`，不得增加任意 CLI 透传。
- 咨询正文只走 stdin；Partner 与 conversation 只接受 UUID。不得自动读取或上传工作区文件、附件、完整会话或凭据。
- `reasoning_content`、原始 `tool_executions`、stderr 和服务端原始 body 不进入工具结果。
- create/send 是远端写入或潜在计费操作；`requireApproval` 默认 `false`，不增加插件级确认且不覆盖上游权限策略。显式设为 `true` 时才注册 approval listener；listener 必须先 `await next()`，仅在既有决策为 allow 时升级为 ask。
- CLI 调用全局串行，stdout/stderr/正文/时间均有上限。取消、超时和 disposal 传播到 `ctx.subprocess`，静默观察与 shutdown 必须有界；回收失败要 fail-closed，保留进程所有权并拒绝后续 spawn，不能宣称已静默。卸载后的调用返回 `WHYAI_DISPOSED`；外部异常脱敏，不透传底层错误。
- 生产代码不运行期导入 Cordis 或 `@deepseek-ai/dsh-*`；所需结构类型集中在 `src/dsh-types.ts`，运行能力从 `ctx` 获取。

## 文档与发布治理

- **严禁在未经用户明确直接指令的情况下执行 npm 发布、创建版本 tag 或发布 GitHub Release**。日常迭代、功能开发、Bug 修复与 PR 审查仅停留在本地分支与测试验证阶段；未收到用户的明确“发布”指令前，绝对不要发布新版本。
- 项目面向 GitHub 开源和 npm 公开发布；README、贡献指南、安全策略、行为准则、发布流程、变更记录和 GitHub 模板均使用中文维护。
- `LICENSE` 保留 MIT 官方英文法律文本；协议字段、命令名和模型接口中的英文不为形式上的中文化而改写。
- 不伪造仓库 URL、作者、联系方式、发布日期或发布状态。提交、tag、npm 发布、profile 安装、服务重启和运行验收分别记录。
- 发布包必须通过 `npm run verify:release`，并从最终 tarball 验证运行入口与 NodeNext 类型消费。

## 同步点

- 包名 `dsh-whyai`：`package.json`、`cordis.patch.yml` 的 `name`。
- loader id / 函数插件名 `whyai`：`cordis.patch.yml` 的 `id`、`src/index.ts` 的 `name`。
- 工具名：只在 `src/tools.ts` 的 `TOOL_NAMES` 定义；approval gate 从该常量读取。
- DSH 升级后核对 tools、subprocess、approval、webServer/connection、客户端 ModuleLoader、locale、sidebar.footer.action 与 async disposer 契约，再构建。
- 上游核对基线：`0.1.5-rc.2` / `fb2c4b9e698e30edb738bca4cf0618587db7d203`。主 UI 默认用 `sidebar.footer.action` list/root；若 `dsh-usage-monitor` 声明 `sidebar.footer.usage-monitor.after`，则自动迁入其 list/root 子槽，子槽消失后微任务恢复官方槽。两处 owner 都是 `wide: boolean`；窄栏用原生 top-layer popover，不注入 DOM。
- `GET /api/whyai/access` 先认证后工作；access投影 eligible/available_percent/valid_until，summary投影 subscription_expires_at/next_reset_at 与读取状态。与工具共用一个 runner；30 秒缓存、singleflight、10 秒取消期限（含排队），请求与卸载按上述有界回收契约等待 runner，失败不得冒充静默。
- 订阅到期只取 summary.plan_expires_at（subscription 来源），重置只取 summary.next_reset_at；valid_until 作为独立 CLI 权益有效期，不作订阅兜底，不从 grants.expires_at 推算重置。summary缺失或失败不能抹掉独立access事实，失败须标明账单日期暂不可用。

## 验证

```sh
npm run verify
npm run verify:release
```

真实组合使用一次性 `DSH_HOME`、`file:` 安装和 fixture CLI；默认测试不得调用真实 WhyAI 后端。组合测试进程组必须有界回收，确认组不存在且直接子进程关闭后才清理临时目录。Darwin 的 [killpg1](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/kern/kern_sig.c) 对没有可投递存活成员的组也可能返回 `EPERM`；只能视为未知并有界等待，不等同于空组或必然的沙箱拒绝，不再换信号重试；最终无法确认则失败。不得在当前 GUI 会话重启 `dsh-web`，不得未经授权安装进真实 profile。
