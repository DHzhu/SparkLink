# 更新日志

所有对本项目的显著变更都将记录在此文件中。

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 规范。

## [未发布]

### 变更

- 扩展主显示图标（`icons/icon16.png`、`icons/icon32.png`、`icons/icon48.png`、`icons/icon128.png`）与 Popup 顶部品牌标志（`src/popup/popup.html`）同步更新为深空蓝底色的橙金火焰环图形，与页面互动徽章视觉保持一致。
- 互动徽章改为同色橙焰，按 1–10、11–50、51 次及以上逐档变大。有蓝 V 时火焰围绕原标识，无蓝 V 时显示白心火焰。徽章只用火焰大小区分等级，排行榜次数单独显示。开启减少动态效果后火焰保持静止。
- 备份导出切换为紧凑 JSON 序列化并引入 `O(1)` 用户 Handle 索引（`src/popup/popup.js`、`src/storage.js`），确保满载 20,000 条回复（约 5.92 MiB）导出的备份体积低于 9 MiB 导入上限且可快速往返恢复。

### 新增

- 新增“同步近 7 天回复”。打开并切换到专用前台标签页进入本人回复列表，仅通过受限速的原生页面滚动触发 X 自身前端加载分页并被动拦截响应；缺少分页入口时按 UTC 日期读取 X 最新搜索结果并支持日内滚动翻页。时间线阶段最多 8 页、搜索阶段最多 32 次推进；两次启动至少间隔 15 分钟。遇到限流或需要验证即停止，保留已同步记录，并在弹窗展示可重试时间。
- 在 Popup“数据管理”新增默认关闭的“调试日志（控制台输出同步诊断）”开关（`sparklink_debug_logs`），统一控制 Worker、Bridge、Page 与 MAIN 四个环境的 `[SparkLink Sync/*]` 诊断日志输出。
- 完成项目标准化与 Conductor 管理结构初始化（基于 `spec.md` v1.2.0）。
- 完成 P0 兼容性验证与适配契约层：构建脱敏网络/DOM 测试样本集（`tests/fixtures/`），实现 X GraphQL 白名单适配器与有界待解析队列（`src/x-adapter.js`）、MAIN 世界只读流式网络封装（`src/interceptor.js`）以及 ISOLATED 世界消息桥接与批次确认状态机（`src/bridge.js`）。
- 完成 P1 本地 MVP 核心实现与第 13 节端到端验收：
  - 新增 Manifest V3 配置清单（`manifest.json`）、本地状态 v1→v2 迁移及便携备份白名单校验（`src/schema.js`）、30 天连续滚动窗口统计与 Top 20 稳定排序（`src/metrics.js`）。
  - 实现单写者串行存储控制器、过期记录与孤立用户清理、7 MiB 预警 / 8 MiB 容量回滚以及两阶段 JSON 备份导入合并（`src/storage.js`）。
  - 实现 Service Worker 信任上下文配置、Popup 与顶层 X 页面权限分离及 `storage.session` 跨重启会话绑定恢复（`src/background.js`）。
  - 实现 DOM 星火徽章分级渲染（SVG 火苗、认证图标后置布局、`MutationObserver` 合并与 `requestAnimationFrame` 分片、虚拟列表节点复用清理及 60 秒过期窗口自动刷新，`src/content.js`、`src/styles.css`）。
  - 实现浅色/深色自适应 Popup 管理界面（`src/popup/`）并通过全部 34 项单元与端到端验收测试（整体行覆盖率 88.13%）。
- 补齐 4 个尺寸确定性品牌 PNG 图标（`icons/icon16.png`、`icons/icon32.png`、`icons/icon48.png`、`icons/icon128.png`），并接入真实 Chromium 155 未打包扩展加载与 CDP 真实 DOM / 原生 `Request` 回归验收（`tests/remediation.test.js`，全量 65 项测试通过，整体行覆盖率 89.68%）。

### 修复

- **[全仓审计]** 修复 5 项全仓边缘场景问题（`src/background.js`、`src/bridge.js`、`src/history-sync.js`、`src/history-sync-page.js`、`src/interceptor.js`、`src/styles.css`、`src/content.js`、`src/popup/popup.js`）：
  - 同步标签页切换账号时先停止旧任务再清空 `historySyncId`，避免新绑定账号的被动回复补录被误拦截；
  - `history.read()` 超时状态持久化并下发 `END_HISTORY_TRANSPORT`，`CLEAR_ACCOUNT` / `CLEAR_ALL` 完整清理同步传输层并重置 `sparklink_debug_logs` 调试开关；
  - 桌面双栏布局下 `triggerScrollStep()` 优先滚动 `[data-testid="primaryColumn"]` 内的时间线单元格，跳过隐藏 `/with_replies` 链接，并在时间线中途滚动停滞满 45 秒时平滑回退至 UTC 按日搜索；
  - 修正火焰环内切圆与外焰谷底自交缺口及深色背景白芯外溢，并将无蓝 V / 认证容器包裹下的独立互动徽章内联挂载于显示名同行；
  - 捕获导入文件读取异常、仅在清空操作确认成功后重置面板账号选择状态，并同步多页按日搜索状态提示文案。

- **[P0]** 移除 `src/interceptor.js` 中所有扩展自建/模板重放 GraphQL 请求、JS 包 `queryId` 扫描、`ct0` Cookie 读取、鉴权请求头记录及数组 `.join()` 拆分绕过代码，消除因缺失一次性 `x-client-transaction-id` 触发 HTTP 404 空响应导致时间线误判不兼容与按日搜索提前中断的问题，并强化静态安全审计规则（`src/interceptor.js`、`tests/p0-security-and-e2e.test.js`）。
- **[P1]** 将七天同步专用标签页改为前台激活打开（`active: true`，无需新增 `tabs` 权限），并在 Popup 增加“同步期间请停留在该标签页”提示；`HISTORY_NEXT` 统一改为纯页面原生滚动翻页（`scrollScan`），在触发滚动前即消费并标记当前游标，消除重复翻页竞态并修复第二页空响应末尾判定与慢网宽限等待（`src/history-sync.js`、`src/interceptor.js`、`src/popup/popup.js`）。
- 从浏览器前进或后退缓存恢复 X 页面后，重新确认采集账号。恢复前发出的请求和排队的消息会失效，后台暂时无响应时自动重试握手。
- 修复显示名中提及其他用户时，账号误绑定、作者徽章消失或显示在错误用户旁的问题。
- 已打开的弹窗会随当前页面的账号绑定更新。重新绑定或进入新文档时，旧的手动选择会失效。清空单账号数据前会重新核对目标，避免误删此前查看的账号。

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
- **[P1]** 修复暂停期间加载的文档在页内切号（含 `A -> B` 及 `A -> B -> A` 切回）且左下角账号按钮无可核对用户名时，首次开启采集误绑历史内存快照（`A` 或 `B`）的问题；凡在确认身份前经历过暂停态的文档（`needsPausedLoadVerification`），仅有历史全局/内联快照（即使两份历史快照互不相同）一律保持“账号待确认”，严格等待当前账号按钮实时 `@handle` 佐证或新的 `Viewer` 响应到达后再绑定，并在同会话解绑时清空旧 GraphQL 身份缓存（`src/x-adapter.js`、`src/interceptor.js`）。
- **[P2]** 修复从未绑定账号的新标签页点击单次暂停与恢复（或在暂停状态下打开面板再开启采集）时，暂停态默认兜底展示的 `savedAccounts[0]` 写入面板记忆并串入“账号待确认”状态的问题；严格隔离“用户显式下拉选择”与“标签页已确认账号”两类来源，禁止将暂停/无活动页的默认兜底账号回写为记忆账号（`src/background.js`、`src/popup/popup.js`）。
- **[P2]** 修复账号切换按钮（`SideNav_AccountSwitcher_Button`）与帖子作者容器（`[data-testid="User-Name"]`）将 `@sample_me_alt` 等用户名拆分为相邻文本节点或行内延续标签分段渲染时，误把前缀 `@sample_me` 当成完整用户名匹配旧账号的问题；按块级元素边界先拼合同一字段的连续行内文本再提取完整 `@handle` 比对（`src/interceptor.js`、`src/content.js`）。
- **[P2]** 修复在“账号待确认”标签页手动选择查看账号后关闭并重开 Popup 丢失手选账号的问题；通过 `SET_POPUP_ACCOUNT` 按当前前台标签页 `documentId` 在会话存储（`chrome.storage.session`）持久化并恢复手选账号，跨面板开闭、暂停/恢复及 Service Worker 重启保持一致，跨文档跳转或新账号正式绑定时自动更新重置（`src/background.js`、`src/popup/popup.js`）。
- **[P1]** 修复确认账号或读过未确认快照后进入暂停态、暂停期间发生 `A -> B -> A` 切号而页面内存停在 `B` 且左下角账号按钮无可核对 `@handle` 时，恢复采集仅凭快照 ID 变化误绑旧账号 `B`、漏记 `A` 首条回复的问题；统一暂停后及 BFCache 恢复身份门禁（`needsPostPauseVerification`），经历任何暂停边界后一律要求由实时账号按钮 `@handle` 佐证或由当前会话新的 `Viewer` 响应确认身份，否则保持“账号待确认”（`src/interceptor.js`）。
- **[P2]** 修复帖子作者容器与账号按钮行内文本合并后携带时间/中点分隔符（如 `@somebody_else · 2h`、`@somebody_else·2h` 及 Unicode 双向隔离控制符）时无法提取可见 `@handle`，导致链接与文本冲突时将徽章标错人及无链接作者行漏挂徽章的回归问题；改为在拼合连续行内片段基础上剔除双向控制符并按词法边界扫描合法 `@handle`（同时忽略邮箱地址与 `>64` 位超长串、拦截粘连或多用户名冲突，`src/content.js`、`src/interceptor.js`）。
- **[P2]** 修复在待确认页面手动选择账号 `A`（无论关闭重开 Popup 还是保持 Popup 常开）后网页收到 `Viewer(B)` 确认新账号时，已打开的 Popup 点击“清理过期记录”刷新仍停留在旧手选账号 `A` 且“清空当前账号”误指向 `A` 的问题；移除刷新时对会话手选账号的内存回填，并将当前打开面板的手动覆盖作用域限定于选择时的已绑定活动账号，使网页新确认或切换账号后已打开面板刷新即自动同步至新账号 `B`（`src/popup/popup.js`、`src/background.js`）。

### 移除
- (在此记录已移除的功能)
