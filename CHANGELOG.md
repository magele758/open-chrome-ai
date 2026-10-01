# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed
- 下载的字幕和转写稿改为写入 `~/.cache/pagelens-docs`，不再自动落到 Obsidian 文稿文件夹。
- 文本模型改为多服务商：可新增多个 OpenAI 兼容 Provider、扫描/手填模型、勾选可选模型，并在对话底部切换。
- `run_shell` 拦访达 / 递归扫盘：整串匹配（含 `bash -c`、`/usr/bin/open`），换目录 `ls` 满 8 次或连续拦截 3 次后强制收束。
- 同传译文 `max_tokens` 提到 4096–8192；碰到输出上限先加大预算重试，仍截断才跳段。

### Added
- 可信输入（`chrome.debugger`，设置里可关）：`trusted_click`（左/右键、双击）、`hover`、`trusted_type`、`press_keys`（含 Ctrl/Meta+A/C/V/X/Z 真实编辑命令）、`drag_drop`（原生 HTML5 拖放）、`upload_file`（`<input type=file>` 或自定义上传按钮）、`handle_dialog`；`click`/`fill` 等遇到 alert/confirm 不再卡死，会提示并交给 `handle_dialog`；`screenshot` 支持 `fullPage` 与 `selector`。空闲 20 秒自动分离调试器以收起横幅。
- 下载与会话：`download_file`、`list_downloads`、`save_page_mhtml`、`recently_closed_tabs`、`restore_closed_tab`、`web_search`（默认搜索引擎）；`download_file` / `upload_file` 属特权操作，按授权模式确认。
- `act_element` 带编号滚动时滚动控件所在的内部滚动容器。
- manifest 新增权限：`debugger`、`downloads`、`sessions`、`search`、`pageCapture`。
- 剪贴板支持富文本和图片：`clipboard_read` 读 text/html/图片（图片附到对话），`clipboard_write` 可写 html/图片，新增 `copy_selection`（带格式复制页面选区）与 `paste_into_page`（向输入框/富文本编辑器粘贴，优先派发 paste 事件）；`get_selection` 加 `rich`；侧栏「复制回答」同时写入 HTML 与 Markdown。
- 配置并启用 JEV 后，Agent 多出 `snapshot_controls`（带编号的控件表，含 shadow DOM 与跨域 iframe）、`act_element`（按编号操作，执行前校验过期与遮挡）、`jev_next_action`（JEV 一次请求选出操作与目标，可自动执行）。
- `click` / `fill` / `select_option` 顶层找不到时自动探测所有 iframe（含跨域）并只在命中的 frame 执行；选择器与文字匹配、`list_controls`、`query_dom` 支持 open shadow DOM；`list_controls` 新增 `allFrames`。
- `run_js` 遇页面 CSP 禁 eval 时依次退到 MAIN 世界、`chrome.userScripts`（需在扩展详情页开启「允许用户脚本」），仍失败会明确提示 CSP 并建议改用结构化工具。
- Agent 补 `extract_pages`、`wait_for_navigation`、`clipboard_read`、`list_directory` / `read_file`（本机只列一层、限根目录）。
- **一键剪藏至 Obsidian 独立卡片与 Chrome 书签联动 (Clippings & Footprint Recall)**:
  - 新增 `extension/lib/clippings.js`：核心剪藏逻辑，生成带标准 YAML Frontmatter（title, url, date, tags, clipping_id, source）与思考备注的独立 Markdown 卡片文件（`PageLens/clippings/YYYY-MM-DD-slug-id.md`）。
  - Chrome 书签联动：保存时自动查找或创建 Chrome 收藏夹专用目录 `PageLens 智库`，书签标题前置用户随手备注（如 `[思考前15字] 网页标题`），提升地址栏直达与检索体验。
  - 智能回显（Smart Recall / Footprint Recall）：在用户二次访问曾剪藏过的网页时，侧栏上下文自动弹出轻量回显横幅（`💡 本页曾剪藏过 N 条笔记：“...”`），支持一键点击查看完整历史笔记卡片，形成双向知识闭环。
  - 新增单条 Assistant 消息底部「⭐ 剪藏」按钮及简洁交互弹窗（支持编辑标题、URL、备注、标签与独立选项开关）。
  - 新增单元测试 `extension/tools/test_clippings.mjs`，覆盖 URL 规范化过滤、Frontmatter 结构与书签标题组装校验。

## [0.12.0] - 2026-09-11

### Changed
- 同声传译改为按序组句：保留未完成句尾，模型在同一次请求中判断可翻译前缀并输出中文，校验前缀与后缀能完整还原原文。
- 翻译携带最近三条已确认原文/译文，维护有界术语参考；识别失败缺口、拖动和换会话会清理相关状态。
- 配音队列支持一块音频产生零至多条句段；开播不足一批时继续采音，结束时提交剩余尾句。识别、翻译与合成请求均有超时。
- 移除英文 800 字符、中文 240 字符的静默截断；模型明确报告输出截断时拒绝配音。TTS 失败的译文按时间顺序显示。
- 新增跨块否定、乱序、分句格式校验、尾句、上下文、超时和队列回归测试；日志 build 为 `semantic-interpret-v1`，新归档标记处理版本。

## [0.11.0] - 2026-09-11

### Added
- **Tool Output Guardian (长工具返回拦截与归档)**:
  - 新增 `extension/lib/agent/artifact-store.js`：实现 L1 内存快表 + L2 IndexedDB（`pagelens-data`）双层持久化存储，支持按 `sessionId` 分组隔离、分卷翻页（`readArtifactPage`）、全文纯词法检索与生命周期垃圾回收（`deleteSessionArtifacts`）。
  - 新增 `extension/lib/agent/tool-guardian.js`：对单次超过 1800 字符的工具返回进行自动拦截并归档，向模型上下文注入结构化引导卡片（包含 Handle 唯一句柄、总字符数、分卷总页数及约 450 字符前瞻预览），保护 Context Window；内置白名单防止检索工具自身递归拦截。
  - 新增核心常驻检索工具：在 `extension/lib/agent/tools.js` 注册 `search_tool_artifact`（纯浏览器沙箱正则/关键词快速词法检索，单次匹配耗时 <2ms）与 `read_tool_page`（按页精确翻阅指定分卷），零外部网络请求，无需配置向量 Embedding 模型。
  - 新增端到端自动化测试套件 `extension/tools/test_guardian.mjs`，覆盖多页存储、拦截归档、Agentic 搜索召回和会话级联垃圾清理。

### Changed
- **上下文治理与安全截断 (Context Governance & Truncation)**:
  - 吸收 `ppeng-agent-core` 的 Micro-Compact 微压缩机制：历史轮次中已消费的旧 tool 结果在下一轮自动收拢为极简单行 Stub 标记（保留 tool call 和 artifact 句柄引用，移除长正文），大幅节省上下文空间。
  - 引入 Safe Session Cut 安全会话截断：超长会话（≥14 轮且超出预算）时锚定保留首轮用户意图（防目标漂移）与最近的活跃交互窗口，安全裁剪中间冗余轮次，并严格遵循 Tool Wave 成对安全规则，杜绝破坏 OpenAI API 校验；底层 IndexedDB 始终保留无损对话全量记录。
- **会话生命周期清理 (Session GC)**:
  - 侧栏删除会话时联动调用 `deleteSessionArtifacts` 级联清理该会话产生的所有 Artifacts，避免 IndexedDB 存储泄露与膨胀。
- **版本号升级**:
  - `manifest.json` 与 `README.md` 版本号递增至 `0.11.0`。

---

## [0.10.0] - 2026-09-11

### Added
- **MCP (Model Context Protocol) 协议原生支持**:
  - 本机 Native Host (`native/pagelens-host.mjs`) 支持标准 MCP 协议，通过 JSON-RPC 2.0 暴露 `tools/list` 与 `tools/call` 接口。
- **安全护栏与 HITL (Human-in-the-Loop) 确认**:
  - 新增 `extension/lib/agent/guardrail.js`，针对高危文件读写与命令执行引入用户显式交互确认拦截。
- **多工具路由与工具集管理 (Tool Router & Toolsets)**:
  - 扩展 51 项 Agent 工具，支持按功能域（`core_reader`, `tab_ops`, `page_actions`, `fs_ops`, `system` 等）按需动态挂载与路由。
- **同传控制器解耦与音频质量检测**:
  - 新增 `InterpretController` 独立接管同传生命周期与状态机。
  - 新增 VAD 语音活动检测与 `speech-quality.js` 声音质量判定。

---

## [0.9.8] - 2026-09-10

### Added
- PDF 抽取支持（arXiv, alphaXiv, 本地 PDF）。
- 视频一键总结与当前页同声传译。
- Index-TTS 配音支持与克隆原声音色。
- 本机文稿文件夹与 Skill 目录授权。
