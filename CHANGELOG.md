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

### 变更
- (在此记录现有功能的改进)

### 修复
- (在此记录修复的 Bug)

### 移除
- (在此记录已移除的功能)
