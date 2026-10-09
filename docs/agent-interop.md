# 外部 Agent ↔ PageLens 互通规范（协议版本 1）

目标：**外部 Agent 负责任务控制与结果检查，PageLens 只做确定性的浏览器侧执行**（可信点击/复制/粘贴、读取已渲染 HTML、回读校验、截图）。入口不经过扩展内 LLM。

实现位置：`extension/lib/bridge/`（协议 `protocol.js`、白名单 `policy.js`、页面函数 `editor-fns.js`、工具 `tools.js`、分发 `index.js`），剪贴板 `extension/lib/clipboard-sw.js`，参考客户端 `tools/pl-bridge.mjs`。

两种接入方式，工具与请求/响应格式（§3–§10）相同：

| 方式 | 适用 | 鉴权 |
|---|---|---|
| **本机网关 + MCP（§0，推荐）** | 日常 Chrome；Cursor / Claude Code / Codex 等 MCP 客户端、本机脚本 | 每个 Agent 一个 token（scope + origin + 过期 + 吊销），每次调用校验 |
| CDP / 扩展消息 / 文件 inbox（§1–§2） | 专用 profile、e2e | 全局开关 + origin 白名单 |

## 0. 本机网关（日常 Chrome，per-agent token）

```
MCP 客户端 ──stdio──▶ pagelens-host --mcp ──NDJSON──▶ ~/.pagelens/bridge.sock ──▶ pagelens-host（broker）──Native Messaging──▶ 扩展 SW bridge
```

实现：扩展侧 `lib/native-port.js`（`connectNative` 长连接、断线指数退避 1s→60s、每分钟 alarm 唤醒检查）、`lib/bridge/gateway.js`（按设置启停）、`lib/bridge/auth.js` / `token-store.js`（token）、`lib/bridge/audit.js`（持久审计）；本机侧 `native/gateway.mjs`（socket broker 与客户端）、`native/pagelens-host.mjs --mcp`（MCP 垫片）。

### 0.1 开启

1. 装 Native Host：`node native/install-native-host.mjs --extension-id <扩展ID>`（扩展 ID 在 `chrome://extensions`；能自动找到已加载的扩展时可省略）。
2. 侧栏 → 设置 → **外部 Agent**：新建 token（名称、权限预设或勾选 scope、允许的站点、过期时间）。**明文只显示一次**，页面同时给出保存命令。
3. 保存 token 并生成 MCP 配置：
   ```bash
   node native/install-native-host.mjs --save-token cursor        # 从 stdin 粘贴 token → ~/.pagelens/agents/cursor.token（0600）
   node native/install-native-host.mjs --mcp-config cursor        # 打印 Cursor / Claude Code / Codex 配置
   node native/install-native-host.mjs --mcp-config cursor --write-cursor   # 合并进 ~/.cursor/mcp.json
   ```
4. 勾选「启用外部 Agent 网关」。状态行显示「运行中 · socket 路径」即可；关掉开关、或吊销最后一个有效 token，网关立即断开。

MCP 配置（`<node>` 为 node 绝对路径，`<repo>` 为仓库路径；`--mcp-config` 会填好）：

```json
{ "mcpServers": { "pagelens": { "command": "<node>",
  "args": ["<repo>/native/pagelens-host.mjs", "--mcp", "--token-file", "~/.pagelens/agents/cursor.token"] } } }
```

```bash
claude mcp add --scope user pagelens -- <node> <repo>/native/pagelens-host.mjs --mcp --token-file ~/.pagelens/agents/claude.token
```

```toml
[mcp_servers.pagelens]   # ~/.codex/config.toml
command = "<node>"
args = ["<repo>/native/pagelens-host.mjs", "--mcp", "--token-file", "/home/me/.pagelens/agents/codex.token"]
```

token 也可用环境变量 `PAGELENS_TOKEN` 给出；`--agent-name` / `PAGELENS_AGENT_NAME` 设置审计里的显示名；`PAGELENS_SOCKET` 覆盖 socket 路径。不带 token 的 `--mcp` 维持旧行为（只有本机 shell/文件工具，不连网关）。

### 0.2 token

| 字段 | 说明 |
|---|---|
| 格式 | `plk_` + 43 位 base64url（32 字节随机数）。扩展只存 SHA-256（`settings` 之外的 `agentTokens`），丢了只能新建 |
| scope | `tabs:read` `tabs:manage` `page:read` `page:act` `page:js` `clipboard` `downloads` `upload` `settings:read` `settings:write` `agent:delegate` `host:shell` `host:fs`。预设：只读 = `tabs:read,page:read`；操作 = 只读 + `tabs:manage,page:act,clipboard`；完全 = 除 `agent:delegate` 外全部 |
| origins | 与 §1 同样的模式；`*` 表示任意 http/https 站点。会话调用时**替代** `agentBridgeOrigins` |
| egress | 出站白名单（同样的模式，可空）：除 origins 外，数据还允许发往的目的地（如 API 域名）。见 §0.7 |
| skipIrreversible | 免「不可逆动作清单」确认，默认 `false`；只能在设置页新建 token 时勾选（会二次确认），命中时审计记 `optOut` |
| 过期 / 吊销 | 过期或吊销后，已建立的会话下一次调用即返回 `UNAUTHORIZED` |
| 设置隔离 | `agentGatewayEnabled` / `agentTokens` 不出现在扩展内 Agent 的设置工具里，也不能被它修改；只能在设置页改 |

工具所需 scope（每个工具的 `scope` 也会出现在 `list_tools` 里，以那里为准）：

| scope | 工具 |
|---|---|
| `tabs:read` | `list_tabs` `list_windows` |
| `tabs:manage` | `open_tab` `activate_tab` `navigate_tab` `reload_tab` `go_back` `go_forward` `close_tab` `create_window` `focus_window` `close_window` |
| `page:read` | `wait_for` `query_dom` `read_rendered_html` `screenshot` `pick_rich_editor` `wechat_pick_body_editor` `verify_editor_content` `snapshot_controls` `extract_page` `find_in_page` `get_links` |
| `page:act` | `set_input_value` `trusted_click` `trusted_type` `press_keys` `hover` `paste_rich_trusted` `act_element` `select_option` `scroll_page` `drag_drop` `handle_dialog` |
| `page:js` | `run_js` |
| `clipboard` | `clipboard_write` `copy_selection_trusted` |
| `downloads` / `upload` | `download_file` `list_downloads` / `upload_file` |
| `cookies` | `get_cookies` `set_cookie` `remove_cookie`（高危；只在「完全」预设里，不在只读/操作） |
| `settings:read` / `settings:write` | `get_settings` / `update_settings`（`agentTokens`、`agentGatewayEnabled` 等敏感项一律 `SETTING_PROTECTED`） |
| `host:shell` / `host:fs` | MCP 垫片里的本机工具 `exec_command` / `read_file` `write_file` `list_directory` `scan_skills` |

`hello` / `list_tools` / MCP `tools/list` 只返回 token 有权使用的工具。`job_status`、`audit_log` 只看得到本 token 的任务与记录。

### 0.3 socket 协议（直连客户端）

路径：`~/.pagelens/bridge.sock`（目录 0700、socket 0600；Windows 为 `\\.\pipe\pagelens-bridge-<用户名>`）。每行一个 JSON：

```text
→ {"type":"hello","token":"plk_…","agentName":"my-script"}
← {"type":"welcome","sessionId":"s_…","protocol":2,"tools":[…],"agent":{"id":"tok_…","name":"…","scopes":[…],"origins":[…],"expiresAt":null,"state":"active",…}}
→ {"type":"call","callId":"1","request":{"v":1,"id":"run-1","tool":"list_tabs","args":{}}}
← {"type":"result","callId":"1","response":{ …§4 的响应… }}
→ {"type":"ping"}   ← {"type":"pong"}
```

token 错误时返回 `{"type":"error","error":{"code":"UNAUTHORIZED",…}}` 并关闭连接。broker 自己不验证 token，每次调用都交给扩展验证。同一用户再启动一个 broker 会被拒绝（已有活的 socket）；Chrome 断开端口时 broker 退出并删除 socket。单条消息上限 1 MB（Native Messaging 限制）。Node 客户端可直接用 `native/gateway.mjs` 的 `connectGateway({ token })`。

### 0.4 新增错误码

| code | 含义 |
|---|---|
| `UNAUTHORIZED` | token 缺失、错误、过期或已吊销 |
| `SCOPE_DENIED` | token 没有该工具需要的 scope；`details.scope` 给出所需 scope |
| `TAB_LEASED` | 标签被另一个会话 `tab_claim` 占用（见 §0.8）；`details.holder.agentName` 是占用方，可重试 |
| `EGRESS_NOT_ALLOWED` | 数据会流向 token origins ∪ egress 之外的目的地（§0.7）；`details.channel` / `destination` / `origin` 说明通道与目的地。不可重试，需用户新建范围更大的 token |
| `CONFIRMATION_REQUIRED` | 命中不可逆动作清单，已放入待批准队列；`details.pendingId`、`details.item`（清单项）。**可重试**：用户在侧栏批准后，用完全相同的 `tool` + `args` 重试（同 id 或新 id 均可） |
| `CONFIRMATION_REJECTED` | 用户在侧栏拒绝了这次调用（只报告一次；再次调用会重新排队）。不要换别的工具绕过 |

网关未运行时，MCP 工具调用返回 `isError` 文本「PageLens 网关未运行…」，说明需要打开 Chrome 并在设置里启用网关。

### 0.5 审计

每次调用（含旧入口，记为 `legacy`）写入 IndexedDB `pagelens-data` 的 `agentAuditLog`，保留最近 2000 条：时间、Agent、工具、origin、参数摘要、成功/错误码、耗时，以及信任字段：`confirmed`（经用户批准后执行）、`irreversible`（命中的清单项 id）、`optOut`（token 免清单而直接执行）。参数摘要不含正文：字符串只记长度（`selector`、`url` 等定位字段保留且截断，URL 去掉 query/hash），疑似密钥的键记为 `[redacted]`。设置页可查看、导出 JSON、清空。

### 0.6 文件 inbox 带 token

inbox job 可带 `"token":"plk_…"`：校验通过且 scope 足够时**跳过逐次确认**，使用 token 的 origins，审计记为 `inbox.<action>`；但命中不可逆清单（`cose_publish` 属于「发布/发送」；在付款页上的粘贴属于「付款」）且 token 未免清单时，job 结果为 `{ok:false, code:"CONFIRMATION_REQUIRED", pendingId}`，用户在侧栏批准后**重新投递同一 job 正文**（`id` 可换，`token` 不参与匹配）即执行一次；无 token 的旧 job 仍逐次弹窗确认，不进队列。token 无效直接 `UNAUTHORIZED`（不会退回到确认框）。所需 scope：`clipboard_write` → `clipboard`；`paste_html` / `wechat_fill_draft` → `page:act,clipboard`；`cose_publish` → `page:act`；`bridge_call` 走网关会话路径。写入 `processed/` 的副本里 token 记为 `[redacted]`。

### 0.7 token 会话的信任护栏

持 token 的 Agent 直接调用工具 = 委托人本人的动作：不经扩展 LLM、不弹逐次确认。每次调用在 scope / origin 校验之后、工具执行之前（`lib/bridge/trust-guard.js`）再过两道护栏，任何一道都**立即返回**，从不阻塞等待：

1. **出站**（与 `skipIrreversible` 无关，始终生效）。允许的目的地 = token `origins` ∪ `egress`：
   - `navigate_tab` / `open_tab` / `create_window` / `download_file`：URL 带 query / fragment / 凭据 / 超长段（可能夹带数据）且目的地不在范围内 → `EGRESS_NOT_ALLOWED`。不带数据的 URL 仍按 origins 校验（`ORIGIN_NOT_ALLOWED`）。
   - `run_js`：代码里有 `fetch` / `XMLHttpRequest` / `sendBeacon` / `WebSocket` / `*.src=` / `location=` / `form.submit()` 等，且字面 URL 不在范围内，或目的地无法静态确定 → `EGRESS_NOT_ALLOWED`。
   - `set_input_value` / `select_option` / `act_element fill|select` / `trusted_type` / `paste_rich_trusted`：目标标签不在范围内 → `EGRESS_NOT_ALLOWED`。
2. **不可逆动作清单**（设置页的确认清单，用户可关掉某项）。命中且 token 未勾选免清单 → `CONFIRMATION_REQUIRED` + `pendingId`，侧栏授权条出现「待批准」：
   | 清单项 | bridge 调用 |
   |---|---|
   | 发布 / 发送 | `act_element click` / `trusted_click` 目标文字是「发布 / 发表 / 发送 / 提交订单 / Publish / Send …」（文字取自 `text` 参数或 `snapshot_controls` 的 ref 名称）；inbox `cose_publish` |
   | 删除 | `close_tab`、`close_window`；点击「删除 / 清空 / Delete …」类按钮 |
   | 下载可执行文件 | `download_file` 的 URL 或 `filename` 是 exe / dmg / pkg / sh 等 |
   | 上传本机文件 | `upload_file` |
   | 修改设置 | `update_settings` |
   | 付款 / 结账 | 导航到 checkout / pay 类 URL；在此类页面上点击、输入、粘贴、`run_js` |

   工具自己会硬拒绝的调用（敏感设置 → `SETTING_PROTECTED`、敏感上传路径 → `PATH_NOT_ALLOWED`）不进队列。

批准流程：

```text
Agent  → call close_tab {tabId:7}                 ← CONFIRMATION_REQUIRED {pendingId:"pend_…"}
用户   → 侧栏「待批准：close_tab」→ 批准一次
Agent  → 相同 tool + args 重试                     ← ok（审计 confirmed=true；该批准已用掉）
Agent  → 再调一次相同调用                           ← CONFIRMATION_REQUIRED（新 pendingId）
```

- 批准按 token 隔离：别的 token 或侧栏里的扩展内 Agent 的同一调用不能消费它；待批准条目 24 小时过期。
- 用户拒绝后，下一次重试返回 `CONFIRMATION_REJECTED`（一次），之后再调会重新排队。
- `CONFIRMATION_REQUIRED` 是可重试错误：同 id 重试不会命中幂等缓存的旧失败结果。
- 旧入口（CDP `__pl` / 扩展消息 / 无 token 的 inbox）不经过这两道护栏，行为不变。
- 委托（`run_agent_task` / `agent_task_status` / `agent_task_cancel`）本身不在清单里、不进队列；委托任务内部的每一步由扩展内的来源判定（`decideToolCall`）把关，使用同一 token 的 `skipIrreversible` 与出站范围（origins ∪ egress），排队的批准也记为 `token:<id>`，侧栏批准后重跑任务即可执行一次。

### 0.8 事件推送与多会话

实现：`lib/bridge/events.js`（事件总线与过滤）、`lib/bridge/leases.js`（标签租约、按标签分队）、`lib/bridge/jobs.js`（任务持久化）、`lib/bridge/session-tools.js`（会话元工具）。

**订阅**（只对网关会话开放，不需要额外 scope；无 token 的旧入口调用返回 `UNAUTHORIZED`）：

| 工具 | 参数 | 返回 |
|---|---|---|
| `events_subscribe` | `types?: string[]`（支持 `tab.*`、`*`；省略 = token 权限内的全部） | `{types, since, push}`；显式请求了无权类型 → `SCOPE_DENIED` |
| `events_unsubscribe` | `types?`（省略 = 全部） | `{types}` 剩余订阅 |
| `events_poll` | `since?`（上次的 `next`）、`max?`（默认 50，最大 200） | `{events, next, more, dropped, subscribed}`；`dropped=true` 表示环形缓冲（每会话 200 条）挤掉了中间事件 |

事件类型与所需 scope：

| type | scope | 字段 |
|---|---|---|
| `tab.created` / `tab.updated` / `tab.removed` / `tab.activated` | `tabs:read` | `tabId` `windowId` `url` `title`；`tab.updated` 只在 `status=complete` 或 URL 变化时发，带 `status` |
| `navigation.completed` | `tabs:read` | `tabId` `url`（`webNavigation.onCompleted`，只取主 frame） |
| `download.created` / `download.changed` | `downloads` | `downloadId` `url` `finalUrl` `referrer` `filename` `state` `error` … |
| `dialog.opened` | `page:read` | `tabId` `url` `dialogType` `message`（来自 `chrome.debugger`，只在 PageLens 已附加调试器的标签上可见，例如刚用过可信输入） |
| `job.progress` / `job.done` | —（只发给发起任务的同一 token） | `jobId` `tool` `status` / `ok` `code`；工具可通过 `ctx.progress(data)` 报中间进度 |
| `agent_task.started` / `agent_task.step` / `agent_task.approval` / `agent_task.finished` | `agent:delegate`（只发给任务 owner token 的会话） | `taskId` + `task` / `step` / `pendingId toolName reason` / `status answer error`（§15，来自 `onAgentTaskEvent`） |
| `approval.queued` / `approval.resolved` | —（只发给委托人为 `token:<本 token>` 的条目） | `pendingId` `tool` `item` `reason` `taskId?`（委托任务入队时） / `status: approved\|rejected`。直调 `CONFIRMATION_REQUIRED` 与委托任务入队都会发；用户在侧栏批准后收到 `approval.resolved`，即可用相同参数重试，无需轮询 |

每个事件带会话内递增的 `seq` 和 `ts`。**过滤**：标签类事件 URL 在 token origins 内才发；标签从范围内跳到范围外时只发一次 `url:null, title:null, redacted:true`；关闭事件按最后已知 URL 判断（不认识的标签不报）。下载事件 `url`/`referrer` 有一个在范围内才发，范围外的字段置空。每次投递前重新读取 token，吊销或缩小 origin 立即生效。

**推送路径**：扩展 `{type:"bridge.event", sessionId, event}` → broker → 该会话 socket `{"type":"event","event":{…}}`。MCP 垫片收到后发 `notifications/message`（`level:"info"`, `logger:"pagelens"`, `data` = 事件；`logging/setLevel` 设到 `warning` 及以上即静音）；`initialize` 时在 `capabilities.experimental` 声明 `"pagelens/events": {}` 的客户端另收 `notifications/pagelens/event {event}`。垫片的 `initialize` 结果声明 `logging` 与 `experimental["pagelens/events"]` 能力。不支持推送的客户端照常用 `events_poll`。订阅跟会话走：MCP 垫片重连（网关重启）后需重新 `events_subscribe`。

**多会话**：同一 socket 上可以同时有多个客户端，各有自己的 `sessionId`、订阅和缓冲（同一 token 也可以开多个会话）。

- `tab_claim {tabId}`：独占标签（token 需持有 `page:act` / `page:js` / `tabs:manage` / `upload` 之一，标签须在 origin 范围内）。之后其他会话（以及旧的 CDP / runtime 入口）在该标签上调用会改动页面的工具（scope 为 `page:act` `page:js` `tabs:manage` `upload` 的带 `tabId` 工具）得到 `TAB_LEASED`；只读工具不受影响。
- `tab_release {tabId?}`：释放一个或（省略时）本会话全部租约。
- 会话 `open_tab` / `create_window` 打开的标签自动归该会话，并放进一个名为 `Agent: <名称>` 的标签组（`chrome.tabGroups`）。
- socket 断开（broker 发 `bridge.session.closed`）、Chrome 端口断开或标签关闭时租约自动释放。租约只在内存里：SW 重启会断开 Native port，所有会话随之结束。
- 委托运行（`run_agent_task`）里的内部动作同样受租约约束：非只读工具作用的标签被其他会话占用时，该步记为 `blocked`（`TAB_LEASED`）并告知内部 Agent；委托方自己的会话持有或无人持有时放行。
- 独占队列按标签分：不同标签上的可信输入可以并行，同一标签串行；碰剪贴板的工具（`clipboard_write` `copy_selection_trusted` `paste_rich_trusted`）额外占全局剪贴板锁，`activate:true` / 抢焦点的工具占全局焦点锁。

**任务持久化**：`async:true` 的任务写入 `chrome.storage.session`（键 `agentBridgeJobs`，最近 50 个；大于 256 KB 的 artifact 只存元数据，标 `omitted:true`）。SW 被回收后 `job_status` 仍能查到；重启时还在跑的任务变成 `{status:"interrupted", hint}`——结果未知，先回读页面再决定是否换新 id 重试。任务按 token 归属，换会话（同一 token）也能查。

## 1. 安全模型（先读）

| 约束 | 行为 |
|---|---|
| 默认关闭 | `settings.agentBridgeEnabled` 默认 `false`；关闭时 `call` 一律返回 `DISABLED`，`hello()` 不暴露工具 |
| 仅限专用 profile | 只应在**专用 Chrome profile / 专用 user-data-dir** 里开启。扩展无法自证 profile 身份，靠"显式开关 + 你只在专用 profile 里打开"保证；**不要在日常 Chrome 里开启** |
| origin 白名单 | `settings.agentBridgeOrigins`，默认 `localhost:*`、`127.0.0.1:*`、`mp.weixin.qq.com`、知乎专栏、B 站创作中心、小红书创作、抖音创作。白名单之外的标签：`list_tabs` 看不到，任何带 `tabId` 的工具返回 `ORIGIN_NOT_ALLOWED`；`open_tab` 也校验 URL。`chrome://` 等受限页返回 `TAB_RESTRICTED` |
| 每次调用都鉴权 | 每次调用重新读开关与白名单、重新取标签当前 URL（导航后 origin 变了立即失效）；关掉开关即时生效 |
| 按 scope 分级 | 每个工具带 `scope`（`tabs:read` `tabs:manage` `page:read` `page:act` `page:js` `clipboard` `downloads` `upload` `settings:read` `settings:write` `agent:delegate`），见 §10。`run_js` 只在白名单 origin 的标签里可用；不提供 `run_shell` |
| URL 目标 | `open_tab` / `navigate_tab` / `create_window` / `download_file` 的目标 URL 都要在白名单内（`ORIGIN_NOT_ALLOWED`）；`close_window` 要求窗口内**全部**标签在白名单内 |
| 上传硬拒绝 | `upload_file` 对密钥/凭据类路径（`.ssh`、`.aws`、`.gnupg`、`.kube`、`.env*`、`*.pem/*.key/*.p12`、`id_*`、`credentials`、浏览器 `Login Data`/`Cookies`、含 `..` 的路径等）一律返回 `PATH_NOT_ALLOWED`，与 scope 无关 |
| 设置保护 | `get_settings` 不返回敏感项（密钥、服务地址、`hitlMode`、`nativeShell`、`cdpInput`、`agentBridge*`、`agentInbox*` 等，只在 `protected` 列出键名）；`update_settings` 含任一敏感键即整批拒绝（`SETTING_PROTECTED`） |
| 无外部消息通道 | manifest **没有** `externally_connectable`，网页和其他扩展不能直接调用；入口只有下面三种 |
| 审计 | `audit_log` 返回最近 100 次调用（工具、tabId、ok、错误码、耗时，不含参数内容） |

开启（专用 profile 里，侧栏设置勾选"允许外部 Agent 控制本扩展"，或）：

```js
// 在扩展 SW 里执行（chrome://extensions → PageLens → service worker，或 CDP Runtime.evaluate）
const { settings } = await chrome.storage.local.get("settings");
await chrome.storage.local.set({ settings: { ...settings, agentBridgeEnabled: true,
  agentBridgeOrigins: ["http://localhost:*", "https://mp.weixin.qq.com"] } });
```

origin 模式：`https://host`、`http://localhost:*`（任意端口）、`https://*.example.com`（仅子域）。scheme 必须匹配。

## 2. 传输

| 传输 | 用法 | 稳定性 |
|---|---|---|
| **A. CDP → SW `__pl`（推荐）** | 对扩展 Service Worker 目标 `Runtime.evaluate("globalThis.__pl.call({...})", awaitPromise, returnByValue)` | 稳定；CDP 附加期间 SW 不会被回收 |
| B. 扩展内页面消息 | `chrome.runtime.sendMessage({type:"pl.bridge.call", request})` / `{type:"pl.bridge.hello"}`（仅扩展自己的页面，如侧栏、offscreen） | 稳定 |
| C. 文件 inbox | `docs/agent-inbox.md` 的 job：`{"action":"bridge_call","request":{"tool":"...","args":{...}}}`；CLI `node tools/agent-inbox.mjs enqueue --action bridge_call --request-json '{...}'`。结果在 outbox，`ok/error/result/artifacts` 同下文响应 | 依赖 Native Host，≈6s 轮询；与 A/B 共用同一套开关与白名单 |

连接 A 的步骤（参考客户端已封装：`tools/pl-bridge.mjs`，零依赖，Node 22+）：

1. 浏览器带 `--remote-debugging-port=9222 --enable-unsafe-extension-debugging`（本仓库 e2e 在 Chrome 154 带该参数验证；不带的情况未验证）。品牌版 Chrome 不能用 `--load-extension`，已装好的扩展无需处理；首次加载可用 `Extensions.loadUnpacked`（见 `extension/tools/e2e_bridge.mjs`）。
2. `GET /json/version` → 浏览器 WebSocket；`Target.getTargets` 找 `type=service_worker` 且 URL 为 `chrome-extension://<id>/sw.js` 的目标；SW 休眠时目标不存在，客户端会开一个扩展页把它唤醒。
3. `Target.attachToTarget {flatten:true}` 后用返回的 `sessionId` 做 `Runtime.evaluate`。

```js
import { connectBridge } from "./tools/pl-bridge.mjs";
const pl = await connectBridge({ port: 9222 });          // 可选 extensionId
const hello = await pl.hello();
const { result, artifacts } = await pl.call("list_tabs");
```

命令行：`node tools/pl-bridge.mjs hello --port 9222`、`node tools/pl-bridge.mjs call --tool list_tabs --args '{}' --artifacts-dir /tmp/arts`。

## 3. 握手与能力发现

`__pl.hello()`（或工具 `list_tools`）返回：

```json
{ "protocol": 1, "name": "pagelens-bridge", "extensionVersion": "0.12.1", "enabled": true,
  "allowedOrigins": ["http://localhost:*"], "errorCodes": ["DISABLED", "..."],
  "tools": [{ "name": "paste_rich_trusted", "description": "...", "focus": "emulated",
              "needsTab": true, "parameters": { "type": "object", "properties": {}, "required": [] } }] }
```

客户端应检查 `protocol === 1`（主版本不兼容时扩展返回 `PROTOCOL_UNSUPPORTED`）、`enabled === true`、所需工具都在 `tools` 里。`parameters` 是 JSON Schema 子集；**未知参数会被拒绝（`BAD_ARGS`）**，防止拼写错误悄悄失效。

## 4. 请求 / 响应

请求：

```json
{ "v": 1, "id": "run-20261001-001-step3", "tool": "paste_rich_trusted",
  "args": { "tabId": 12, "source": { "tabId": 11, "selector": "#output" }, "titleEquals": "每日 LLM 简报" },
  "timeoutMs": 30000, "async": false }
```

| 字段 | 说明 |
|---|---|
| `id` | 必填，≤128 字符，调用方生成（幂等键） |
| `tool` / `args` | 工具名与参数对象 |
| `timeoutMs` | 默认 30000，上限 120000；含排队时间；超时返回 `TIMEOUT`，**操作可能仍在执行** |
| `async` | `true` 则立即返回 `{jobId, status:"running"}`，用 `job_status` 轮询 |

成功响应：

```json
{ "v": 1, "id": "…", "ok": true, "result": { }, 
  "artifacts": [{ "name": "rendered.html", "mime": "text/html", "encoding": "utf8", "size": 13134, "data": "<div>…" }],
  "meta": { "tool": "read_rendered_html", "tabId": 11, "ms": 6, "focus": "none", "replayed": false } }
```

失败响应：

```json
{ "v": 1, "id": "…", "ok": false,
  "error": { "code": "VERIFY_FAILED", "message": "…", "retryable": false, "hint": "…", "details": { "attempts": [], "verify": {} } },
  "meta": { } }
```

`artifacts`：大体积数据（HTML、截图）不放进 `result`。`encoding` 为 `utf8` 或 `base64`。

## 5. 同步调用与长任务

- 默认同步：`await __pl.call(req)`，通常 <2s；`paste_rich_trusted` 含重试最坏约 `(settleMs+1s)×尝试次数`。
- 长任务：`async:true` → `{ok:true,result:{jobId:<id>,status:"running"}}`；轮询 `job_status {jobId}` → `{status:"running"}`、`{status:"done", response:{…最终响应…}}` 或 `{status:"interrupted"}`（SW 重启打断）。任务持久化在 `chrome.storage.session`（§0.8）；网关会话还可以订阅 `job.progress` / `job.done` 事件代替轮询。
- 键鼠类工具（`exclusive`）**按标签串行**：同一标签不会交错，不同标签可以并行；剪贴板是全局资源，碰剪贴板的工具全局串行（§0.8）。

## 6. 错误码

| code | retryable | 含义 / 处理 |
|---|---|---|
| `DISABLED` | 否 | 开关未开 |
| `PROTOCOL_UNSUPPORTED` | 否 | `v` 不兼容 |
| `BAD_REQUEST` / `BAD_ARGS` | 否 | 请求或参数不合法（含未知参数、缺 `tabId`） |
| `ID_CONFLICT` | 否 | 同 id 但内容不同，换新 id |
| `UNKNOWN_TOOL` | 否 | 先 `list_tools` |
| `TAB_NOT_FOUND` / `TAB_RESTRICTED` | 否 | 标签不存在 / 受限页 |
| `ORIGIN_NOT_ALLOWED` | 否 | 不在白名单；`details.origin` 给出实际 origin |
| `DEBUGGER_BUSY` | **是** | `chrome.debugger` 已被其他调试器占用（见 §9），扩展已自动重试一次仍失败 |
| `TIMEOUT` | **是** | 超时；重试前先 `verify_editor_content` |
| `NO_EDITOR` | 否 | 没找到/无法聚焦编辑器；`details.candidates` 看候选 |
| `CLIPBOARD_FAILED` | **是** | 三种剪贴板写入方式全失败，`details` 列出每种的错误 |
| `VERIFY_FAILED` | 否 | 回读校验不通过（已按重试上限停止）；**不要**换 innerHTML 之类手段兜底 |
| `JOB_NOT_FOUND` | 否 | `job_status` 找不到 |
| `TAB_LEASED` | **是** | 标签被另一个网关会话 `tab_claim` 占用；换标签或等对方释放（§0.8） |
| `TOOL_FAILED` | 否 | 其他工具失败，见 `message`；`act_element` 目标过期时 `details.stale=true`，重新 `snapshot_controls` |
| `SETTING_PROTECTED` | 否 | `update_settings` 触及敏感设置；`details.keys` 列出键名，需用户在设置页手动改 |
| `PATH_NOT_ALLOWED` | 否 | `upload_file` 含敏感本机路径；`details.paths` 列出被拒路径 |
| `UNAUTHORIZED` / `SCOPE_DENIED` | 否 | token 会话：见 §0.4 |
| `EGRESS_NOT_ALLOWED` | 否 | token 会话：目的地不在 token origins ∪ egress（§0.7） |
| `CONFIRMATION_REQUIRED` | **是** | token 会话：命中不可逆清单，`details.pendingId`；用户在侧栏批准后用相同参数重试（§0.7） |
| `CONFIRMATION_REJECTED` | 否 | token 会话：用户拒绝了该调用 |

## 7. 幂等与重试约定

- 相同 `id` + 相同内容：10 分钟内重放返回**缓存的原响应**（`meta.replayed:true`），不会再执行（避免重复粘贴/点击）。
- 相同 `id` + 不同内容：`ID_CONFLICT`。
- **`retryable:true` 的失败不缓存**：同 id 重发会重新执行。
- 外部 Agent 的重试策略：只对 `retryable` 错误重试，最多 2–3 次、指数退避；`VERIFY_FAILED` 不重发同一请求，由外部 Agent 决策（截图、人工介入）。`paste_rich_trusted` 内部自带"清空 → 粘贴 → 校验"循环（`retries` 默认 2，上限 3），每次尝试前先 Meta/Ctrl+A、Backspace 清空编辑器，所以重试幂等，旧内容不会让校验假通过。
- 变更类工具（点击、粘贴）超时后不要盲目重发：先回读。

## 8. 焦点策略

| 级别 | 工具 | 说明 |
|---|---|---|
| `none` | `list_tabs`、`open_tab`（默认 `active:false`）、`create_window`（默认 `focused:false`）、页面读取/`act_element`/`select_option`/`scroll_page`、`wait_for`、`query_dom`、`run_js`、`read_rendered_html`、`screenshot`、`clipboard_write`、`set_input_value`、`pick_rich_editor`/`wechat_pick_body_editor`、`verify_editor_content` | 不切标签、不动窗口焦点（`pick`/`prepare` 会在**页面内** `focus()` 编辑器） |
| `emulated` | `trusted_click`、`trusted_type`、`press_keys`、`hover`、`drag_drop`、`upload_file`、`copy_selection_trusted`、`paste_rich_trusted` | 调用 `Emulation.setFocusEmulationEnabled`，页面认为自己有焦点，**不抢窗口/标签焦点**。e2e 实测：后台标签里可信粘贴成功，标签保持 `active:false`。传 `activate:true` 才会切到前台 |
| `activates` | `activate_tab`、`focus_window`、任何传了 `activate:true` 的调用 | 会把标签切到前台（抢焦点） |

注意：可信粘贴/复制走**系统剪贴板**，会覆盖用户剪贴板（专用 profile 的无人值守场景可接受；有人在用这台机器时不要跑）。

## 9. chrome.debugger 与外部 CDP 共存

- 可信输入、截图用 `chrome.debugger`，附加期间 Chrome 显示"正在调试此浏览器"横幅；空闲 20s 自动分离。
- 外部 CDP 客户端（9222）与 `chrome.debugger` 可以**同时**附加同一标签：e2e 里外部客户端附加编辑页后，扩展照常可信粘贴，外部客户端也照常评估（已验证）。
- 真正的 `Another debugger is already attached` 通常来自其他扩展的 `chrome.debugger`。策略：附加失败 → 等 500ms 重试**一次** → 仍失败返回 `DEBUGGER_BUSY`（`retryable:true`，`hint` 说明）。该分支只有 mock 测试覆盖，无法在 e2e 里稳定复现。
- 建议：不要让外部 Agent 同时用 `Input.dispatch*` 与本扩展的可信输入操作同一标签，会互相打断焦点/选区。

## 10. 工具参考

通用：除元工具、`list_tabs/open_tab/clipboard_write`、窗口/下载/设置类工具外都需 `tabId`。scope 列出每个工具所需权限（供 per-agent token 鉴权使用；CDP `__pl` 入口目前仍只看开关 + 白名单）。

| 工具 | scope | 作用 | 要点 |
|---|---|---|---|
| `list_tabs {query?}` | tabs:read | 白名单内的标签 | 仅返回允许的 origin |
| `list_windows {}` | tabs:read | 窗口 + 其中白名单内的标签 | 白名单外的标签只给 `hiddenTabs` 计数 |
| `open_tab {url, active?}` | tabs:manage | 新开标签 | 默认后台；URL 需在白名单；返回的标签尚未加载完时，后续带 `tabId` 的调用会等它提交 URL（≤4s），页面元素仍应用 `wait_for` |
| `activate_tab {tabId}` | tabs:manage | 切前台 | 抢焦点 |
| `navigate_tab {tabId, url}` | tabs:manage | 标签跳转 | 当前页与目标 URL 都要在白名单 |
| `reload_tab` / `go_back` / `go_forward {tabId}` | tabs:manage | 刷新 / 后退 / 前进 | 后退/前进的落地页若不在白名单，之后带该 `tabId` 的调用返回 `ORIGIN_NOT_ALLOWED` |
| `close_tab {tabId}` | tabs:manage | 关标签 | 只能关白名单内的标签 |
| `create_window {url, focused?, state?, width?, height?}` | tabs:manage | 新窗口 | URL 需在白名单；默认不抢焦点（`state:"maximized"` 时 Chrome 要求聚焦） |
| `focus_window {windowId}` | tabs:manage | 窗口切前台 | 窗口里需至少一个白名单标签 |
| `close_window {windowId}` | tabs:manage | 关窗口 | 窗口内全部标签都要在白名单内 |
| `snapshot_controls {tabId, limit?, textLimit?, format?}` | page:read | 视口内可操作控件快照（含 shadow DOM、iframe），每项带 `ref` | `format:"text"` 额外给编号表；导航/翻页/弹窗后 ref 失效，需重新快照 |
| `extract_page {tabId, maxChars?, format?}` | page:read | 干净正文 | 默认 20000 字；`format:"markdown"` 时正文在 artifact `page.md`；不拉取 PDF 文字层 |
| `find_in_page {tabId, query, limit?}` / `get_links {tabId, limit?}` | page:read | 页内搜索 / 链接列表 | |
| `act_element {tabId, ref?, action, value?, submit?}` | page:act | 按快照 ref 操作：`click`/`fill`/`select`/`scroll_down`/`scroll_up` | 页面内合成事件；过期返回 `TOOL_FAILED` + `details.stale` |
| `select_option {tabId, selector, value, nth?}` | page:act | `<select>` 选项 | 顶层找不到会探测 iframe |
| `scroll_page {tabId, selector? / percent? / y? / direction?}` | page:act | 滚动 | `direction` 为一屏 |
| `drag_drop {tabId, from, to}` | page:act | 可信拖拽 | `from`/`to` 各用 `index`（快照 ref）/`selector`/`text`/`x,y` |
| `handle_dialog {tabId, accept?, promptText?}` | page:act | 处理 alert/confirm/prompt/beforeunload | 页面动作触发对话框时，`act_element`/`select_option`/`drag_drop`/`upload_file` 立即返回 `result.dialog`，不再卡住 |
| `download_file {url, filename?, timeoutMs?}` | downloads | 下载到下载目录，返回本机路径 | URL 需在白名单；大文件用 `async:true`；重定向后的最终 URL 若不在允许的目的地（token 的 origins ∪ 出站白名单）内，取消下载并返回 `EGRESS_NOT_ALLOWED` |
| `list_downloads {query?, limit?}` | downloads | 最近下载 | 只列来源在白名单内的 |
| `upload_file {tabId, selector / index / text, paths[]}` | upload | 把本机文件交给页面 | `<input type=file>` 直接设；自定义按钮接管文件选择框；敏感路径 `PATH_NOT_ALLOWED` |
| `get_settings {}` | settings:read | 非敏感设置及允许值 | 敏感项只在 `protected` 列键名 |
| `update_settings {changes:[{key,value}]}` | settings:write | 改非敏感设置 | 不弹窗；任一敏感键 → `SETTING_PROTECTED`，整批不改 |
| `wait_for {tabId, selector? , text?, timeoutMs?}` | page:read | 页面内轮询 | 超时 `TIMEOUT` |
| `query_dom` / `run_js` | page:read / page:js | 读 DOM / 执行 JS | `run_js` 需 JSON 可序列化返回 |
| `read_rendered_html {tabId, selector, removeSelectors?, keepClass?}` | page:read | 读已渲染 HTML，**用 getComputedStyle 内联样式**，转绝对链接，去 script/style/id/data-* | HTML 在 `artifacts[0]`；`result.stats` 有字数/table/img |
| `screenshot {tabId, fullPage?, selector?}` | page:read | JPEG artifact（base64） | 走调试器，不切标签 |
| `clipboard_write {html?, text?}` | clipboard | 写剪贴板（html+plain） | 方式依次：offscreen `execCommand("copy")`（不需文档焦点，e2e 实测可用）→ offscreen Clipboard API → Native Host(macOS)；offscreen 被配音占用时不抢占 |
| `set_input_value {tabId, selector, value}` | page:act | 原生 setter 写 input/textarea 并派发 input/change | 回读不一致 → `VERIFY_FAILED`；**标题用它** |
| `trusted_click` / `trusted_type` / `press_keys` / `hover` | page:act | 即现有 CDP 可信输入工具 | 目标用 `index`（`snapshot_controls` 的 ref）/`selector`/`text`/`x,y`；`press_keys` 的 `Meta/Ctrl+A/C/V/X/Z` 带原生编辑命令 |
| `pick_rich_editor` / `wechat_pick_body_editor` | page:read | 挑正文编辑器 | 排除 `.title-editor__input`、`#title`、`[class*=title-editor]`；优先占位文案"从这里开始写正文"；候选打分在 `candidates`；返回 `domIndex` 可钉住同一编辑器 |
| `verify_editor_content {tabId, expect?, titleEquals?, titleBefore?, includeHtml?}` | page:read | 回读校验 | `stats`（chars/tables/imgs/paragraphs/headings/links）、`title`、`titlePolluted`、`checks[]`；`expect:{minChars,minTables,minImages,contains[]}` |
| `copy_selection_trusted {tabId, selector}` | clipboard | 选中元素内容 + 可信 Meta/Ctrl+C | Chrome 自己序列化（带内联样式），随后 `paste_rich_trusted {useClipboard:true}` |
| `paste_rich_trusted {tabId, html? / text? / source{tabId,selector} / useClipboard, titleEquals?, expect?, retries?, settleMs?, activate?, includeHtml?}` | page:act | 写剪贴板 → 点击聚焦 → 全选+清空 → 可信粘贴 → 回读校验 → 重试 | 默认从 `html` 推导断言：`minChars=85%`、`minTables`、`minImages`，可用 `expect` 覆盖；标题不得被污染或变化；失败 `VERIFY_FAILED`，**无 DataTransfer/innerHTML 兜底** |
| `run_agent_task {prompt, capsule?, tabId?, maxSteps?, model?}` | agent:delegate | 把高层任务交给扩展内 Agent 在后台跑，立即返回 `taskId` | 见 §15；胶囊外副作用 `NEEDS_WIDER_AUTHORIZATION`，不可逆动作 `CONFIRMATION_REQUIRED` + `pendingId` |
| `agent_task_status {taskId, sinceStep?}` | agent:delegate | 任务状态、步骤、最终回答 | `sinceStep` 做增量轮询 |
| `agent_task_cancel {taskId}` | agent:delegate | 取消任务 | 已结束的返回 `alreadyFinished:true` |
| `job_status` / `audit_log` / `list_tools` | — | 元工具 | |
| `events_subscribe` / `events_unsubscribe` / `events_poll` / `tab_claim` / `tab_release` | —（仅网关会话） | 事件订阅、标签租约 | 见 §0.8 |

## 11. 参考 recipe：把 Doocs 简报写入微信公众号编辑器

前提：专用 profile 已由**人**登录公众号并打开"新建图文"编辑页（登录/扫码不由 Agent 处理）；白名单含 `localhost:*` 与 `mp.weixin.qq.com`。

```js
const pl = await connectBridge({ port: 9222 });
const hello = await pl.hello();                                  // 0. 握手：enabled、tools
const tabs = (await pl.call("list_tabs")).result;
const doocs = tabs.find((t) => t.url.startsWith("http://localhost:8080")).id;
let wx = tabs.find((t) => t.url.startsWith("https://mp.weixin.qq.com"))?.id
      ?? (await pl.call("open_tab", { url: "https://mp.weixin.qq.com/" })).result.tabId;

// 1. Doocs 页：确认渲染完成（选择器以实际页面为准，Doocs 预览区通常为 #output）
await pl.call("wait_for", { tabId: doocs, selector: "#output" });
const probe = (await pl.call("read_rendered_html", { tabId: doocs, selector: "#output" })).result.stats;
//    probe.{chars,tables,imgs} 即期望值，可记录到任务日志

// 2. 标题：原生 setter 单独写（不要往 ProseMirror 里贴标题）
await pl.call("set_input_value", { tabId: wx, selector: "#title", value: title });

// 3. 干跑：确认选中的是正文而不是标题编辑器
const pick = (await pl.call("wechat_pick_body_editor", { tabId: wx })).result;
//    pick.reasons 应含 "placeholder"；否则停下来看 pick.candidates

// 4. 可信粘贴（内部：写剪贴板 → 点击聚焦 → Meta+A/Backspace → Meta+V → 回读 → 最多重试 2 次）
const paste = await pl.callRaw("paste_rich_trusted", {
  tabId: wx, source: { tabId: doocs, selector: "#output" }, titleEquals: title,
  // expect 缺省按来源推导；可显式加严：{ minChars: probe.chars * 0.9, minTables: probe.tables, minImages: probe.imgs }
});
if (!paste.ok) {                      // 5. 失败：最多重试 2-3 次后停止，保留现场
  await pl.call("screenshot", { tabId: wx });   // 取证；不要换 innerHTML / 合成 paste
  throw new Error(`${paste.error.code}: ${paste.error.message}`);
}
// 6. 独立复核（可选但推荐）：与"粘贴内部校验"不同时刻再读一次
const v = (await pl.call("verify_editor_content", { tabId: wx, titleEquals: title,
  expect: { minTables: probe.tables, minImages: probe.imgs } })).result;
// 7. 存草稿：只点"保存为草稿"，不点"发表"
await pl.call("trusted_click", { tabId: wx, text: "保存为草稿" });
```

备选路线（想让 Chrome 自己序列化样式）：`copy_selection_trusted {tabId: doocs, selector:"#output"}` → `paste_rich_trusted {tabId: wx, useClipboard:true, expect:{…}}`。e2e fixture 里两条路线都保留了标题色、表格边框、链接。

注意：`#title`、`.title-editor__input`、"保存为草稿"文案沿用了现有 inbox/COSE 的假设，**未对真实微信页验证**；页面改版时通过 `titleSelector`、`editorSelector`、`excludeSelectors`、`preferPlaceholders` 覆盖。

## 12. 已知失败手段（黑名单）

以下做法已被证明不可靠，外部 Agent 与本扩展都**不要**用来"兜底成功"：

1. `innerHTML` / `insertHTML` / `execCommand` 硬塞：绕过编辑器模型，状态不同步，保存后丢失或结构被破坏。
2. 合成 `paste` 事件（`DataTransfer` + `ClipboardEvent`）：`isTrusted=false`，ProseMirror 类编辑器可忽略（fixture 里已演示被忽略）。
3. `navigator.clipboard.write` + 页面里合成 Ctrl+V：按键不是可信事件，不触发原生粘贴命令。
4. Playwright `fill()` 直接写富文本：对 contenteditable/ProseMirror 不触发正确的 beforeinput/transaction。
5. Peekaboo / OS 级粘贴：依赖真实窗口焦点，不稳定且会误伤其他应用。

正确路径：**可信键盘事件（CDP `Input.dispatchKeyEvent` 带 `commands:["paste"]`）+ 系统剪贴板里的 text/html**，并且**写后回读校验**。

## 13. 已知限制 / 未验证

- 可信粘贴在**真实微信公众号编辑页**是否保留版式、表格、图片（含外链图片转存/CDN 域限制）未验证；e2e 只在本地 ProseMirror 类 fixture 里验证（fixture 对粘贴做了 `isTrusted` 校验和白名单化）。
- 微信选择器与文案（见 §11）未对真实页验证；知乎/B 站/小红书/抖音的编辑器未验证。
- `DEBUGGER_BUSY` 的真实"已被占用"场景只有 mock 测试。
- 剪贴板被覆盖；非 macOS 上 Native Host 兜底不可用（前两种 offscreen 方式不受影响）。
- 仅支持顶层 frame 的编辑器（iframe 内的编辑器未处理）。
- 任务表持久化在 `chrome.storage.session`：浏览器重启会清空；SW 重启时正在执行的任务只能标 `interrupted`，不会续跑。
- `dialog.opened` 事件只在 PageLens 已附加 `chrome.debugger` 的标签上产生；其他标签的对话框不可见。
- cookie 工具（`get_cookies` / `set_cookie` / `remove_cookie`）需要 `cookies` 权限和单独的高危 scope `cookies`。`chrome_call` 仍不开放 `cookies.*`。`cookies` 是可选权限，侧栏里第一次用 cookie 工具时由 `acquireCookiesApi` 申请；外部 Agent 经 bridge 调用不会弹授权，未授权时返回 `TOOL_FAILED`。
- `snapshot_controls` 的 ref 存在 SW 内存里，按标签保存最近一次快照；SW 重启或导航后需重新快照。

## 14. 测试

```bash
node extension/tools/test_bridge_protocol.mjs   # 协议、白名单、幂等、超时、async、错误码
node extension/tools/test_bridge_editor.mjs     # jsdom：挑编辑器、回读校验、样式内联、原生 setter
node extension/tools/test_bridge_paste.mjs      # paste_rich_trusted 流程（mock CDP）：顺序、重试、不兜底、焦点
node extension/tools/test_bridge_browser_tools.mjs  # 标签/窗口、快照 ref、对话框、下载、上传敏感路径、受保护设置
node extension/tools/test_bridge_events.mjs     # 事件过滤/缓冲/订阅、租约、按标签并行队列、job 持久化与 interrupted
node native/test_gateway.mjs                    # broker + MCP 垫片：事件帧转发、MCP 通知、两个并发会话与租约
node extension/tools/test_clipboard_sw.mjs      # 剪贴板三种方式的降级与 offscreen 让位
node extension/tools/test_agent_delegate.mjs    # 委托：胶囊校验、胶囊内自动执行、胶囊外拒绝、不可逆进队列、取消、持久化、事件、数据指令不扩权
node extension/tools/test_delegate_panel.mjs    # jsdom：侧栏委托任务列表与取消
node extension/tools/e2e_bridge.mjs             # 真浏览器冒烟（专用临时 profile，见脚本头注释）
```

`extension/tools/test_*` 由 `npm test` 自动收录，`native/test_gateway.mjs` 单独运行；`e2e_bridge.mjs` / `e2e_gateway.mjs` 不属于 `run-tests`，需要本机有 Chrome。

网关：

```bash
node extension/tools/test_agent_gateway.mjs   # token / scope / origin、会话调用、审计脱敏与上限、native port（npm test 收录）
node native/test_gateway.mjs                  # host 作为 broker：socket 0600、MCP 垫片、吊销、Chrome 断开后退出、安装器（CI 收录）
CHROME_BIN=/usr/bin/google-chrome-stable node extension/tools/e2e_gateway.mjs   # 真 Chrome：设置页建 token → MCP 调用 → 审计 → 吊销
```

## 15. 委托扩展内 Agent（run_agent_task，scope `agent:delegate`）

外部 Agent 也可以不逐步调用确定性工具，而是把**高层任务**交给 PageLens 内部的 LLM Agent（例如"总结这个视频并配音"、"把这页要点整理后发到知乎草稿"），自己只轮询进度与结果。实现：`extension/lib/agent/delegate.js`（任务管理、信任判定、持久化、事件）、`delegate-sw.js`（SW 运行环境）、`extension/lib/bridge/tools-delegate.js`（bridge 工具）。

### 15.1 运行位置

任务在扩展 **Service Worker** 里跑（与侧栏无关，侧栏关着也能跑），复用侧栏同一套内部工具（`createAgentTools`）、loop 内核（`loop-kernel.js`）和文本模型设置。不占用 offscreen 文档（同传/剪贴板仍可用）。运行中每 20s 调一次扩展 API 保活。

已知差异：SW 里没有 DOM，PDF 文字层抽取（pdf.js 动态加载）不可用，会退回网页正文；需要侧栏页面能力的工具（截图预览、转写进度展示等）只返回结果、不渲染。

### 15.2 调用

```js
await __pl.call({ v: 1, id: "t1", tool: "run_agent_task", args: {
  prompt: "总结这个视频，并发布一条摘要到知乎",
  tabId: 123,                       // 省略：当前窗口活动标签（需在可访问 origin 内，否则不指定标签）
  capsule: { actions: ["publish"], platforms: ["zhihu"] },   // 可选；省略时只从 prompt 原文抽取
  maxSteps: 12,                     // 模型轮次上限，1–40
}});
// → { taskId, status:"running", tabId, capsule, capsuleSource:"explicit"|"prompt", capsuleSummary[], droppedOrigins[], maxSteps }

await __pl.call({ v: 1, id: "t2", tool: "agent_task_status", args: { taskId, sinceStep: 0 } });
// → { id, status, agentName, prompt, capsule, capsuleSummary, taint, steps:[{n, kind, name, ok, code, pendingId, summary, at}],
//     stepCount, answer, pending:[{pendingId, toolName, reason, approval}], denied:[{toolName, code, reason}], error, endReason, ... }

await __pl.call({ v: 1, id: "t3", tool: "agent_task_cancel", args: { taskId } });
```

`status`：`running` → `done` | `needs_approval` | `failed` | `cancelled`。`steps[].kind`：`tool`（工具执行，`ok`）、`blocked`（被信任判定拦下，`code` / `pendingId`）、`answer`（模型输出）、`note`（使用了已批准的待办、检测到注入等）。用 `sinceStep` = 上次拿到的最大 `n` 做增量轮询。`run_agent_task` 本身立即返回，不需要 `async:true`。同时最多 3 个任务在跑，超出返回 `TOOL_FAILED`（`retryable:true`，`details.reason:"BUSY"`）；未知任务 `JOB_NOT_FOUND`；未配置文本模型时任务 `failed`，`error.code:"MODEL_NOT_READY"`。

### 15.3 授权：意图胶囊 + 无人值守判定

- **胶囊只来自委托人**：显式 `capsule` 经 `normalizeCapsule` 校验（未知动作/平台、非法 URL、含 `..` 的路径丢弃，`principal:"agent"`）；省略时 `extractCapsule(prompt)`。任务开始后胶囊**冻结**，页面、字幕、工具结果里的任何文字都不会并入胶囊。
- **不越权**：胶囊里的站点必须在调用方可访问的 origin 范围内（token 会话为 token 的 `origins`；无 token 的旧入口为 `agentBridgeOrigins`），范围外的站点丢弃并在 `droppedOrigins` 回报（`www.` 与裸域等价）；只剩被丢弃域名的平台一并去掉。运行中每个带目标 URL 的调用（导航、标签操作、下载）还会再按同一范围硬校验，范围外返回 `ORIGIN_NOT_ALLOWED`（胶囊域名覆盖子域，这一步防止借子域越出 token 范围）。任务标签同样要在范围内。
- 每个工具调用走 P4 的 `decideToolCall`，`attended:false`（`hitlMode` 取设置里的严格/智能审查，全自动不适用于委托任务）：
  - 胶囊内 → 自动执行（即使会话已读入数据甚至被标为高污染）；只读 → 执行。
  - 胶囊外的副作用 → 拒绝，工具结果为 `{ok:false, code:"NEEDS_WIDER_AUTHORIZATION", reason, hint}`，记入 `denied`；出站到未声明目的地 → `EGRESS_NOT_ALLOWED`；**不会弹窗、不会挂起**。
  - 命中用户的**不可逆清单** → 进待批准队列（与侧栏共用 `chrome.storage.local.agentApprovalQueue`），工具结果 `CONFIRMATION_REQUIRED` + `pendingId`；任务结束时状态为 `needs_approval`，`pending[].approval` 实时反映 `pending/approved/rejected`。用户在侧栏「待批准」里批准后，**同一调用（工具 + 参数一致）**下次可执行一次：委托人重新发起任务（或在 P1 后的会话里重试同一动作）即可。
  - 改设置：委托任务没有确认通道，`update_settings` 一律不生效（且在不可逆清单里）。
- 内部模型看到的系统提示写明了委托人、授权范围和"被拦下不要绕过、在最终回答里说明"。

### 15.4 侧栏

侧栏输入框上方显示"🤖 外部委托任务"：来源 Agent 名（`ctx.session.agentName`）、状态、prompt、授权范围、最近步骤；运行中的任务可「取消」。待批准的操作出现在授权条的「待批准」里。

### 15.5 持久化

任务存在 `chrome.storage.session` 的 `agentDelegateTasks`（保留最近 30 个，每个最多 200 步，摘要截断）。SW 重启后状态仍可查询；当时还在跑的任务标为 `failed`，`error.code:"INTERRUPTED"`，已完成的步骤保留。浏览器重启后清空。

### 15.6 集成钩子（P1 / P3）

- **P1 会话（已接入）**：token 路径上 bridge 先按工具 `scope` 校验（无 `agent:delegate` → `SCOPE_DENIED`，`list_tools` 里也看不到这三个工具），再把 `ctx.session = { agentId, agentName, sessionId, tokenId, egress[], skipIrreversible }` 交给工具。`agentName` 取 **token 名**（不信客户端自报），显示在侧栏与待批准条目（`principal:"agent:<name>"`）；`tokenId` 作为任务 owner，带 owner 的任务对其他 token 的 `agent_task_status/cancel` 不可见（`JOB_NOT_FOUND`；无会话的旧入口仍可见全部）；`egress` 作为 `decideToolCall` 的 `tokenEgress`；`skipIrreversible` 目前 token 记录里没有该字段，恒为 `false`（P4b 若加字段会自动生效）。
- **P3 事件**：`import { onAgentTaskEvent, AGENT_TASK_EVENTS } from "extension/lib/agent/delegate.js"`，`onAgentTaskEvent(listener)` 返回取消订阅函数。事件 `{ type, taskId, at, ... }`：`agent_task.started {task}`、`agent_task.step {step}`、`agent_task.approval {pendingId, toolName, reason}`、`agent_task.finished {status, answer, error}`。已接入：bridge 在 SW 里订阅，按任务 owner（token id）转成 `agent_task.*` 事件推给该 token 的会话（需 `agent:delegate`，见 §0.8）；委托运行的 `session.tabLease(tabId)` 让内部动作遵守标签租约。
