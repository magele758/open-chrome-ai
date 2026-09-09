# Gemini in Chrome 能力调研

- 日期：2026-09-08
- 状态：调研完成，作为 PRD 输入
- 调研对象：Chrome 内置 **Gemini in Chrome**（不是 gemini.google.com 网页版）
- 产品形态目标：做一个类似体验的 **Chrome 插件**，核心是网页内容理解，并覆盖视频理解

---

## 1. 它是什么

Gemini in Chrome 是 Chrome 桌面端（以及后续 Android / iOS Chrome）里的 **浏览助手**，不是独立聊天网站。

官方定义（Google 帮助中心）：

> 用当前标签页内容回答问题。电脑上还可以额外分享最多 10 个已打开标签。

它和 gemini.google.com 的关键差异：

| | Gemini in Chrome | Gemini 网页 / App |
|---|---|---|
| 入口 | 工具栏「Ask Gemini」/ 快捷键 | 打开网站或 App |
| 页面上下文 | 默认读当前 tab，可 @ 其他 tab | 需粘贴或上传 |
| UI | 侧栏（可 pop-out 成浮动窗） | 全页对话 |
| Live 语音 | 浏览时边看边说 | 独立 Live |
| 数据 | 收集当前/已分享 tab 的页面内容和 URL | 按 App 活动策略 |

官方强调：它 **只在用户主动打开时工作**（点图标或快捷键），不是后台一直读页面。

---

## 2. 交互骨架（产品要对齐的形态）

这是 Gemini in Chrome 真正可抄的部分，比「用哪个模型」更重要。

### 2.1 入口

- 工具栏 sparkle 图标：**Ask Gemini**
- 可自定义键盘快捷键
- 首次使用需要 opt-in
- 可 pin / unpin；可在 Mac 菜单栏 / Windows 托盘显示
- 不支持 Incognito；必须登录 Chrome

### 2.2 主界面：侧栏

2026 年 1 月起，主形态从早期浮动窗改成 **Side Panel**：

- 主内容区继续看网页
- 右侧持续对话，不打断阅读
- 可 **Pop-out** 成独立小窗，或 **Dock** 回当前 tab
- 顶部：新对话 / 更多 / 最近聊天
- 输入框上方：**正在分享的 tabs 列表**（共享中的 tab 有发光下划线）

### 2.3 上下文怎么进模型

默认：当前 tab 的页面内容。

扩展：

1. 输入 `@` 搜索并附加已打开的 tab
2. 「Add tabs」最多再加 **10 个** 近期打开的 tab（跨窗口）
3. 可随时取消分享某个 tab
4. 设置项：**Share current tab by default** 可关
5. 若分享的是 Google Workspace 页面（如 docs.google.com），Gemini 可能直接读账号里的完整文档，而不只是 tab 里可见部分

### 2.4 指哪问哪

两层「局部上下文」：

| 能力 | 状态 | 交互 |
|---|---|---|
| 普通文本选区 | 已有（页面选中文字） | 用户先选文字再提问 |
| **Select from Screen** | Chrome 149 起滚动（约 2026-06） | `+` 菜单 → 框选当前 tab 上的文字或图片，作为附件进 prompt |

Select from Screen 类似手机 Circle to Search：框选后自动贴到输入框，用户再打问题。可拖拽调整选区。`Esc` 退出。

### 2.5 Skills（可复用 prompt）

2026-04-14 上线：

- 输入 `/` 或点 `+` 打开 Skills 选择器
- 完整库：`chrome://skills/browse`
- 自己的 Skills：`chrome://skills/yourSkills`
- 预置 50+ 条（学习 / 研究 / 购物 / 写作 / 生产力）
- 可编辑预置 prompt，登录后跨设备同步
- 跑在「当前页 + 你选的其他 tabs」上

官方示例 Skill（Protein Maximizer）：分析当前食谱页的原料、估算蛋白质、给替代方案。

### 2.6 模型与输入方式

- 输入框可切换 Gemini 模型
- 文字 / 语音（Live，18+）
- 可把页面变成学习材料：闪卡、测验、cheat sheet
- 可用 Nano Banana：把当前页做成信息图，或改页面上的图（不需要另存再上传）

---

## 3. 能力地图（按「用户任务」拆）

下面按任务归类。这是 PRD 功能清单的对照表。

### A. 读懂当前页（核心）

| 任务 | 官方示例 | 对插件的含义 |
|---|---|---|
| 摘要 | 「总结这篇文章的要点」 | P0 |
| 换种方式解释 | 把复杂概念讲简单 | P0 |
| 在长页里找答案 | 跳过无限滚动，直接定位 | P0 |
| 测验自己 | 根据当前页出题 | P1 |
| 改内容适配自己 | 食谱改素食/加蛋白；根据个人情况改建议 | P1 |
| 评论/评测汇总 | 跨站点总结产品评价 | P1（依赖多 tab） |
| 把页变成学习材料 | 闪卡 / 测验 / cheat sheet | P1 |
| 把页变成图 | Nano Banana 信息图 | P2（生成图，不是理解） |

### B. 跨 tab 理解

| 任务 | 官方能力 | 对插件的含义 |
|---|---|---|
| 对比 | 多开商品/方案 tab，整理规格和优缺点 | P0（上限可先 5，官方是 10） |
| 合并信息 | 多页合成一份 | P0 |
| 购物搭配 | 「这个配什么」 | P2 |

### C. 视频理解（本项目明确要做）

官方与实测来源：

- Google Chrome AI 页：可 **summarize YouTube videos**
- 日经 XTrend（2026-07）：侧栏会分享当前 YouTube 页，可边看边问
- PCM 香港实测：给摘要 + **带时间戳的关键点**；点时间戳 **跳转到视频位置**（例：5 小时片里定位到 32:02）
- YouTube 站内另有 **Ask Videos / Ask YouTube**（播放页 Gemini 图标），和 Chrome 侧栏是两条产品线
- Gemini API（2026-09）：Agentic video understanding，可对上传视频和 YouTube URL 做动态检索，token 最多降 88%

能力拆解：

| 能力 | Gemini in Chrome / YouTube | 实现难度 |
|---|---|---|
| 当前 YouTube 视频摘要 | 有 | 中：字幕优先，无字幕再上多模态 |
| 带时间戳的章节/要点 | 有 | 中 |
| 问答 + 点击跳转 `video.currentTime` | 有 | 低（content script 控 `<video>`） |
| 「看到某段画面时发生了什么」 | 依赖原生视频理解，不只字幕 | 高 |
| 非 YouTube 的 HTML5 / 课程站 / B 站 | 官方几乎不管 | 高，但是差异化 |
| 私密/未列出 YouTube | Gemini API 明确不支持 public URL 这条路 | 高：必须走页面内字幕或用户登录态 |

**结论：** 官方的视频理解几乎等于「YouTube + 字幕/原生多模态 + 时间戳跳转」。插件如果只做 YouTube 字幕摘要，是跟跑；如果把 **任意页面里的 `<video>`** 做成同样体验，才是差异化。

### D. 指哪问哪 / 多模态

| 能力 | 状态 | 对插件 |
|---|---|---|
| 框选文字 | 基础 | P0 |
| 框选图片 / 屏幕区域 | Select from Screen，Chrome 149 | P0（截图附件） |
| 页面图片解释 | 有 | P1 |
| 语音 Live | 18+，边浏览边说 | P2 |
| 当前视频帧当图 | Prompt API 支持 `HTMLVideoElement` 当前帧 | P1 技术路径 |

### E. 行动型（理解之外）

这些是 Gemini in Chrome 的「助手」半边，不是「内容理解」半边。

| 能力 | 限制 | PRD 建议 |
|---|---|---|
| Auto browse（代为多步操作网页） | 美国、18+、AI Pro/Ultra、英语；Pro 每天约 20 次、Ultra 约 200 次；敏感操作要确认 | **非目标（MVP）** |
| Connected Apps（Gmail / Calendar / YouTube / Maps / Flights / Shopping） | Google 账号生态 | 非目标 |
| 用 Password Manager 登录第三方 | 需授权；密码不交给模型 | 非目标 |
| Personal Intelligence | 「未来几个月」 | 非目标 |
| Spark 远程浏览器 | 关电脑也能继续跑 | 非目标 |

Auto browse 的安全模型值得抄 **交互**，不要抄 **范围**：

- 先出计划，用户点 Start
- 购买 / 发帖 / 提交表单 / 改数据 → 暂停确认
- 用户可 Take over / Resume / Stop
- 官方明确风险：prompt injection、把个人信息提交给网站、点错按钮

### F. 端侧 AI（另一条产品线，容易混淆）

Chrome 还有 **Built-in AI**（Gemini Nano / Prompt API / Summarizer API），跑在本机：

- Prompt API：Chrome 138 扩展可用，Chrome 148 Web 稳定；输入 text / image / audio；**没有完整视频流**
- 可用 `HTMLVideoElement` **当前帧** 当图
- Summarizer / Writer / Rewriter / Translator / Language Detector / Proofreader
- 硬件门槛高：约 16GB RAM、约 20GB 磁盘、音频还要 4GB 显存
- 官方扩展样例：`ai.gemini-on-device-summarization`（Readability 抽正文 → Summarizer API → 侧栏）

**这不是 Gemini in Chrome。** Gemini in Chrome 走云端大模型 + Google 账号；Built-in AI 走本地 Nano。插件可以 **混合**：短摘要/隐私页用本地，深度问答和视频用云端。

---

## 4. 数据、隐私、可用性（为什么值得做插件）

### 4.1 数据怎么走

官方 Privacy Hub：

- 会收集并处理 **已分享 tab 的页面内容和 URL**
- 「有些被用到的页面内容，用户自己未必看得见」（隐藏 DOM / 未渲染部分）
- 若 Keep Activity 开着：访问过的站点、音频、文件进 Gemini Apps Activity
- 页面内容会短暂记在 Google 账号，**不一定出现在 Activity 列表里**

### 4.2 谁用不了

这是插件的市场缝：

- 地区滚动发布，很多地区没有
- 要登录 Chrome；Incognito 没有
- 语言 / 地区白名单
- 企业账号可能被管理员关掉
- Auto browse 更窄：美国 + 付费订阅
- 中国大陆用户几乎把「Chrome 里的 Gemini」当成不可用功能

### 4.3 插件相对官方的合法差异

| 官方弱点 | 插件可以怎么打 |
|---|---|
| 地区 / 账号锁定 | 自带模型或用户 BYOK |
| 数据进 Google 账号 | 本地抽正文，密钥存在 `chrome.storage`，可选不经自有服务器 |
| 视频几乎只深耕 YouTube | 任意 `<video>` + 字幕 + 抽帧 |
| Skills 和 Google 应用绑死 | 开放 prompt 模板，不绑 Gmail |
| 不能在 Incognito 用 | 插件仍可在普通窗口工作；无痕需单独权限声明 |
| 不可选非 Gemini 模型 | 可接 OpenAI-compatible / 国内模型 |

不要做的：

- 伪装成官方 Gemini
- 静默上传整页（必须可见的「正在分享」状态）
- MVP 就做 auto browse（安全、审核、ToS 全是坑）

---

## 5. 竞品（插件形态）

| 类型 | 代表 | 做法 | 缺口 |
|---|---|---|---|
| 官方 | Gemini in Chrome | 侧栏 + 多 tab + YouTube + Skills + 以后 agent | 地区/账号/锁定生态 |
| 本地 Built-in AI | Chrome AI Studio、Sidekick AI、官方 summarization sample | Prompt API + 侧栏 | 模型弱，几乎不能做长视频 |
| 云端侧栏 | Monica、Sider、ChatGPT sidebar、AI Vision | 读当前页 / 截图 / 多 tab | 视频时间戳跳转普遍弱 |
| YouTube 专用 | CyFrog、各类 Summarizer | 字幕 → 摘要 → 点击跳转 | 离开 YouTube 就不会了 |
| 打开新标签丢 prompt | 「视频一键摘要 for Gemini」 | 把 URL 填进 Gemini 网页 | 不是 in-situ 理解 |

**空白点：**「侧栏里问当前页 + 当前视频，答案带引用和时间戳，点一下跳回页面/进度条」——官方有，但很多用户没有；第三方要么只会网页、要么只会 YouTube。

---

## 6. 对技术方案的预告（详细方案见后续文档）

先记约束，避免 PRD 写成空中楼阁。

1. **形态必须是 MV3 扩展 + `sidePanel`**，不要 popup 小窗当主 UI。
2. **读页面**不要只抓 `innerText`：用 Readability / 语义抽取，去掉导航和广告；动态站点要等主要内容。
3. **`activeTab` 对侧栏按钮无效**（Chrome 文档明确写了）。侧栏里点「总结」需要 `tabs` + `host_permissions`，不能靠 activeTab。
4. **YouTube 是 SPA**：要监听导航，不能只在 `onInstalled` 注入一次。
5. **视频三条降级路径：**
   1. 页面字幕 / `ytInitialPlayerResponse.captionTracks`
   2. 云端多模态（YouTube 公开 URL 或上传片段）
   3. 抽关键帧 + ASR（通用 `<video>`）
6. **跳转**用 content script：`document.querySelector('video').currentTime = t`。
7. **框选**用覆盖层截图（`chrome.tabs.captureVisibleTab`）或 DOM 选区文本，不要一上来就 `tabCapture` 录音。
8. **权限最小化**：先 `activeTab` 做不到的部分用可选 host permissions，审核会看 `<all_urls>`。

---

## 7. 资料

- [Use Gemini in Chrome](https://support.google.com/chrome/answer/16283624)
- [Gemini in Chrome 产品页](https://gemini.google/overview/gemini-in-chrome/)
- [Gemini 3 + side panel + auto browse](https://blog.google/products-and-platforms/products/chrome/gemini-3-auto-browse/)
- [Chrome AI innovations](https://www.google.com/chrome/ai-innovations/)
- [Auto browse 帮助](https://support.google.com/gemini/answer/16821166)
- [Gemini Apps Privacy Hub（含 Chrome 数据）](https://support.google.com/gemini/answer/13594961)
- [Prompt API](https://developer.chrome.com/docs/ai/prompt-api)
- [官方扩展样例：on-device summarization](https://github.com/GoogleChrome/chrome-extensions-samples/tree/main/functional-samples/ai.gemini-on-device-summarization)
- [Gemini API video understanding](https://ai.google.dev/gemini-api/docs/video-understanding)
- [Agentic video（2026-09-01）](https://blog.google/innovation-and-ai/models-and-research/gemini-models/introducing-agentic-video-in-gemini/)
- WIRED：Skills in Chrome（2026-04-14）
- Digital Trends / 9to5Google：Select from Screen（Chrome 149，2026-06）
- PCM / 日经：YouTube 摘要 + 时间戳跳转实测
