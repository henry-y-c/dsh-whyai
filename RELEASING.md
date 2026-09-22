# 版本与发布流程

本文件供维护者使用。Git 提交、版本 tag、npm 发布、DSH 安装、服务重启和运行验收必须分别记录，不能互相推定。

## 发布前提

下一版本号尚未确定；功能开发与 PR 合并不构成发版授权。未经用户明确授权，不升级版本、不创建 tag、不发布 npm 或 GitHub Release。当前已发布版本与验收边界见 [README](README.md)。已确认目标：

- GitHub：[henry-y-c/dsh-whyai](https://github.com/henry-y-c/dsh-whyai)；
- npm：[dsh-whyai](https://www.npmjs.com/package/dsh-whyai)，发布账号 `henry-y-c`；
- 作者：花辣子米；`repository`、`homepage`、`bugs` 均指向上述 GitHub 项目。

每次获准发布后仍须核对：

- 仓库状态与待推送内容、npm 包名可用性和账号发布权限；目标确认不构成包名占位；
- [安全策略](SECURITY.md) 中的私密报告渠道是否可用，不把未启用的入口写成可用；
- 受支持 Node.js 版本上的验证结果，以及 CI 是否实际运行；
- 目标 DSH 与 WhyAI CLI 的兼容范围、修复版尚未完成的真人验收（见 [README](README.md)）。

## 版本规则

项目采用语义化版本：

- 新增兼容功能：minor；
- 兼容修复：patch；
- 稳定版破坏性变更：major；
- `0.x` 阶段的不兼容变更：提升 minor，并在变更记录中明确迁移影响。

文档、测试或治理改动先记入“未发布”，不为制造版本号而单独发版。

## 发布检查

1. 确认工作区只包含本次发布内容。
2. 扫描凭据、真实会话、日志和机器专属路径。
3. 按用户授权确定目标版本，再同步更新 `package.json` 与 `package-lock.json`；PR 修复阶段保持已有版本，变更记录留在“未发布”。
4. 在 `CHANGELOG.md` 记录目标版本的变更；仅在实际发布时记录真实日期与结果，不提前宣称已发布。
5. 运行：

```sh
npm ci --cache .npm-cache
npm run verify:release
npm pack --dry-run --json --cache .npm-cache
```

6. 从最终 tarball 检查入口、类型声明、README、LICENSE 和变更记录。
7. 审查 staged diff，并执行 `git diff --cached --check`。
8. 使用真实 Git 身份创建 Conventional Commit；未经授权不得提交或推送。
9. 在获授权后创建 annotated tag：`vX.Y.Z`。
10. 确认 tag 指向的源码与待发布 tarball 完全一致。
11. 在获授权后发布审查过的最终 tarball。`publishConfig.provenance` 默认开启，但 provenance 需要支持的 CI/OIDC 环境；本地发布不能伪造证明。

```sh
# 支持 provenance 的 CI/OIDC 环境
npm publish ./dsh-whyai-0.3.1.tgz --access public --provenance

# 本地发布：明确关闭，并在发布记录中说明“无 provenance”
npm publish ./dsh-whyai-0.3.1.tgz --access public --provenance=false
```

不要把本地发布记作带 provenance 的发布。发布 tarball 时不要假定 `prepublishOnly` 会替你重跑检查，必须先完成以上源码与 tarball 验证。

12. 从 npm registry 安装刚发布的明确版本，核对 registry 的版本、完整性与 provenance 状态，并重新执行最小导入与组合验收。

## 发布后验证

分别记录：

- 源码是否已提交；
- tag 是否已创建并推送；
- npm 包是否已发布；
- tarball 是否能从 registry 安装；
- 插件是否已安装进目标 DSH profile；
- 服务是否已重启；
- 真实运行行为是否已验证。

真实 WhyAI 咨询可能消耗额度，必须单独取得授权；默认发布检查只使用 fixture CLI。
