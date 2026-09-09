# PageLens（暂名）

Chrome 侧栏扩展：读当前网页 / 视频。文本模型和多模态模型分开配置三方 OpenAI 兼容接口。

## 试这个版本

1. 打开 `chrome://extensions`
2. 打开「开发者模式」
3. 「加载已解压的扩展程序」，选仓库里的 `extension/` 目录
4. 点工具栏 PageLens 图标（或 `Alt+L`）打开侧栏
5. 在设置里填模型：

| 字段 | 说明 |
|---|---|
| 预设 | 可先选 OpenAI / SiliconFlow / DeepSeek / Ollama 等，会带上 base_url |
| base_url | 例如 `https://api.openai.com/v1`（不要漏 `/v1`） |
| model_name | 例如 `gpt-4o-mini` / `qwen2.5-vl-72b-instruct` |
| api_key | 供应商密钥 |

文本模型负责摘要和问答。多模态模型负责看截图。若两个是同一个视觉模型，勾选「与文本模型相同」。

点「测试连接」应返回可用。保存后回到对话，打开任意网页直接提问。快捷问题在设置里自己添加，点输入框旁的「+」。

对话会自动保存在本机。侧栏点「历」可按网页回看、搜索、打开续聊，或导出 Markdown / JSON（含当时的页面标题、URL 和全文）。截图只记「含截图」，不把图片字节存进历史。

v0.3 起会申请书签、历史、通知、剪贴板权限（给 Agent 当工具用）。加载已解压扩展后如果 Chrome 提示权限变更，接受即可。

模型回复支持 **Markdown**（标题、列表、表格、代码块）和 **Mermaid** 图。流式输出时先排文字，结束后再画图。

侧栏主循环是从 [ppeng-agent-core](https://github.com/magele758/ppeng-agent-core) L4 `createAgentLoop` 扣出来的浏览器版：`prepare → model → tools`，不另起进程。发给模型前会修补残缺的 tool_calls，并把超长的旧工具结果压缩掉；工具回合会写入 checkpoint，关掉侧栏再打开会从中断处继续（点停止则不续跑）。工具分两层：高层语义工具（抽页、截图、列标签、开/关/切标签、书签、历史、DOM 查询、run_js…）以及 `chrome_call` 白名单（tabs / windows / bookmarks / history / notifications / tts 等已授权 API）。本机已装的 **Automa** / **COSE** 若在当前页注入了公开接口，可用 `automa_execute`、`cose_accounts`、`cose_publish`。其它扩展没有对外通道，调不到。不开放 cookies、debugger、downloads、自动填表。快捷问题在设置里自己添加。

本地没有真实 key 时，可跑 mock：

```bash
python3 extension/tools/mock_llm.py
```

然后设置：

- base_url: `http://127.0.0.1:18787/v1`
- model_name: `mock-text`（多模态可用 `mock-vision`）
- api_key: `local`

## 文档

1. [Gemini in Chrome 调研](docs/01-gemini-in-chrome-research.md)
2. [功能 PRD](docs/02-prd.md)
3. [交互与 UI](docs/03-interaction-ui.md)
4. [技术方案](docs/04-technical-scheme.md)
