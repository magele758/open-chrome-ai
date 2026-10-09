# 安全说明

## 报告漏洞

请不要在公开 issue 里贴漏洞细节。用 GitHub 的 [私密漏洞报告](https://github.com/magele758/open-chrome-ai/security/advisories/new) 提交，写明版本（`extension/manifest.json` 的 `version`）、复现步骤和影响。

只维护 `main` 分支的最新版本。

## 威胁模型

PageLens 是本机运行的解压扩展，没有自己的后端。下面是它信任什么、防什么。

### 信任边界

| 来源 | 信任程度 | 说明 |
|---|---|---|
| 你在侧栏里的输入 | 信任 | 所有 Agent 操作都从这里发起 |
| 网页内容、视频字幕、PDF | **不信任** | 会进入模型上下文，可能含提示注入 |
| 模型输出 | **不信任** | 渲染前经 DOMPurify 清洗；工具调用受授权模式和 HITL 确认约束 |
| 本机进程 | 部分信任 | 能写 `~/.pagelens/agent-inbox/` 或连接 CDP 端口的进程，就能驱动对应入口 |
| 配置的模型 / ASR / TTS / Langfuse 服务 | 你自己选择的 | 页面正文、转写和音频片段会发往这些地址 |

### 页面注入

- 网页可以在正文里写指令诱导模型调用工具。点击、填写、下载、上传、`run_shell` 等特权操作受「安全授权模式」约束：严格模式每次弹窗确认；智能审查（默认）只读直接放行，其余先经 AI 审查，异常才弹窗；全自动模式不弹窗。处理不信任的页面时不要用全自动模式，敏感任务用严格模式。
- 模型输出的 Markdown 只保留白名单标签和属性；不允许 `style` 等可以伪装界面的属性（KaTeX 公式的排版样式除外），链接禁止 `javascript:`、`data:`、`chrome-extension:` 等协议。Mermaid 用 `securityLevel: "strict"` 渲染。

### 本机进程

- **Native Host**（`com.pagelens.host`）：只允许 manifest 里登记的扩展 ID 连接。装好后 Agent 可以用 `run_shell` 在你的登录环境里执行命令，权限等同你本人；不需要时不要安装。
- **文稿目录 inbox**（默认开启，需要 Native Host）：任何能写 `~/.pagelens/agent-inbox/` 的本机进程都可以投递任务。可执行的动作是固定的几种（剪贴板写入、粘贴到编辑器、发文草稿、`bridge_call`），`bridge_call` 还要过 bridge 的开关和白名单。不用时把设置项 `agentInboxEnabled` 设为 `false`，或不安装 Native Host。
- **bridge**（默认关闭）：通过 CDP 调用 Service Worker 的 `__pl.call()`。能连上 Chrome 远程调试端口的进程就能控制浏览器，所以**只在专用 Chrome profile / user-data-dir 里开启**，不要在日常 profile 上开 `--remote-debugging-port`。bridge 每次调用都重新检查开关和 origin 白名单，不暴露 `run_shell`、`upload_file`、下载等高危工具。manifest 没有 `externally_connectable`，网页和其他扩展不能直接调用。细节见 [docs/agent-interop.md](docs/agent-interop.md)。

### 数据与密钥

- API Key、会话和笔记存在 `chrome.storage.local` 与 IndexedDB，未加密。能读你 Chrome profile 目录的程序都能读到它们。
- `chrome_call` 白名单不开放 cookies、debugger、downloads、proxy 和裸读 `chrome.storage`。
- 调试日志会脱敏密钥和请求头，不保存音频，也不会自动上传；导出前仍建议自己看一遍。

### 第三方代码

`extension/vendor/` 下的库是手动拷贝的，版本和来源记录在 [extension/vendor/VERSIONS.json](extension/vendor/VERSIONS.json)，`npm test` 会校验文件内的版本号与清单一致。升级时同步更新清单。
