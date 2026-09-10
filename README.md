# PageLens

Chrome 侧栏里的页面 Agent：打开就能问「这一页 / 这段视频在讲什么」，也可以按你的要求操作网页、管标签、收藏这一批页。

模型用你自己的密钥（BYOK），走 OpenAI 兼容接口。中文优先。不经过我们的服务器。

当前版本 **0.8.0**（Manifest V3，主界面是 Side Panel，不是弹窗）。

---

## 设计初衷

对照物是 Chrome 内置的 **Gemini in Chrome**：侧栏、当前标签当上下文、YouTube 带时间戳、选区提问。品类已经成立，但对中国用户几乎等于没有——

1. **进不去**  
   地区、语言、Google 登录、企业策略、无痕窗口，官方助手经常不可用。

2. **出不去**  
   模型和数据绑在 Google 账号上，页面内容进 Gemini Apps Activity。换不了国内模型，也留不住自己的记录。

3. **视频浅**  
   官方深耕 YouTube。课程站、B 站、本地 HTML5、页内播放器基本不管。

PageLens 要做的是：**能用的「内容理解侧栏」**，主场是网页读懂、视频读懂、密钥在用户这边、中文优先。

一开始刻意不做官方那半边「代浏览 / 代购物 / 接 Gmail」。后来在同一套侧栏里，把 Chrome 扩展 API 做成 Agent 工具，于是也能点按钮、填表、开标签、建收藏夹——但仍然是 **你按一次、你看见在干什么**，不是后台接管浏览器。

原则没有变：

- **上下文默认在，但可见。** 打开侧栏就带上当前页；顶上能看到正在读什么，可以取消分享。
- **答案能点回去。** 网页引用、视频时间戳，点一下回到源处。
- **视频是一等公民。** 不只是 YouTube 彩蛋。
- **密钥在你这边。** 不强制注册我们的账号。
- **不抄官方 Gemini 皮。** 商标和审核风险都不碰。

给谁用：每天开一堆标签做研究、学习、决策的人。看 40 分钟教程只想找到「怎么配环境」那 3 分钟；几篇报道对着问争议；商品页 + 评测视频一起看。

---

## 产品能做什么

### 读当前页

打开任意普通网页，直接问。扩展会抽干净正文（去掉导航、侧栏），X/Twitter 走专用抽取。

- 摘要、解释、对照、找原文
- 选中文字后右键「用 PageLens 问选区」
- 回答里的 〔1〕〔2〕可点回页面并高亮
- 需要看图、报错、课件时，截当前画面送给多模态模型

顶栏随时显示「正在阅读 / 正在看帖 / 正在观看」。点 × 取消分享后，这一轮不再带页面。

### 读视频

YouTube 以及页里带 `<video>` 的站点：

- 识别时长、当前进度、有没有字幕
- YouTube 优先拉 timedtext 字幕；其它页尝试 HTML5 `textTracks`
- 无字幕时：点侧栏「转写此视频」（或让 Agent 调 `transcribe_video`）→ 录当前标签声音 → 发到你配置的 Whisper 兼容接口 → 带时间戳的文稿写进原来的字幕槽，之后就能总结、列章节、点时间跳转
- 答案里的 `12:04` 可点，播放器跳到该秒

转写需要在设置里配第三套槽 **语音转写（ASR）**：`base_url` + `model`（如 `whisper-1` / `whisper-large-v3`），云端填 `api_key`，本地 `http://127.0.0.1:端口/v1` 可以不填。走 `POST {base_url}/audio/transcriptions`。扩展不内置 Whisper，也不去解析视频直链。

Netflix 一类 DRM 录不到声音。转写时请保持侧栏打开，必要时在页面上点播放。默认从开头录，最长约 30 分钟。

### 文稿文件夹

设置里选一个本机目录（Obsidian 库、`~/Movies/PageLens` 都可以）。之后有字幕或转写完成时，会写成普通文件，而不是堆在扩展存储里：

```
你选的目录/
  yt-xxxxxxxxxxx/
    meta.json
    original.vtt      # 原稿
    zh.vtt            # 译稿（有翻译才有）
    transcript.md     # 给人看的双语
```

浏览器不提供完整路径，侧栏只显示文件夹名。改译句请改 `zh.vtt`；`transcript.md` 会按两份 VTT 生成。密钥不会写进这个目录。Agent 可以用 `list_library` / `read_library` / `save_video_doc` 读写这个授权目录，出不去。

没选目录时，转写结果仍会临时记在扩展存储里，最多 24 部。

### 操作网页

用户明确要求时，Agent 可以在当前页（或它新开的页）上动手：

| 动作 | 例子 |
|---|---|
| 点 | 「点搜索」「点那个登录旁边的按钮」 |
| 填 | 「搜索框里填 transformer 并回车」 |
| 选、按键、滚动、等待 | 下拉项、Enter / Esc、滚到评论、等元素出现 |
| 先看控件再点 | 会先列出可见按钮和输入框 |

登录、支付、下单仍然要你说清楚才做。不会自己去买东西或改密码。

操作过的标签会进一个橙色 **任务分组**，名字类似 `PL · 你的问题`，方便辨认。说「把这批关掉」会关掉这一组。点「新」开下一场对话，再操作会开新组。

### 管标签、书签、浏览历史

这些走 Chrome 自己的 API，不是另起一个浏览器：

- 列出 / 打开 / 切换 / 关闭 / 刷新标签，跳到指定 URL
- 新建收藏夹，把当前窗口的标签整批收藏进去（`chrome://` 等受限页会跳过）
- 按关键词搜书签、搜最近 7 天浏览记录（标题和网址，不是当年正文）
- 无痕窗口的历史读不到

Session Buddy、Omni 这类「管标签」扩展没有对外接口，调不到；活标签这一层 PageLens 自己就能做。

### 对话与导出

- 每场对话自动存在本机，带着当时的页面标题和 URL
- 侧栏「历」：搜索、打开续聊、删、导出 Markdown / JSON
- 截图只记「含截图」，不把图片字节写进历史
- 关掉侧栏再打开，回到上一场；若当时工具做到一半，会从中断处继续（你点停止则不续跑）

发送：**⌘ + Enter**（Windows / Linux 为 Ctrl + Enter）。Enter / ⇧ + Enter 换行，避免误发。

### 模型和快捷问题

设置里三套槽位：

- **文本模型**：摘要、问答、字幕理解
- **多模态模型**：看截图。若就是同一个视觉模型，勾选「与文本模型相同」
- **语音转写（ASR）**：无字幕视频。Whisper 兼容接口，可指向 Groq / OpenAI / SiliconFlow 或本机

文本/多模态：`POST {base_url}/chat/completions`。ASR：`POST {base_url}/audio/transcriptions`。预设里有 OpenAI、SiliconFlow、DeepSeek、Kimi、通义、火山、Ollama、LM Studio 等，也可完全自定义。

快捷问题没有内置芯片。自己在设置里加，或点输入框旁的 **+**。点一下就把那段话发给模型。

回答支持 Markdown 和 Mermaid。链接在新标签打开。

### 和其他扩展

Chrome 不允许扩展随便互调。你机器上目前接得上的只有：

- **Automa**：在当前页跑它的工作流（需要工作流 id / publicId）
- **COSE**：看各平台登录态，按你的要求把 Markdown 同步到掘金 / 知乎等

其它扩展没有对外通道，不会假装能调。

---

## 怎么试

1. 打开 `chrome://extensions`
2. 打开「开发者模式」
3. 「加载已解压的扩展程序」，选仓库里的 `extension/` 目录
4. 点工具栏 PageLens，或快捷键 `Alt+L`
5. 设置里填 `base_url` / `model_name` / `api_key`，点「测试连接」，保存
6. 可选：设置里「选择文件夹」，指定视频文稿的落盘目录

权限：侧栏、存储、脚本注入、标签、标签组、书签、浏览历史、通知、剪贴板、标签页声音（`tabCapture`）、offscreen 文档。加载或升级后若 Chrome 提示权限变更，接受即可。

没有真实 key 时可以跑本地 mock：

```bash
python3 extension/tools/mock_llm.py
```

- base_url: `http://127.0.0.1:18787/v1`
- model_name: `mock-text`（看图用 `mock-vision`）
- api_key: `local`

---

## 它怎么跑（给开发者）

主循环从 [ppeng-agent-core](https://github.com/magele758/ppeng-agent-core) 的 L4 `createAgentLoop` 扣成浏览器版：`prepare → model → tools`，不另起进程、没有 Node daemon。

发给模型前会：

- 修补残缺的 `tool_calls` 序列，避免接口直接 400
- 超长的旧工具结果压缩掉，系统提示和最近几轮保留

工具分两层：

1. **高层语义工具**（Agent 日常该用这些）：抽页、截图、点击填写、列/开/关标签、任务分组、书签、历史、字幕 / 转写视频、文稿文件夹、Automa / COSE 等
2. **`chrome_call` 白名单**：tabs / windows / bookmarks / history / notifications / tts / tabGroups 等已授权 API

不开放：cookies、debugger、downloads、proxy、裸读 `chrome.storage`（密钥在里面）。

密钥、对话、笔记在 `chrome.storage.local`。视频文稿在你选择的本机文件夹里。仓库里没有真实 key。问页时正文发往你配置的模型地址，不经过本项目的后端。

---

## 明确不做

- 后台常驻偷读页面
- 自己去购物、改密码、未授权登录
- 接入 Gmail / Calendar / Drive
- 语音 Live、生成式配图
- Firefox / Safari
- 套官方 Gemini 图标或文案
- 无字幕且无法抽帧的 DRM 视频硬解
- 扫描并调用任意第三方扩展（没有公开接口的调不到）

早期 PRD 把「代填表 / 代浏览」标成非目标。现在的点击和填写是后加的 Agent 能力，且必须用户开口。

---

## 待办

- **给其他 Agent 调用 PageLens（选型后再做）**  
  目标：Grok / Claude Code 等本机 Agent 能用你正在看的 Chrome（读页、字幕、转写、文稿目录），插件不要变重，也不要自己养一个常驻网关。  
  约束：MV3 扩展不能在 `127.0.0.1` 上 listen；IBM 的 ACP 已并进 A2A，不必单独实现。A2A 也要服务端端口，先放着。  
  现状：没有 `nativeMessaging`，没有 MCP / inbox，只能侧栏里用。  
  候选（未拍板）：

  1. 只留在扩展里（`externally_connectable`）— 仅其他扩展 / 网页能调  
  2. 文稿目录 inbox — 零新进程，Agent 写文件、扩展扫目录，秒级延迟  
  3. 扩展当 WebSocket **客户端**，MCP 由对方 Agent 会话里拉起 — 标准工具调用，不算 PageLens 服务  
  4. Chrome **Native Messaging**（Chrome 按需 spawn host）+ 随会话启动的 MCP 小垫片 — 官方 IPC，要登记 host、固定扩展 ID  

  不要做：PageLens 自己常驻 HTTP 网关、公网 A2A、给默认配置文件开 CDP。

---

## 仓库结构

```
extension/          可加载的解压扩展（选这个目录）
  sidepanel/        侧栏 UI
  lib/agent/        循环、工具、压缩与续跑
  skills/           可选的 SKILL.md（默认空，快捷问题在设置里）
  tools/            mock 模型、单测、开发启动脚本
docs/               调研、PRD、交互、技术方案
```

相关文档：

1. [Gemini in Chrome 调研](docs/01-gemini-in-chrome-research.md)
2. [功能 PRD](docs/02-prd.md)（初稿范围，以本 README 的「当前能做」为准）
3. [交互与 UI](docs/03-interaction-ui.md)
4. [技术方案](docs/04-technical-scheme.md)

本地单测：

```bash
node extension/tools/test_loop.mjs
node extension/tools/test_tools.mjs
node extension/tools/test_sessions.mjs
node extension/tools/test_context.mjs
node extension/tools/test_markdown.mjs
node extension/tools/test_companions.mjs
node extension/tools/test_asr.mjs
node extension/tools/test_library.mjs
```
