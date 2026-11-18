# SparkLink - 星火链

> 我不会错过你的每一次发声。

**SparkLink（星火链）** 是一个 **100% 纯本地运行** 的 Chrome / Edge（Manifest V3）浏览器扩展。它会安静地记录你在 X（原 Twitter）上主动回复过哪些人，并在时间线与个人主页的名字旁点亮大小递进的「星火徽章」，帮你记住每一次认真交流过的朋友。

---

## 核心特性与隐私承诺

- **数据仅在本地，零服务器上传**：
  - 没有后端服务器、没有第三方接口请求、没有遥测埋点、不使用 `storage.sync` 云同步。
  - 所有回复记录、统计结果和备份数据全部保存在你当前浏览器的本地扩展存储（`chrome.storage.local`）中。
- **极简权限与零 Cookie 读取**：
  - [manifest.json](manifest.json) 仅申请了最小必要权限 `storage`，不申请 `cookies`、`tabs`、`downloads` 或额外 `host_permissions`。
  - 仅在 `https://x.com/*` 与 `https://twitter.com/*` 生效，**不读取 `document.cookie`、授权头（Authorization）或 CSRF Token**。
- **星火互动分级徽章（近 30 天滚动窗口）**：
  - **1–10 次**（初识互动）：小号橙焰
  - **11–50 次**（活跃互动）：中号橙焰
  - **51 次及以上**（深度互动）：大号橙焰
  - 对方已有蓝 V 认证时，橙焰会围绕原蓝 V 图标显示；无蓝 V 时显示白心橙焰。
- **支持手动补充「最近数据」与备份迁移**：
  - 可点击弹窗中的 **「同步最近数据」**，在前台标签页以低频受控滚动（每页至少间隔 12 秒，单次最多读取 1000 条或近 7 天边界，遇到限流或验证立即熔断停止）被动补录最近的主动回复。
  - 支持将记录导出为紧凑 JSON 备份文件，用于跨设备迁移或自行留档，也支持单账号清理和一键清空全部本地数据。

---

## 安装与使用方式

### 方式一：下载源码直接加载（推荐，方便自行魔改）

1. 克隆本仓库或点击 GitHub 页面右上角 **Code → Download ZIP** 下载并解压到本地文件夹。
2. 打开 Chrome（或 Edge）扩展管理页面：
   - Chrome 地址栏输入：`chrome://extensions/`
   - Edge 地址栏输入：`edge://extensions/`
3. 打开右上角的 **「开发者模式」** 开关。
4. 点击 **「加载已解压的扩展程序」**，选择刚刚解压的仓库根目录（包含 `manifest.json` 的目录）。
5. 打开或刷新 `https://x.com`，点击浏览器右上角的 SparkLink 火焰图标打开弹窗：
   - 开启顶部的采集总开关（或点击 **「开启本地统计」**）。
   - 之后你在 X 上每次发出的主动回复都会自动累计到本地，浏览信息流或用户主页时即可看到对应星火徽章。
   - 如需补录近期回复，在已登录的 X 页面打开弹窗，点击数据管理中的 **「同步最近数据」**，等待同步标签页自动读取完成即可（同步期间请停留在该标签页）。

### 方式二：自行打包为 `.zip` 安装或分发

如果你修改了样式或配置，想重新打一个只含扩展运行文件的轻量压缩包，在项目根目录执行：

```bash
mkdir -p dist
zip -r dist/sparklink-custom.zip manifest.json icons src
```

将生成的 `dist/sparklink-custom.zip` 解压后按同样方式「加载已解压的扩展程序」即可（或直接把压缩包拖入部分浏览器的扩展页面安装）。

---

## 下载后扔给你的 AI：自由调主题、调样式、自己打包

这个项目架构清晰、零构建依赖（原生 HTML/CSS/JS，**不需要 `npm install`、Webpack 或 Vite**），改完代码在浏览器扩展页点一下 **刷新** 就能立刻生效！

你可以直接把整个文件夹扔给你的 AI 编程助手（如 Claude Code、Codex、Gemini CLI、Cursor、Antigravity 等），让它帮你改成任何你喜欢的样子。

### 常用定制文件指引

| 想改什么 | 对应文件 | 说明 |
| --- | --- | --- |
| **网页徽章样式 / 火焰大小 / 颜色 / 动画** | [`src/styles.css`](src/styles.css) | 修改 `--sparklink-fire-scale` 缩放比例、`.sparklink-fire-shape` 填充色与悬停动画 |
| **网页徽章挂载与 DOM 渲染** | [`src/content.js`](src/content.js) | 徽章 SVG 构建、悬浮提示文本与页面注入位置 |
| **弹窗浅色 / 深色主题配色** | [`src/popup/popup.css`](src/popup/popup.css) | 顶部 `:root` 与 `@media (prefers-color-scheme: dark)` 中的全部配色变量 |
| **弹窗页面结构与交互逻辑** | [`src/popup/popup.html`](src/popup/popup.html)、[`src/popup/popup.js`](src/popup/popup.js) | 面板尺寸、标题口号、榜单布局与按钮交互 |
| **互动档位阈值与统计周期** | [`src/metrics.js`](src/metrics.js)、[`src/content.js`](src/content.js) | `src/metrics.js` 定义 `WINDOW_MS`（默认 `30 天`）与 `TIER_THRESHOLDS`（`11 / 51`）；需同步更新 `src/content.js` 中的 `TIER_ACTIVE_MIN` / `TIER_DEEP_MIN`（Popup 标签会自动读取 `TIER_THRESHOLDS`） |
| **同步条数 / 翻页上限** | [`src/history-sync.js`](src/history-sync.js) | `MAX_ITEMS`、`MAX_PAGES`、冷却时间等（注意保留防风控延迟） |
| **扩展图标与基础信息** | [`icons/`](icons/)、[`manifest.json`](manifest.json) | 替换 16/32/48/128 PNG 图标、名称或版本号 |

### 可直接发给 AI 的提示词示例

> 「这是一个纯原生 JS 的 Chrome MV3 扩展，没有任何构建工具。请帮我：
> 1. 修改 `src/popup/popup.css` 的浅色/深色主题变量为赛博霓虹风格（或你喜欢的配色）；
> 2. 把 `src/styles.css` 和 `src/content.js` 里的橙色火焰徽章改成紫色/蓝色渐变或其它图标；
> 3. 修改完成后运行 `node --test tests/*.test.js` 确保所有测试通过；
> 4. 重新帮我把 `manifest.json`、`icons/` 和 `src/` 打包成一个干净的 `.zip` 安装包。」

---

## 本地校验与测试

本仓库测试基于 Node.js 原生 `node:test` 运行，无需安装任何第三方依赖。因测试集同时使用 ESM 与 CommonJS 且根目录不引入 `package.json`，需要 **`Node.js >= 22.12`**：

```bash
# 1. 语法检查
for f in src/*.js src/popup/*.js; do node --check "$f" || exit 1; done

# 2. 运行全部单元测试与静态安全审计
node --test tests/*.test.js

# 3. 运行测试并输出覆盖率统计
node --test --experimental-test-coverage tests/*.test.js
```

测试套件包含静态安全审计（[`tests/p0-security-and-e2e.test.js`](tests/p0-security-and-e2e.test.js) 与 [`tests/acceptance-matrix.test.js`](tests/acceptance-matrix.test.js)），会自动校验源码中不存在 `document.cookie`、鉴权头读取或额外网络外发行为。

---

## 仓库目录结构

```text
SparkLink/
├── manifest.json             # Manifest V3 权限与内容脚本配置
├── icons/                    # 16/32/48/128px 扩展图标
├── src/
│   ├── background.js         # Service Worker：会话绑定、存储协调、同步任务调度
│   ├── bridge.js             # ISOLATED 世界与 MAIN 世界通信桥接
│   ├── interceptor.js        # MAIN 世界只读网络响应拦截与原生滚动驱动
│   ├── x-adapter.js          # X GraphQL 白名单操作匹配与响应解析
│   ├── history-sync.js       # 「同步最近数据」状态机、防风控节拍与上限控制
│   ├── history-sync-page.js  # 同步专用标签页页面控制与自动回退逻辑
│   ├── storage.js            # 单写者串行本地存储、清理与 JSON 导入/导出
│   ├── metrics.js            # 30 天滚动统计、互动分级与 Top 20 排序
│   ├── schema.js             # 数据结构校验与备份迁移
│   ├── content.js            # 页面作者识别与星火徽章 DOM 渲染
│   ├── styles.css            # 网页端星火徽章样式与动画
│   └── popup/                # 扩展弹出面板（HTML / CSS / JS）
└── tests/                    # 单元、E2E 与静态安全审计测试及脱敏样本
```

---

## 开源与安全说明

- `.gitignore` 已默认排除本地构建包（`dist/`、`*.zip`）、个人备份文件（`sparklink-backup-*.json`）、浏览器调试配置、`.env*`、代理与本地工作流目录（`.agent/`、`conductor/`、`CLAUDE.md`、`GEMINI.md`）。
- 若基于本仓库二次开发后继续开源分享，请先运行 `git status` 检查不要把个人导出的 `sparklink-backup-*.json` 或浏览器配置目录提交进版本库。
- 本扩展为非官方辅助工具，与 X Corp. 无任何隶属关系；请合理使用同步频率并遵守平台使用规范。

---

## 开源协议

本项目基于 [Apache License 2.0](LICENSE) 开源发布。
