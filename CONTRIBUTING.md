# 贡献指南

感谢你愿意改进 `dsh-whyai`。本项目优先接受范围明确、可以验证、不会扩大数据外发面的改动。

公开目标：[GitHub 仓库](https://github.com/henry-y-c/dsh-whyai) · [npm 包](https://www.npmjs.com/package/dsh-whyai)。当前发布状态见 [README](README.md)；仓库创建后，可通过 [Issues](https://github.com/henry-y-c/dsh-whyai/issues) 提交非敏感建议。

## 开始之前

- 阅读 [README](README.md) 的安全与数据边界。
- 遵守 [社区行为准则](CODE_OF_CONDUCT.md)。
- 安全漏洞不要提交公开 Issue，按 [安全策略](SECURITY.md) 私下报告。
- 功能建议应说明实际场景、数据是否外发、是否可能计费，以及为什么现有四个工具无法满足。

## 本地环境

需要 Node.js `^22.19 || >=24`。安装依赖时使用仓库内缓存，避免依赖用户目录的 npm 缓存权限：

```sh
npm ci --cache .npm-cache
```

日常检查：

```sh
npm run verify
```

准备合并或发布的改动还应运行：

```sh
npm run verify:release
```

发布检查只调用 fixture CLI，不访问真实 WhyAI 后端，也不会消耗真实额度。

## 架构约束

- Web 额度读取走认证只读路由，安装/登录/退出走确认后的认证管理路由；浏览器只使用官方插槽、主题变量与 locale，不注入宿主 DOM。
- 不运行期导入 Cordis 或 `@deepseek-ai/dsh-*`；DSH 能力从 `ctx` 获取。
- 不增加任意 CLI 透传、自动文件读取、文件上传或未经明确授权的数据外发。
- 咨询正文必须走 stdin，不能放入 argv、日志或测试快照。
- create/send 的可选 approval 必须由 `requireApproval` 控制，默认不注册；启用时 waterfall listener 必须先调用 `next()`，只能把既有 `allow` 升级为 `ask`。
- 外部 stderr、响应体、推理内容和工具执行细节不能进入模型可见结果。
- 每个进程只有一个所有者；取消、超时和卸载必须有界等待 managed process range 静默。无法确认静默时 fail-closed，保留所有权且禁止后续 spawn，不能无限等待或假报成功。
- 新增输入、输出或配置字段时，同时更新 schema、运行时校验、README 和测试。

## 提交与分支

提交信息采用 Conventional Commits：

```text
feat(tools): 增加只读会话查询
fix(runner): 修复取消后的进程回收
docs: 完善安装说明
```

允许的 type：`feat`、`fix`、`docs`、`test`、`refactor`、`perf`、`build`、`ci`、`chore`、`revert`。破坏性变更使用 `!` 或提交正文中的 `BREAKING CHANGE:`。

请不要重写他人的共享历史，不要提交凭据、真实会话、真实用户名、Token、Cookie 或包含私密正文的日志。

## Pull Request 要求

PR 应包含：

1. 问题与使用场景；
2. 方案和安全影响；
3. 实际执行过的验证命令；
4. 未验证部分与剩余风险；
5. 对 README、变更记录和测试的同步更新。

源码提交、版本 tag、npm 发布、profile 安装、服务重启和运行验收是不同状态。PR 合并不会自动代表后续状态已经完成。
