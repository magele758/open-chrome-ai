# 调用约定与错误码

MCP 垫片替你生成调用 id，并把 bridge 响应转成 MCP 内容：成功时 `result` 是一段 JSON 文本；HTML 等大结果是 resource；截图是 image。失败时 `isError`，正文：

```text
VERIFY_FAILED: 回读与期望不符
提示：…
（可重试）
details: {…}
```

没有「可重试」这行就不要重试。

直连 `~/.pagelens/bridge.sock`（NDJSON）时，请求要自己带 id：

```json
{ "v": 1, "id": "run-001-step3", "tool": "extract_page", "args": { "tabId": 12 }, "timeoutMs": 30000 }
```

`id` 必填，≤128 字符。相同 id 加相同内容，10 分钟内返回缓存响应，不会再执行。相同 id 加不同内容返回 `ID_CONFLICT`。标了可重试的失败不缓存。

`timeoutMs` 默认 30000，上限 120000，含排队。超时只表示应答超时，操作可能仍在执行。

长任务用 `"async": true`，立即得到 `{jobId, status:"running"}`，再用 `job_status`。Service Worker 被回收时，正在跑的任务变成 `status:"interrupted"`：结果未知，先回读页面，再换新 id。

同一标签上的点击、输入、粘贴串行；不同标签可并行。`clipboard_write`、`copy_selection_trusted`、`paste_rich_trusted` 共用一把剪贴板锁。

## 错误码

| code | 可重试 | 含义 |
|---|---|---|
| `DISABLED` | 否 | 网关或桥接开关没开 |
| `PROTOCOL_UNSUPPORTED` | 否 | 请求版本不兼容 |
| `BAD_REQUEST` / `BAD_ARGS` | 否 | 缺字段、未知参数、缺 `tabId` |
| `ID_CONFLICT` | 否 | 同 id 不同内容 |
| `UNKNOWN_TOOL` | 否 | 先 `tools/list` |
| `UNAUTHORIZED` | 否 | token 缺失、错误、过期或已吊销 |
| `SCOPE_DENIED` | 否 | 缺 `details.scope` |
| `TAB_NOT_FOUND` | 否 | 标签不存在 |
| `TAB_RESTRICTED` | 否 | `chrome://` 等受限页 |
| `ORIGIN_NOT_ALLOWED` | 否 | 不在 token origins；`details.origin` 是实际 origin |
| `EGRESS_NOT_ALLOWED` | 否 | 数据会流到 origins ∪ egress 之外 |
| `CONFIRMATION_REQUIRED` | 是 | 不可逆清单；`details.pendingId`。批准后相同参数再调 |
| `CONFIRMATION_REJECTED` | 否 | 用户拒绝了这一次 |
| `TAB_LEASED` | 是 | 另一个会话 `tab_claim` 了这个标签 |
| `DEBUGGER_BUSY` | 是 | `chrome.debugger` 被占用 |
| `TIMEOUT` | 是 | 先回读再决定是否重试 |
| `CLIPBOARD_FAILED` | 是 | 剪贴板三种写法都失败 |
| `NO_EDITOR` | 否 | 没找到或无法聚焦编辑器；看 `details.candidates` |
| `VERIFY_FAILED` | 否 | 回读不通过。不要改用 innerHTML |
| `JOB_NOT_FOUND` | 否 | 任务 id 不存在，或属于别的 token |
| `SETTING_PROTECTED` | 否 | 敏感设置 |
| `PATH_NOT_ALLOWED` | 否 | 上传路径像密钥 |
| `TOOL_FAILED` | 否 | 其他失败，看 message。`details.stale` 时重新快照。`details.reason:"BUSY"` 时委托任务槽满了，可稍后再试 |
| `NEEDS_WIDER_AUTHORIZATION` | 否 | 委托任务里，胶囊外的副作用。扩大 capsule 再发新任务 |

`hello` / `list_tools` 的 `protocol` 主版本不兼容时返回 `PROTOCOL_UNSUPPORTED`。MCP 路径由垫片处理版本，调用方看 `tools/list` 即可。

## Token 的 scope

预设：只读 = `tabs:read` + `page:read`；操作 = 只读 + `tabs:manage` + `page:act` + `clipboard`；完全 = 除 `agent:delegate` 外的全部。`cookies` 只在完全预设里。`agent:delegate` 要单独勾，否则没有 `run_agent_task`。

| scope | 能力 |
|---|---|
| `tabs:read` | `list_tabs` `list_windows` |
| `tabs:manage` | 打开、切换、导航、关闭标签和窗口 |
| `page:read` | 等待、读 DOM、读 HTML、截图、挑编辑器、回读、快照、抽正文 |
| `page:act` | 输入、可信点击和按键、粘贴、选择、滚动、拖拽、对话框 |
| `page:js` | `run_js` |
| `clipboard` | `clipboard_write` `copy_selection_trusted` |
| `downloads` / `upload` | 下载 / 上传 |
| `cookies` | 读写 cookie |
| `settings:read` / `settings:write` | 读 / 改非敏感设置 |
| `agent:delegate` | `run_agent_task` `agent_task_status` `agent_task_cancel` |
| `host:shell` | MCP 垫片里的 `exec_command` |
| `host:fs` | `read_file` `write_file` `list_directory` `scan_skills` |

`exec_command` 在用户的登录环境里跑，超时默认 60 秒，上限 300 秒。它不是浏览器工具。没有 `host:shell` 就不要用它完成页面操作。

origins 用 `https://host`、`http://localhost:*`、`https://*.example.com`。scheme 必须一致。`*` 表示任意 http/https 站点。

出站白名单（egress）是 origins 之外还允许把数据发去的目的地。空着就只允许 origins。

免不可逆清单（`skipIrreversible`）默认关。关着时，发布、删除、上传、改设置、可执行下载、付款页动作会 `CONFIRMATION_REQUIRED`。
