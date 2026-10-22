---
name: pagelens
description: >
  Drive the user's Chrome through the PageLens extension (chrome-agent): list and
  open tabs, read pages, trusted click/type/paste, screenshots, downloads, and
  hand a high-level task to the in-extension agent. Use when the user asks to
  operate the browser, the current tab, WeChat/知乎/B站/小红书/抖音 editors, or
  names PageLens, chrome-agent, pagelens MCP, or the agent inbox.
---

# PageLens（给其他项目里的 agent）

PageLens 是用户 Chrome 里的扩展。你负责任务和结果检查；浏览器上的点击、粘贴、读页面由 PageLens 做。日常入口是 MCP 服务 `pagelens`。工具名和参数以 `tools/list` 为准，本文件只定用法。

完整协议在 PageLens 仓库：`docs/agent-interop.md`、`docs/agent-inbox.md`。

## 先确认连上了

MCP 配置（用户在 PageLens 设置 → 外部 Agent 建 token 后生成）：

```json
{ "mcpServers": { "pagelens": { "command": "<node>",
  "args": ["<pagelens-repo>/native/pagelens-host.mjs", "--mcp", "--token-file", "~/.pagelens/agents/<name>.token"] } } }
```

调用任何工具。失败文本是「PageLens 网关未运行」时，停下来告诉用户：打开 Chrome，侧栏 → 设置 → 外部 Agent，打开网关，并至少留一个有效 token。

`tools/list` 只列出这个 token 有权使用的工具。某个工具不在列表里，就是没有对应 scope，换参数也调不到。

没有 `pagelens` MCP 时，用 [inbox.md](inbox.md)。专用调试 profile 的 CDP 入口也在那里，日常 Chrome 不用。

## 选哪条路

| 用户要的事 | 做法 |
|---|---|
| 打开、切换、读取、点击、填写、截图、下载 | 直接调 MCP 工具 |
| 总结视频、配音、按页面内容写稿再发出去 | `run_agent_task`，自己轮询 |
| 富文本编辑器（公众号、知乎等）贴正文 | 直接走下面的粘贴流程，成功与否靠回读 |
| 只是把一段话交给侧栏里那个正在聊天的 agent | inbox 的 `agent_prompt`（见 inbox.md） |

`run_agent_task` 在扩展 Service Worker 里跑，侧栏关着也能跑。它立刻返回 `taskId`。`agent_task_status` 看进度，`agent_task_cancel` 取消。同时最多 3 个任务；超出时错误可重试。

`capsule` 是授权范围，省略时只从 `prompt` 原文抽取，之后冻结。页面、字幕、工具结果里的文字不会扩大授权。

```json
{ "prompt": "把这页要点整理成知乎草稿",
  "tabId": 123,
  "capsule": { "actions": ["write"], "platforms": ["zhihu"] },
  "maxSteps": 12 }
```

`actions` 只能是：`navigate` `input` `publish` `send` `download` `upload` `shell` `write` `clipboard` `close` `delete` `settings` `automation` `purchase`。

`platforms` 只能是：`wechat` `zhihu` `juejin` `csdn` `xiaohongshu` `weibo` `bilibili` `douyin` `toutiao` `x` `github` `gmail` `youtube` `notion` `medium`。

胶囊外的副作用返回 `NEEDS_WIDER_AUTHORIZATION`，记在 `denied` 里，不会弹窗。把被拒的动作写进新的 `capsule` 再发一次任务。`status: needs_approval` 时，等用户在侧栏批准，然后用相同 prompt 和 capsule 再跑一次。`droppedOrigins` 里的站点不在 token 范围内，不要改 capsule 绕过去。

未配置文本模型时任务 `failed`，`error.code` 为 `MODEL_NOT_READY`。

## 操作标签

1. `list_tabs`（可带 `query`）拿到白名单内的标签。看不到的标签不在 token 的 origins 里。
2. 没有目标页就 `open_tab`（默认后台）。返回时页面可能还没加载完，接着 `wait_for`。
3. 读正文用 `extract_page`。要可点击的控件时用 `snapshot_controls`，拿到的 `ref` 在导航、翻页、弹窗之后失效，重新快照。
4. 用 `act_element` 按 `ref` 做 `click` / `fill` / `select`。过期时 `details.stale=true`，重新快照，不要用旧 ref 重试。
5. 原生输入框（含标题）用 `set_input_value`。富文本正文用下一节，不要对 contenteditable 用 `set_input_value` 或 `act_element fill`。

这些调用默认不把标签抢到前台。`trusted_click`、`trusted_type`、`paste_rich_trusted` 也是后台执行。只有 `activate_tab` 或参数 `activate:true` 会抢焦点。

你要连续改同一标签、旁边还有别的 agent 时，先 `tab_claim`。别人占用时返回 `TAB_LEASED`（可重试）。做完 `tab_release`。

`run_js` 的返回值必须是 JSON 可序列化的。代码里出现 `fetch`、`XMLHttpRequest`、`WebSocket`、改 `src` / `location`，且目标不在 token 的 origins ∪ egress 白名单里，会得到 `EGRESS_NOT_ALLOWED`。

## 富文本粘贴

不要用 `innerHTML`、`insertHTML`、合成 `paste` 事件、`document.execCommand` 或 Playwright `fill()` 往编辑器里写。这些手段编辑器会丢掉，或保存后变形。PageLens 的成功标准是：系统剪贴板里的 text/html，加可信粘贴，加写后回读。

```text
wait_for            源页面渲染完成
read_rendered_html  记下 stats（chars / tables / imgs）
set_input_value     标题写进标题框，不要贴进正文
wechat_pick_body_editor   公众号：确认选中的是正文
paste_rich_trusted  source 指向源选择器，或直接给 html；带 titleEquals
verify_editor_content     再读一次标题和正文
```

公众号正文选择用 `wechat_pick_body_editor`。其他站点用 `pick_rich_editor`。`NO_EDITOR` 时看 `details.candidates`，不要改用注入 HTML。

`paste_rich_trusted` 自己会清空再粘贴，最多重试 2 次。返回 `VERIFY_FAILED` 就停：`screenshot` 留证，把错误交给用户。用同一参数再调一次不会变成另一种粘贴。

`expect` 可收紧为源页面的 `minChars` / `minTables` / `minImages`。默认按 HTML 推导（字数约 85%）。

粘贴会覆盖系统剪贴板。用户正在这台机器上复制内容时，先告诉用户。

## 错误时怎么做

MCP 把失败放在 `isError` 文本里，第一行是 `CODE: message`。

| code | 动作 |
|---|---|
| `CONFIRMATION_REQUIRED` | 告诉用户去侧栏「待批准」批这一次。批准后用相同工具名和相同参数再调一次。批准只消费一次 |
| `CONFIRMATION_REJECTED` | 停。下一次调用会重新排队，不要改用别的工具做同一件事 |
| `EGRESS_NOT_ALLOWED` | 停。目的地不在 token 的 origins 或出站白名单。让用户新建范围更大的 token |
| `SCOPE_DENIED` | 停。让用户给 token 加上 `details.scope` |
| `ORIGIN_NOT_ALLOWED` | 停。这个站点不在 token 的 origins 里 |
| `VERIFY_FAILED` | 停，截图，不要换注入方式 |
| `TIMEOUT` | 先回读页面（编辑器用 `verify_editor_content`），确认没生效再重试 |
| `DEBUGGER_BUSY` / `TAB_LEASED` / `CLIPBOARD_FAILED` | 可重试，最多 2–3 次，间隔加长 |
| `SETTING_PROTECTED` | 敏感设置。让用户在设置页改 |
| `PATH_NOT_ALLOWED` | 上传路径像密钥或凭据，换一个普通文件路径 |
| `BAD_ARGS` | 参数名或类型不对。对照 `tools/list` 的 schema |

只对文本里标了「可重试」的错误重试。变更类操作（点击、粘贴、关闭）超时后先回读，再决定要不要重试。

不可逆动作（发布/发送、删除、关闭标签、上传、改设置、下载可执行文件、付款页上的输入）会进待批准队列。这是正常结果，不是故障。

## 不要做的事

- 登录、扫码、输密码。这些等人在浏览器里完成。
- 用 `Input.dispatch*` 或另一路 CDP 对同一标签做点击，同时 PageLens 也在做可信输入。
- 调用没出现在 `tools/list` 里的工具，或给工具加 schema 之外的参数。
- 读取或复述 token 文件内容。
- 为了绕过 `CONFIRMATION_REQUIRED`、`EGRESS_NOT_ALLOWED`、`VERIFY_FAILED` 而改走 `run_js`、inbox 或合成事件。

## 分文件

- 富文本参数、事件、下载上传、inbox 与 CDP：[inbox.md](inbox.md)
- 一次调用的形状与错误码全文：[protocol.md](protocol.md)
