# 变更记录

本文件记录项目中面向使用者和维护者的重要变化。版本采用语义化版本规则；待发布条目不代表 GitHub Release 或 npm 发布，不补造历史版本或发布日期。

公开目标：[GitHub · henry-y-c/dsh-whyai](https://github.com/henry-y-c/dsh-whyai) · [npm · dsh-whyai](https://www.npmjs.com/package/dsh-whyai)。当前发布与真人验收状态见 [README](README.md)。

## 0.3.1

### 修复

- 为 runner 的进程静默观察和 shutdown 设置有界等待；回收失败时 fail-closed，保留进程所有权并拒绝后续启动，不把失败回收报告为成功。
- 插件卸载后拒绝新调用并返回 `WHYAI_DISPOSED`；取消传播覆盖可执行文件解析与运行阶段，避免取消后启动迟到任务。
- 对底层解析、启动及运行异常进行脱敏，仅返回插件拥有的稳定错误码和泛化文案。

### 验证

- 扩展真实 DSH Loader、ToolRuntime 与 subprocess 的 fixture 组合回归，覆盖默认 `requireApproval: false` 下 create → send → repeat send，以及显式 `true` 下的批准拒绝。
- 组合测试必须等待工具和 Web 两部分完成；POSIX 测试进程组有界回收，未确认回收时拒绝成功并保留临时目录。
- fixture 组合不访问真实 YAI 后端；另外经授权完成真实创建、发送及安装后的重复发送。安装与运行态证据边界详见 README。此前真实取消的原始原因仍未确定。

### 发布准备

- 同步 manifest 与 lockfile 为 0.3.1，配置已确认的 GitHub 目标元数据和 npm 包链接；作者保持花辣子米。
- 统一中文文档，移除机器专属安装历史，并区分源码、发布、安装与真实验收状态。

### 首次公开包含的已有功能

以下是已有开发内容的汇总，不代表曾经发布的历史版本。

- 提供 `yai_status`、`yai_partners`、`yai_conversation_create` 和 `yai_message_send` 四个受限工具。
- 提供中文 YAI 侧栏额度摘要，以及 `dsh-usage-monitor` 可选子插槽和独立回退。
- Web 只读路由经宿主认证，仅投影 access 与 summary 的必要字段；共享串行 CLI、缓存、并发合并和取消期限。
- `requireApproval` 默认 `false`，不额外要求插件级逐次确认，仍服从 DSH 上游权限；显式 `true` 仅把已有 `allow` 升级为 `ask`。
- 咨询正文只经 stdin，限制输入输出、时间与进程生命周期，严格校验 JSON 协议并剔除原始诊断及推理内容。
- 提供模拟 CLI 单元测试、临时 `DSH_HOME` 真实组合测试及 npm tarball 双入口和 NodeNext 类型消费检查。
