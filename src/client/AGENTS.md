# Web 客户端约定

继承插件根目录 `AGENTS.md`。`index.ts` 只导出 Cordis 加载入口；组件不接收 ctx，动态数据通过插槽 inject 的 `hooks.access` 提供。

- 文案统一放 `locales.ts`；样式消费宿主主题变量。默认用官方 `sidebar.footer.action`；`sidebar.footer.usage-monitor.after` 存在时迁入该可选子槽，消失时安全恢复，不能形成跨插件运行时 import。窄栏用原生 popover。
- `store.ts` 通过插槽注入 `actions` 与 `hooks.access`，禁止静态单例或组件内异步状态。所有请求、body reader、轮询和 visibility 监听均随订阅生命周期取消，迟到结果不得回灌；隐藏与最后退订清身份数据。停止观察不等于取消 Host 操作，重新订阅先 GET operation 恢复；仅服务端终态代表完成取消。
- 安装、登录、退出均先显示本机确认，再 POST `?confirm=host`；操作前后清身份缓存。普通 access 轮询不传 fresh，同身份传输失败保留数据并标记过期，认证失败清空。请求/body 15 秒、16 KiB；操作观察最多 180 次，暂停后可显式恢复。行为验证：`node --test tests/client.test.mjs`（真实按钮回调、重复点击、取消、隐藏、重挂载与迟到响应）。
- 订阅到期、重置与 CLI 有效期的来源及去重规则由根 `AGENTS.md` 与 `tests/client.test.mjs` 守护；不凭日期推算业务含义。
- 本地 React 声明只覆盖本插件使用的类型，不能证明宿主兼容；发布须跑真实组合与 tarball 消费检查，真实视觉另行验收。
