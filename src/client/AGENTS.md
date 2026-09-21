# Web 客户端约定

继承插件根目录 `AGENTS.md`。`index.ts` 只导出 Cordis 加载入口；组件不接收 ctx，动态数据通过插槽 inject 的 `hooks.access` 提供。

- 文案统一放 `locales.ts`；样式消费宿主主题变量。默认用官方 `sidebar.footer.action`；`sidebar.footer.usage-monitor.after` 存在时迁入该可选子槽，消失时安全恢复，不能形成跨插件运行时 import。窄栏用原生 popover。
- `store.ts` 所有请求、body reader、轮询和 visibility 监听均随订阅生命周期取消，迟到结果不得回灌；不要保存旧身份结果。
- 订阅到期、重置与 CLI 有效期的来源及去重规则由根 `AGENTS.md` 与 `tests/client.test.mjs` 守护；不凭日期推算业务含义。
- 本地 React 声明只覆盖本插件使用的类型，不能证明宿主兼容；发布须跑真实组合与 tarball 消费检查，真实视觉另行验收。
