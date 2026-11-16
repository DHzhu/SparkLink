# 更新日志

所有对本项目的显著变更都将记录在此文件中。

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 规范。

## [未发布]

### 新增
- 完成项目标准化与 Conductor 管理结构初始化（基于 `spec.md` v1.2.0）。
- 完成 P0 兼容性验证与适配契约层：构建脱敏网络/DOM 测试样本集（`tests/fixtures/`），实现 X GraphQL 白名单适配器与有界待解析队列（`src/x-adapter.js`）、MAIN 世界只读流式网络封装（`src/interceptor.js`）以及 ISOLATED 世界消息桥接与批次确认状态机（`src/bridge.js`）。
- 完成 P1 本地 MVP 核心实现与第 13 节端到端验收：
  - 新增 Manifest V3 配置清单（`manifest.json`）、本地状态 v1→v2 迁移及便携备份白名单校验（`src/schema.js`）、30 天连续滚动窗口统计与 Top 20 稳定排序（`src/metrics.js`）。
  - 实现单写者串行存储控制器、过期记录与孤立用户清理、7 MiB 预警 / 8 MiB 容量回滚以及两阶段 JSON 备份导入合并（`src/storage.js`）。
  - 实现 Service Worker 信任上下文配置、Popup 与顶层 X 页面权限分离及 `storage.session` 跨重启会话绑定恢复（`src/background.js`）。
  - 实现 DOM 星火徽章分级渲染（SVG 火苗、认证图标后置布局、`MutationObserver` 合并与 `requestAnimationFrame` 分片、虚拟列表节点复用清理及 60 秒过期窗口自动刷新，`src/content.js`、`src/styles.css`）。
  - 实现浅色/深色自适应 Popup 管理界面（`src/popup/`）并通过全部 34 项单元与端到端验收测试（整体行覆盖率 88.13%）。
- 补齐 4 个尺寸确定性品牌 PNG 图标（`icons/icon16.png`、`icons/icon32.png`、`icons/icon48.png`、`icons/icon128.png`），并接入真实 Chromium 155 未打包扩展加载与 CDP 真实 DOM / 原生 `Request` 回归验收（`tests/remediation.test.js`，全量 48 项测试通过，整体行覆盖率 89.01%）。

### 变更
- 备份导出切换为紧凑 JSON 序列化并引入 `O(1)` 用户 Handle 索引（`src/popup/popup.js`、`src/storage.js`），确保满载 20,000 条回复（约 5.92 MiB）导出的备份体积低于 9 MiB 导入上限且可快速往返恢复。

### 修复
- **[P0]** 修复 `icons/` 目录缺失导致 Chromium 拒绝加载未打包扩展的问题（`icons/icon*.png`）。
- **[P1]** 修复暂停采集期间同页切换账号并恢复后，MAIN 世界沿用上一会话 `latestGraphqlViewer` 缓存导致误绑旧账号、漏记新账号回复的问题（`src/interceptor.js`）。
- **[P1]** 修复 20,000 条回复状态下美化缩进导出超出 9 MiB 导入器体积上限而无法自恢复的问题（`src/popup/popup.js`、`src/storage.js`）。
- **[P2]** 修复后台已绑定标签页掩盖当前前台未确认或非 X 标签页状态的问题，改为通过 `chrome.tabs.query` 结合顶层存活探测仅反映当前活动前台标签页（`src/background.js`、`src/bridge.js`）。
- **[P2]** 修复 `src/content.js` 对真实浏览器 `HTMLCollection` 调用 `Array.isArray` 导致跳过可见 `@handle` 文本交叉校验与无链接作者识别的问题。
- **[P2]** 修复已识别回复请求（`CreateTweet`）与本人回复时间线（`UserTweetsAndReplies`）返回非错误 HTTP 200 未知结构时静默显示正常采集的问题，分离提示“实时采集异常”与“历史补录受限”（`src/x-adapter.js`、`src/interceptor.js`、`src/bridge.js`、`src/background.js`、`src/popup/popup.js`）。
- **[P2]** 修复 `storage.local` / `storage.session` 的 `setAccessLevel('TRUSTED_CONTEXTS')` 调用失败被忽略后仍允许开启采集的问题，改为强门禁拦截并保留可重试恢复能力（`src/background.js`）。
- **[P1]** 修复暂停采集期间同页 SPA 切号而页面首次加载的静态快照（`window.__INITIAL_STATE__` / 内联脚本）未更新时，恢复采集仍回退误绑旧账号导致新账号首条回复漏记的问题；旧快照未更新时保持“账号待确认”直至收到新鲜身份证据（`src/interceptor.js`）。
- **[P2]** 修复 `fetch(new Request(url, init))` 调用形式下未读取 `Request` 自身正文导致回复响应结构漂移静默显示“采集中”的问题，改为在既有 64 KiB 与 2s 超时限制内读取未消费 `Request` 副本并统一上报“实时采集异常”（`src/interceptor.js`）。
- **[P2]** 修复本人回复时间线（`UserTweetsAndReplies`）中保留显式 `TimelineTweet` 类型但重命名 `tweet_results` 字段时未标记部分无法识别的问题，确保继续合并同页有效回复的同时提示“历史补录受限”（`src/x-adapter.js`）。
- **[P2]** 修复作者容器根节点直接挂载 `Text` 文本节点时 `src/content.js` 从 `container.children` 开始遍历遗漏直接文本 `@handle` 的问题，拦截链接冲突误挂并补齐纯直接文本作者徽章渲染。

### 移除
- (在此记录已移除的功能)
