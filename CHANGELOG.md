# 更新日志

所有对本项目的显著变更都将记录在此文件中。

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 规范。

## [未发布]

### 新增
- 完成项目标准化与 Conductor 管理结构初始化（基于 `spec.md` v1.2.0）。
- 完成 P0 兼容性验证与适配契约层：构建脱敏网络/DOM 测试样本集（`tests/fixtures/`），实现 X GraphQL 白名单适配器与有界待解析队列（`src/x-adapter.js`）、MAIN 世界只读流式网络封装（`src/interceptor.js`）以及 ISOLATED 世界消息桥接与批次确认状态机（`src/bridge.js`）。

### 变更
- (在此记录现有功能的改进)

### 修复
- (在此记录修复的 Bug)

### 移除
- (在此记录已移除的功能)
