# 工具参数、事件、inbox

工具名以 MCP `tools/list` 为准。下表是参数怎么填。除元工具、`list_tabs` / `open_tab` / `clipboard_write`、窗口、下载、设置类以外，都要 `tabId`。

## 读页面

| 工具 | 参数 |
|---|---|
| `extract_page` | `maxChars?`（默认约 20000），`format?:"markdown"` 时正文在 artifact `page.md`。不抽 PDF 文字层 |
| `read_rendered_html` | `selector`，`removeSelectors?`，`keepClass?`。HTML 在 artifact；`result.stats` 有 chars / tables / imgs |
| `find_in_page` | `query`，`limit?` |
| `get_links` | `limit?` |
| `screenshot` | `fullPage?`，`selector?`。JPEG 以图片内容返回。不切换标签 |
| `query_dom` | 读 DOM，返回须可 JSON 序列化 |

## 动作

| 工具 | 参数 |
|---|---|
| `snapshot_controls` | `limit?`，`textLimit?`，`format?:"text"` 给编号表。ref 在 Service Worker 内存里，导航或 SW 重启后失效 |
| `act_element` | `ref?`，`action`：`click` / `fill` / `select` / `scroll_down` / `scroll_up`，`value?`，`submit?` |
| `select_option` | `selector`，`value`，`nth?` |
| `scroll_page` | `selector?` 或 `percent?` 或 `y?` 或 `direction?`（一屏） |
| `drag_drop` | `from` / `to`：`index`（快照 ref）或 `selector` 或 `text` 或 `x,y` |
| `handle_dialog` | `accept?`，`promptText?`。点击触发对话框时，动作结果里带 `result.dialog` |
| `trusted_click` / `trusted_type` / `press_keys` / `hover` | 目标用 `index` 或 `selector` 或 `text` 或 `x,y`。`press_keys` 的 Meta/Ctrl+A/C/V/X/Z 带原生编辑命令 |
| `set_checks` | 按标签文字批量勾选，真实点击加回读。Doocs 多平台发布用它 |

`reload_tab` / `go_back` / `go_forward` 之后若落地页不在 origins 内，该 `tabId` 上的后续调用返回 `ORIGIN_NOT_ALLOWED`。

`create_window` 默认不抢焦点。`close_window` 要求窗口里每一个标签都在 origins 内。

## 富文本

| 工具 | 要点 |
|---|---|
| `pick_rich_editor` | 排除标题框。候选在 `candidates`，`domIndex` 可钉住同一个编辑器 |
| `wechat_pick_body_editor` | 公众号正文。排除 `.title-editor__input`、`#title`、`[class*=title-editor]` |
| `paste_rich_trusted` | `html` 或 `text` 或 `source:{tabId,selector}` 或 `useClipboard:true`。另有 `titleEquals?` `expect?` `retries?`（上限 3）`settleMs?` `activate?` `includeHtml?`。每次尝试先全选再删除 |
| `verify_editor_content` | `expect?` `{minChars,minTables,minImages,contains[]}`，`titleEquals?`，`titleBefore?`，`includeHtml?`。看 `stats`、`title`、`titlePolluted`、`checks` |
| `copy_selection_trusted` | `selector`。选中后可信复制，再 `paste_rich_trusted {useClipboard:true}` |
| `clipboard_write` | `html?`，`text?`。会覆盖系统剪贴板 |

标题用 `set_input_value`，选择器按站点来（公众号常见 `#title`）。正文选择器改版时，用工具参数里的 `titleSelector` / `editorSelector` / `excludeSelectors` / `preferPlaceholders` 覆盖，不要改粘贴实现。

真实公众号页是否保留表格和外链图片，协议标为未验证。`VERIFY_FAILED` 时停，把 stats 和截图交给用户。

## 下载、上传、设置、cookie

| 工具 | 要点 |
|---|---|
| `download_file` | `url`，`filename?`（下载目录内的相对路径），`timeoutMs?`（默认 30000，最大 120000）。MCP 工具没有 `async` 参数。最终 URL 不在 origins ∪ egress 时取消并返回 `EGRESS_NOT_ALLOWED` |
| `list_downloads` | `query?`，`limit?`。只列出来源在范围内的 |
| `upload_file` | `paths[]`，目标用 `selector` 或 `index` 或 `text`。命中不可逆清单，需侧栏批准一次 |
| `get_settings` / `update_settings` | 敏感键（密钥、`agentTokens`、`agentGatewayEnabled`、`hitlMode` 等）不可写。`update_settings` 的 `changes:[{key,value}]` 含任一敏感键则整批不改 |
| `get_cookies` / `set_cookie` / `remove_cookie` | scope `cookies`，只在「完全」预设里。扩展没拿到 cookies 权限时返回 `TOOL_FAILED`，需要用户在侧栏点一次授权 |

## 事件

网关会话可以订阅。MCP 侧常见形式是 `notifications/message`（`logger:"pagelens"`）。收不到推送就轮询 `events_poll`。

| 工具 | 参数 |
|---|---|
| `events_subscribe` | `types?`：`tab.*` 或 `*`；省略 = token 权限内的全部 |
| `events_unsubscribe` | `types?` |
| `events_poll` | `since?`（上次的 `next`），`max?`（默认 50，最大 200）。`dropped:true` 表示中间事件被挤掉 |

常用类型：`tab.created` `tab.updated` `tab.removed` `tab.activated` `navigation.completed` `download.created` `download.changed` `dialog.opened` `job.progress` `job.done` `agent_task.started` `agent_task.step` `agent_task.approval` `agent_task.finished` `approval.queued` `approval.resolved`。

`approval.resolved` 的 `status` 为 `approved` 或 `rejected`。`approved` 之后用相同工具和参数再调一次。

`dialog.opened` 只在 PageLens 已经挂上调试器的标签上出现。

订阅跟会话走。网关重启后要重新 `events_subscribe`。

## 文件 inbox

MCP 不可用、或要把一句话交给**已经打开的侧栏对话**时用。默认关闭。用户在设置里打开「启用文件 inbox」，并装好 Native Host。

目录：

| 路径 | 作用 |
|---|---|
| `~/.pagelens/agent-inbox/*.json` | 待执行 |
| `~/.pagelens/agent-inbox/processed/` | 已完成副本（token 被写成 `[redacted]`） |
| `~/.pagelens/agent-outbox/<id>.json` | 结果 |
| `~/.pagelens/agent-payloads/` | 大段 HTML |

在 PageLens 仓库根目录：

```bash
node tools/agent-inbox.mjs enqueue --action agent_prompt \
  --prompt-file /tmp/task.txt --tab-url-includes example.com --timeout-ms 300000
node tools/agent-inbox.mjs wait <id> --timeout 300000
node tools/agent-inbox.mjs cancel <id>
```

`agent_prompt` 默认 `runtime:"auto"`：侧栏开着就走侧栏当前会话（和用户打字同一条路），没开就在后台 Service Worker 里跑，不需要人点图标。后台运行无人值守：只访问白名单 / token origins，副作用动作要在 `capsule`（`--capsule-json`，省略则从 prompt 抽取）内，发布等不可逆动作会 `CONFIRMATION_REQUIRED`（除非 token 免清单确认）。`runtime:"panel"` 才会在侧栏没开时返回 `SIDEPANEL_NOT_OPEN`。侧栏正在对话则 `AGENT_BUSY`，不要重试打断（或用 `--runtime headless`）。同一时刻只跑一个，其余排队。解包扩展大约 6 秒轮询一次，商店安装大约 30 秒。

`agent_prompt` 不需要 `agentBridgeEnabled`。`paste_html`、`wechat_fill_draft`、`cose_publish`、`bridge_call` 需要白名单（或 token 的 origins）覆盖目标站点。

无 token 的页面动作会弹确认窗，约 60 秒不点就拒绝。`wait` 的超时给到 90 秒以上。

带 token 时不弹确认窗，scope 不够则 `SCOPE_DENIED`，token 无效则 `UNAUTHORIZED`，不会退回确认窗。

```bash
node tools/agent-inbox.mjs enqueue --action wechat_fill_draft \
  --title '标题' --html-file /tmp/body.html \
  --tab-url-includes 'mp.weixin.qq.com' \
  --token-file ~/.pagelens/agents/<name>.token
```

`wechat_fill_draft` 写标题、可信粘贴正文、核对标题和正文字数，不点发表。outbox 的 `method` 应为 `trusted_paste`。`failCriteria: "insertHTML_only"` 算失败。

`cose_publish` 是发布动作，带 token 时仍可能 `CONFIRMATION_REQUIRED`。用户批准后，重新投递同一 job 正文（`id` 可换）。

## CDP（专用 profile）

日常 Chrome 用 MCP。只有用户明确在用带远程调试端口的专用 profile 时，才用仓库里的 `tools/pl-bridge.mjs`：

```bash
node tools/pl-bridge.mjs hello --port 9222
node tools/pl-bridge.mjs call --tool list_tabs --args '{}'
```

该入口看的是「允许外部 Agent 控制本扩展」开关和 `agentBridgeOrigins`，不看 MCP token。不要在日常 profile 里打开这个开关。
