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
- 补齐 4 个尺寸确定性品牌 PNG 图标（`icons/icon16.png`、`icons/icon32.png`、`icons/icon48.png`、`icons/icon128.png`），并接入真实 Chromium 155 未打包扩展加载与 CDP 真实 DOM / 原生 `Request` 回归验收（`tests/remediation.test.js`，全量 61 项测试通过，整体行覆盖率 89.51%）。

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
- **[P2]** 修复 `fetch(new Request(url, init))` 调用形式下未读取 `Request` 自身正文导致回复响应结构漂移静默显示“采集中”的问题，改为在既有 256 KiB 与 2s 超时限制内读取未消费 `Request` 副本并统一上报“实时采集异常”（`src/interceptor.js`）。
- **[P2]** 修复本人回复时间线（`UserTweetsAndReplies`）中保留显式 `TimelineTweet` 类型但重命名 `tweet_results` 字段时未标记部分无法识别的问题，确保继续合并同页有效回复的同时提示“历史补录受限”（`src/x-adapter.js`）。
- **[P2]** 修复作者容器根节点直接挂载 `Text` 文本节点时 `src/content.js` 从 `container.children` 开始遍历遗漏直接文本 `@handle` 的问题，拦截链接冲突误挂并补齐纯直接文本作者徽章渲染。
- **[P1]** 修复同一标签页在暂停期间依次从 A 切到 B、再切回 A 且页面快照均已更新为目标账号时，因历史暂停账号集合未重置而停留在“账号待确认”、漏记 A 首条回复的问题；改为仅对比最近一次暂停前的账号快照，使明确更新的快照可立即重新绑定（`src/interceptor.js`）。
- **[P2]** 修复 `fetch(request, { body: null })` 误将 `requestMeta` 置空导致跳过父帖一致性校验、将冲突响应错计给另一作者的问题；遵循 WHATWG Fetch 规范沿用原 `Request` 的 256 KiB / 2s 有界副本读取与父帖比对（`src/interceptor.js`）。
- **[P2]** 修复点击暂停关闭采集开关后 `markWindowSnapshotStale` 仍读取 `window.__INITIAL_STATE__` 的问题；改为仅在开启采集期间缓存已见快照并在暂停时基于内存状态失效（暂停期间页面读取次数为 0，`src/interceptor.js`）。
- **[P1]** 修复 `Viewer` 已确认账号 B 而 `window.__INITIAL_STATE__` 仍保留旧账号 A 时，暂停期间页面对 `window.__INITIAL_STATE__` 做外层对象浅拷贝（账号字段未变）后恢复采集会重新绑定旧账号 A 的回归问题；移除对象引用判等，改为同时记录暂停前的动态状态账号与当前已激活账号，仅当账号字段真实变化或收到新的 `Viewer` 证据时才允许绑定（`src/interceptor.js`）。
- **[P1]** 修复页面在确认账号 B 后释放或清空全局 `window.__INITIAL_STATE__` 时，暂停再恢复采集会穿透回退读取首次加载 HTML 内联 `<script>` 中的旧账号 A 并将其误当新账号证据的回归问题；分离动态全局状态与静态初始内联脚本来源（`allowInlineScript`），一旦发生过暂停或观测到动态状态 / `Viewer` 身份证据即永久禁用内联脚本兜底，保持“账号待确认”（`src/x-adapter.js`、`src/interceptor.js`）。
- **[P1]** 修复采集处于关闭状态时打开标签页、页内从账号 A 切到 B 并释放 `window.__INITIAL_STATE__` 后首次开启采集仍回退读取初始 HTML 内联 `<script>` 误绑旧账号 A 的问题；在桥接握手同步后台已确认的暂停状态（`stateConfirmed` / `observedPaused`）后立即标记文档曾处于暂停态（暂停期间零页面读取），将初始 HTML 内联 `<script>` 严格限定于已开启采集时新加载的文档（`src/bridge.js`、`src/interceptor.js`）。
- **[P2]** 修复左下角账号切换按钮（`SideNav_AccountSwitcher_Button`）DOM 用户名短暂滞后于动态 `window.__INITIAL_STATE__` 时将该动态账号写入 `supersededDynamicActorId` 导致后续切回标签页重探仍无法绑定的问题；DOM 按钮不一致仅拦截当次探测而不污染动态账号状态，按钮同步后再次探测即可正常绑定并计入首条回复（`src/interceptor.js`）。
- **[P2]** 修复“账号待确认”期间 Popup 面板自动回退选中字典序首个本地账号（`savedAccounts[0]`）导致展示错位历史统计的问题；待确认状态下优先保持当前面板或同一前台文档最近查看/确认的账号，全新未确认标签页则展示“待确认（请选择查看账号）”占位项等待自动确认或用户显式选择（`src/storage.js`、`src/background.js`、`src/popup/popup.js`）。
- **[P1]** 修复暂停期间加载的文档在页内切号（`A -> B`）而内存 `window.__INITIAL_STATE__` 仍保留 `A`、且左下角账号按钮无可核对用户名时首次开启采集误绑旧账号 `A` 的问题；为所有在确认身份前经历过暂停态的文档启用全局快照时效核验（`needsPausedLoadVerification`），仅当左下角按钮子树实时 `@handle` 明确匹配（同时支持嵌套无空格 DOM 文本节点提取）或内存 `window.__INITIAL_STATE__` 相对初始 HTML `<script>` 基线已真实变更为新账号时才信任，否则保持“账号待确认”，并在同会话解绑时清空旧 GraphQL 身份缓存（`src/x-adapter.js`、`src/interceptor.js`）。
- **[P2]** 修复从未绑定账号的新标签页点击单次暂停与恢复（或在暂停状态下打开面板再开启采集）时，暂停态默认兜底展示的 `savedAccounts[0]` 写入面板记忆并串入“账号待确认”状态的问题；严格隔离“用户显式下拉选择”与“标签页已确认账号”两类来源，禁止将暂停/无活动页的默认兜底账号回写为记忆账号（`src/background.js`、`src/popup/popup.js`）。

### 移除
- (在此记录已移除的功能)
