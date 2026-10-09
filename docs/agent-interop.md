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
| 过期 / 吊销 | 过期或吊销后，已建立的会话下一次调用即返回 `UNAUTHORIZED` |
| 设置隔离 | `agentGatewayEnabled` / `agentTokens` 不出现在扩展内 Agent 的设置工具里，也不能被它修改；只能在设置页改 |

工具所需 scope：

| scope | 工具 |
|---|---|
| `tabs:read` | `list_tabs` |
| `tabs:manage` | `open_tab` `activate_tab` |
| `page:read` | `wait_for` `query_dom` `read_rendered_html` `screenshot` `pick_rich_editor` `wechat_pick_body_editor` `verify_editor_content` |
| `page:act` | `set_input_value` `trusted_click` `trusted_type` `press_keys` `hover` `paste_rich_trusted` |
| `page:js` | `run_js` |
| `clipboard` | `clipboard_write` `copy_selection_trusted` |
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
| `EGRESS_NOT_ALLOWED` | 预留给 P2 的出站（下载/外发）检查 |

网关未运行时，MCP 工具调用返回 `isError` 文本「PageLens 网关未运行…」，说明需要打开 Chrome 并在设置里启用网关。

### 0.5 审计

每次调用（含旧入口，记为 `legacy`）写入 IndexedDB `pagelens-data` 的 `agentAuditLog`，保留最近 2000 条：时间、Agent、工具、origin、参数摘要、成功/错误码、耗时。参数摘要不含正文：字符串只记长度（`selector`、`url` 等定位字段保留且截断，URL 去掉 query/hash），疑似密钥的键记为 `[redacted]`。设置页可查看、导出 JSON、清空。

### 0.6 文件 inbox 带 token

inbox job 可带 `"token":"plk_…"`：校验通过且 scope 足够时**跳过逐次确认**，使用 token 的 origins，审计记为 `inbox.<action>`；token 无效直接 `UNAUTHORIZED`（不会退回到确认框）。所需 scope：`clipboard_write` → `clipboard`；`paste_html` / `wechat_fill_draft` → `page:act,clipboard`；`cose_publish` → `page:act`；`bridge_call` 走网关会话路径。写入 `processed/` 的副本里 token 记为 `[redacted]`。

## 1. 安全模型（先读）

| 约束 | 行为 |
|---|---|
| 默认关闭 | `settings.agentBridgeEnabled` 默认 `false`；关闭时 `call` 一律返回 `DISABLED`，`hello()` 不暴露工具 |
| 仅限专用 profile | 只应在**专用 Chrome profile / 专用 user-data-dir** 里开启。扩展无法自证 profile 身份，靠"显式开关 + 你只在专用 profile 里打开"保证；**不要在日常 Chrome 里开启** |
| origin 白名单 | `settings.agentBridgeOrigins`，默认 `localhost:*`、`127.0.0.1:*`、`mp.weixin.qq.com`、知乎专栏、B 站创作中心、小红书创作、抖音创作。白名单之外的标签：`list_tabs` 看不到，任何带 `tabId` 的工具返回 `ORIGIN_NOT_ALLOWED`；`open_tab` 也校验 URL。`chrome://` 等受限页返回 `TAB_RESTRICTED` |
| 每次调用都鉴权 | 每次调用重新读开关与白名单、重新取标签当前 URL（导航后 origin 变了立即失效）；关掉开关即时生效 |
| 不暴露高危工具 | 不提供 `upload_file`（读本机文件）、`drag_drop`、`run_shell`、下载等；`run_js` 只在白名单 origin 的标签里可用 |
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
- 长任务：`async:true` → `{ok:true,result:{jobId:<id>,status:"running"}}`；轮询 `job_status {jobId}` → `{status:"running"}` 或 `{status:"done", response:{…最终响应…}}`。只做轮询，没有推送事件。任务存在 SW 内存里，**SW 重启会丢（`JOB_NOT_FOUND`）**；CDP 附着期间不会被回收。
- 同一时刻，剪贴板与键鼠类工具（`exclusive`）在扩展内**全局串行**，不会交错。

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
| `TOOL_FAILED` | 否 | 其他工具失败，见 `message` |

## 7. 幂等与重试约定

- 相同 `id` + 相同内容：10 分钟内重放返回**缓存的原响应**（`meta.replayed:true`），不会再执行（避免重复粘贴/点击）。
- 相同 `id` + 不同内容：`ID_CONFLICT`。
- **`retryable:true` 的失败不缓存**：同 id 重发会重新执行。
- 外部 Agent 的重试策略：只对 `retryable` 错误重试，最多 2–3 次、指数退避；`VERIFY_FAILED` 不重发同一请求，由外部 Agent 决策（截图、人工介入）。`paste_rich_trusted` 内部自带"清空 → 粘贴 → 校验"循环（`retries` 默认 2，上限 3），每次尝试前先 Meta/Ctrl+A、Backspace 清空编辑器，所以重试幂等，旧内容不会让校验假通过。
- 变更类工具（点击、粘贴）超时后不要盲目重发：先回读。

## 8. 焦点策略

| 级别 | 工具 | 说明 |
|---|---|---|
| `none` | `list_tabs`、`open_tab`（默认 `active:false`）、`wait_for`、`query_dom`、`run_js`、`read_rendered_html`、`screenshot`、`clipboard_write`、`set_input_value`、`pick_rich_editor`/`wechat_pick_body_editor`、`verify_editor_content` | 不切标签、不动窗口焦点（`pick`/`prepare` 会在**页面内** `focus()` 编辑器） |
| `emulated` | `trusted_click`、`trusted_type`、`press_keys`、`hover`、`copy_selection_trusted`、`paste_rich_trusted` | 调用 `Emulation.setFocusEmulationEnabled`，页面认为自己有焦点，**不抢窗口/标签焦点**。e2e 实测：后台标签里可信粘贴成功，标签保持 `active:false`。传 `activate:true` 才会切到前台 |
| `activates` | `activate_tab`、任何传了 `activate:true` 的调用 | 会把标签切到前台（抢焦点） |

注意：可信粘贴/复制走**系统剪贴板**，会覆盖用户剪贴板（专用 profile 的无人值守场景可接受；有人在用这台机器时不要跑）。

## 9. chrome.debugger 与外部 CDP 共存

- 可信输入、截图用 `chrome.debugger`，附加期间 Chrome 显示"正在调试此浏览器"横幅；空闲 20s 自动分离。
- 外部 CDP 客户端（9222）与 `chrome.debugger` 可以**同时**附加同一标签：e2e 里外部客户端附加编辑页后，扩展照常可信粘贴，外部客户端也照常评估（已验证）。
- 真正的 `Another debugger is already attached` 通常来自其他扩展的 `chrome.debugger`。策略：附加失败 → 等 500ms 重试**一次** → 仍失败返回 `DEBUGGER_BUSY`（`retryable:true`，`hint` 说明）。该分支只有 mock 测试覆盖，无法在 e2e 里稳定复现。
- 建议：不要让外部 Agent 同时用 `Input.dispatch*` 与本扩展的可信输入操作同一标签，会互相打断焦点/选区。

## 10. 工具参考

通用：除 `list_tools/job_status/audit_log/list_tabs/open_tab/clipboard_write` 外都需 `tabId`。

| 工具 | 作用 | 要点 |
|---|---|---|
| `list_tabs {query?}` | 白名单内的标签 | 仅返回允许的 origin |
| `open_tab {url, active?}` | 新开标签 | 默认后台；URL 需在白名单；返回的标签尚未加载完时，后续带 `tabId` 的调用会等它提交 URL（≤4s），页面元素仍应用 `wait_for` |
| `activate_tab {tabId}` | 切前台 | 抢焦点 |
| `wait_for {tabId, selector? , text?, timeoutMs?}` | 页面内轮询 | 超时 `TIMEOUT` |
| `query_dom` / `run_js` | 读 DOM / 执行 JS | `run_js` 需 JSON 可序列化返回 |
| `read_rendered_html {tabId, selector, removeSelectors?, keepClass?}` | 读已渲染 HTML，**用 getComputedStyle 内联样式**，转绝对链接，去 script/style/id/data-* | HTML 在 `artifacts[0]`；`result.stats` 有字数/table/img |
| `screenshot {tabId, fullPage?, selector?}` | JPEG artifact（base64） | 走调试器，不切标签 |
| `clipboard_write {html?, text?}` | 写剪贴板（html+plain） | 方式依次：offscreen `execCommand("copy")`（不需文档焦点，e2e 实测可用）→ offscreen Clipboard API → Native Host(macOS)；offscreen 被配音占用时不抢占 |
| `set_input_value {tabId, selector, value}` | 原生 setter 写 input/textarea 并派发 input/change | 回读不一致 → `VERIFY_FAILED`；**标题用它** |
| `trusted_click` / `trusted_type` / `press_keys` / `hover` | 即现有 CDP 可信输入工具 | 目标用 `selector`/`text`/`x,y`（不支持 `index`）；`press_keys` 的 `Meta/Ctrl+A/C/V/X/Z` 带原生编辑命令 |
| `pick_rich_editor` / `wechat_pick_body_editor` | 挑正文编辑器 | 排除 `.title-editor__input`、`#title`、`[class*=title-editor]`；优先占位文案"从这里开始写正文"；候选打分在 `candidates`；返回 `domIndex` 可钉住同一编辑器 |
| `verify_editor_content {tabId, expect?, titleEquals?, titleBefore?, includeHtml?}` | 回读校验 | `stats`（chars/tables/imgs/paragraphs/headings/links）、`title`、`titlePolluted`、`checks[]`；`expect:{minChars,minTables,minImages,contains[]}` |
| `copy_selection_trusted {tabId, selector}` | 选中元素内容 + 可信 Meta/Ctrl+C | Chrome 自己序列化（带内联样式），随后 `paste_rich_trusted {useClipboard:true}` |
| `paste_rich_trusted {tabId, html? / text? / source{tabId,selector} / useClipboard, titleEquals?, expect?, retries?, settleMs?, activate?, includeHtml?}` | 写剪贴板 → 点击聚焦 → 全选+清空 → 可信粘贴 → 回读校验 → 重试 | 默认从 `html` 推导断言：`minChars=85%`、`minTables`、`minImages`，可用 `expect` 覆盖；标题不得被污染或变化；失败 `VERIFY_FAILED`，**无 DataTransfer/innerHTML 兜底** |
| `job_status` / `audit_log` / `list_tools` | 元工具 | |

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
- 任务表在 SW 内存里，SW 重启丢失。

## 14. 测试

```bash
node extension/tools/test_bridge_protocol.mjs   # 协议、白名单、幂等、超时、async、错误码
node extension/tools/test_bridge_editor.mjs     # jsdom：挑编辑器、回读校验、样式内联、原生 setter
node extension/tools/test_bridge_paste.mjs      # paste_rich_trusted 流程（mock CDP）：顺序、重试、不兜底、焦点
node extension/tools/test_clipboard_sw.mjs      # 剪贴板三种方式的降级与 offscreen 让位
node extension/tools/e2e_bridge.mjs             # 真浏览器冒烟（专用临时 profile，见脚本头注释）
```

前四个由 `npm test` 自动收录；`e2e_bridge.mjs` 不属于 `run-tests`，需要本机有 Chrome。

网关：

```bash
node extension/tools/test_agent_gateway.mjs   # token / scope / origin、会话调用、审计脱敏与上限、native port（npm test 收录）
node native/test_gateway.mjs                  # host 作为 broker：socket 0600、MCP 垫片、吊销、Chrome 断开后退出、安装器（CI 收录）
CHROME_BIN=/usr/bin/google-chrome-stable node extension/tools/e2e_gateway.mjs   # 真 Chrome：设置页建 token → MCP 调用 → 审计 → 吊销
```
