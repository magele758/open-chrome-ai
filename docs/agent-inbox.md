# Agent Inbox — external agents → PageLens

Zero-new-daemon bridge: drop a JSON job under `~/.pagelens/agent-inbox/`, PageLens service worker polls it (only when 设置 → “启用文件 inbox” is on, default **off**), executes, writes `~/.pagelens/agent-outbox/<id>.json`, and moves the job to `agent-inbox/processed/`.

Poll interval: 30s for packaged installs (Chrome clamps alarms to ≥30s), ~6s when loaded unpacked. Each poll costs one Native Host process (`readdir`); if the host is unavailable, polling backs off from 1 to 30 minutes.

Page actions (`paste_html`, `wechat_fill_draft`, `cose_publish`) only target tabs whose origin is in `agentBridgeOrigins` (same allowlist as the bridge), and each job opens a confirmation window. Unanswered within 60s → rejected (`failCriteria: "not_confirmed"`). Use `wait --timeout` ≥ 90000 so there is time to click 允许.

Requires **Native Host** (`com.pagelens.host`) so the extension can read/write those directories:

```bash
node native/install-native-host.mjs --extension-id anpjolmpgjncncpocenkchhpkefopjne
```

Then reload PageLens on `chrome://extensions`.

## Directories

| Path | Role |
|------|------|
| `~/.pagelens/agent-inbox/*.json` | Pending jobs |
| `~/.pagelens/agent-inbox/processed/` | Completed job copies |
| `~/.pagelens/agent-outbox/<id>.json` | Results |
| `~/.pagelens/agent-payloads/` | Large HTML bodies (CLI auto-splits) |

## Job schema

```json
{
  "id": "uuid",
  "createdAt": "2026-10-01T00:00:00.000Z",
  "action": "paste_html | clipboard_write | cose_publish | wechat_fill_draft | bridge_call | agent_prompt | agent_cancel",
  "tabUrlIncludes": "mp.weixin.qq.com",
  "title": "...",
  "html": "...",
  "htmlFile": "/absolute/or/~/path.html",
  "text": "...",
  "markdown": "...",
  "platforms": ["wechat"],
  "selector": "optional CSS",
  "preferTrustedPaste": true,
  "allowInsertHtmlFallback": false
}
```

### Actions

- **`clipboard_write`** — rich write (text/html) via offscreen document (same stack as sidepanel tools).
- **`paste_html`** — clipboard_write → focus `selector` (or active editable) → **CDP trusted Meta/Ctrl+V**. Fallback: inject `pasteIntoPage` (paste-event first). **Does not count insertHTML-only as success** unless `allowInsertHtmlFallback: true`.
- **`wechat_fill_draft`** — set `#title` with native value setter; focus body ProseMirror excluding `.title-editor__input`; clipboard + trusted Cmd+V; verify title exact and body text length > 500. Does **not** click 发表.
- **`cose_publish`** — `companions.cosePublish` in MAIN world on an allowlisted https tab where `$cose` exists.

- **`agent_prompt`** — 把自然语言任务交给**侧栏 chrome-agent（LLM）**，与用户在侧栏手动输入走同一条 `sendPrompt` 路径，跑完把回复写回 outbox。**不依赖** `agentBridgeEnabled`，也不需要 remote-debugging / 9222。需要先打开「启用文件 inbox」（默认关），否则服务工作线程不会轮询。

## agent_prompt（外部总控 → 侧栏 Agent）

Job 字段：`id`、`prompt`（必填）、可选 `tabUrlIncludes` / `tabId`（先切到该标签；需与侧栏同窗口）、`url`（配合 `tabUrlIncludes`，找不到则新开）、`timeoutMs`（默认 180000，范围 5000–600000）、`metadata`（原样回传）。

```bash
node tools/agent-inbox.mjs enqueue --action agent_prompt \
  --prompt-file /tmp/publish-prompt.txt --tab-url-includes localhost:8080 --timeout-ms 300000
node tools/agent-inbox.mjs wait <id> --timeout 300000
```

Outbox：

```json
{ "id": "...", "ok": true, "action": "agent_prompt", "finishedAt": "...",
  "result": { "summary": "Agent 最终回复原文", "steps": [{ "name": "click", "ok": true, "preview": "..." }] },
  "metadata": {}, "meta": { "action": "agent_prompt", "ms": 41234 } }
```

失败时 `ok:false` + `error` + `errorCode`：

| errorCode | 含义 |
|---|---|
| `SIDEPANEL_NOT_OPEN` | 侧栏没打开。Chrome 不允许后台无手势拉起侧栏，**需要人先点一次扩展图标打开侧栏并保持打开**（切标签不会关，全局侧栏） |
| `AGENT_BUSY` | 侧栏 Agent 正在跑别的（如用户正在手动对话）。不会打断它 |
| `TAB_NOT_FOUND` / `WRONG_WINDOW` | 指定的标签找不到 / 不在侧栏所在窗口 |
| `TIMEOUT` | 超过 `timeoutMs`，已让侧栏 Agent 停止 |
| `CANCELLED` | 被外部 agent 用 `agent_cancel` / `cancel` 取消（见下） |
| `ABORTED` / `AGENT_FAILED` | 被中止 / 模型或工具失败（`error` 为原因，含"未配置模型"） |
| `BAD_JOB` / `DISABLED` | 缺 `prompt` / `agentPromptEnabled=false`（默认开） |

约定与限制：
- **串行**：同一时刻只跑一个 `agent_prompt`；后面的留在 inbox 排队，前一个结束后下一轮轮询（解包约 6s，打包安装 30s）再启动。
- 任务在**当前侧栏会话**里执行（会出现在聊天记录中，带前文上下文），页面内容取被激活标签。
- 授权模式沿用设置里的 `hitlMode`：`strict`/`balanced` 遇到需确认的操作会等人点，直到超时；无人值守请评估是否用 `autonomous`。
- `steps` 只含工具名/成败/预览；截图不单独落盘。
- 进度和结果同样显示在侧栏设置的「外部 Agent 活动」与图标角标。
- 提示词里的"不要宣称成功失败、只报事实"之类约束由总控写进 `prompt`，扩展不做改写。

### 停止任务（agent_cancel）

```bash
node tools/agent-inbox.mjs cancel <promptId>   # 停指定任务：排队中直接撤销，运行中让侧栏中止
node tools/agent-inbox.mjs cancel              # 停当前正在运行的 agent_prompt（不管 id）
node tools/agent-inbox.mjs cancel --all        # 同上，并撤销 inbox 里所有排队中的 agent_prompt
```

- 等价于投递 `{ "action": "agent_cancel", "targetId": "<promptId，可省>" }`；`targetId` 与当前运行的 id 不符时返回 `ID_MISMATCH`，不会误杀别的任务。
- 运行中的任务在下一轮轮询（解包约 6s，打包安装 30s）内中止，与侧栏「停止」按钮同一路径；被取消任务的 outbox 为 `ok:false, errorCode:"CANCELLED"`，`agent_cancel` 自己的 outbox 为 `{ ok:true, cancelled:true|false }`（没有在跑则 `cancelled:false`）。
- 中止是在工具调用边界生效：已经发出的单次点击/输入无法撤回，已执行的页面副作用（如已点「确定」发布）不会回滚。
- 兜底：`timeoutMs` 到期自动取消（`TIMEOUT`）；人也可以直接点侧栏的停止按钮。

## Doocs 多平台发布（不走 LLM）

`tools/doocs-publish.mjs` 通过 inbox 的 `bridge_call` 确定性地完成「点发布 → 精确勾选平台 → 确定」，实测约 40 秒（每个 bridge_call 要等一次轮询，解包约 6s，打包安装 30s），比让侧栏 Agent 摸索快一个量级。需要 `agentBridgeEnabled` 且白名单含 `localhost:*`，不需要 9222。

```bash
# 默认 dry-run：勾选并核对，不点确定
node tools/doocs-publish.mjs --platforms 微信公众号,知乎,B站,小红书,抖音
# 真发布，并在点击后轮询 20s 收集弹窗文字 / toast 原文
node tools/doocs-publish.mjs --platforms 微信公众号,知乎,B站,小红书,抖音 --confirm --wait 20
```

- 平台名写标签前缀即可；对话框里其余已勾选的平台会被取消，最终勾选必须与 `--platforms` 完全一致，否则退出码 2 且不点确定。
- 输出只有事实：勾选状态、`missing` / `unexpected`、确认后的弹窗文字与 toast。
- 底层工具 `set_checks`（按标签文字批量勾选，真实点击 + 回读）也可用于侧栏 Agent 和 `bridge_call`。

## CLI

```bash
# enqueue
node tools/agent-inbox.mjs enqueue \
  --action wechat_fill_draft \
  --title '文章标题' \
  --html-file /tmp/body.html \
  --tab-url-includes 'mp.weixin.qq.com'

# wait for result
node tools/agent-inbox.mjs wait <id> --timeout 90000

# inbox / outbox counts
node tools/agent-inbox.mjs status
```

## Token jobs (no confirmation window)

A job may carry `"token": "plk_…"` (a per-agent token from 设置 → 外部 Agent, see [agent-interop.md §0](agent-interop.md)). CLI: `--token-file ~/.pagelens/agents/<name>.token` or env `PAGELENS_TOKEN`; the job file is written 0600.

- Valid token with enough scope → runs **without** the confirmation window, on tabs matching the token's origins (not `agentBridgeOrigins`), audited as `inbox.<action>`.
- Required scopes: `clipboard_write` → `clipboard`; `paste_html` / `wechat_fill_draft` → `page:act` + `clipboard`; `cose_publish` → `page:act`; `bridge_call` → the tool's own scope.
- Invalid / expired / revoked token → `UNAUTHORIZED` (no fallback to the confirmation window). Missing scope → `SCOPE_DENIED`.
- The copy in `processed/` has `"token": "[redacted]"`.

## Settings

- `agentInboxEnabled` (default `false`) — toggle “启用文件 inbox” in settings. Off means no alarm and no Native Host calls.
- `agentBridgeOrigins` — origin allowlist for page actions (defaults include `https://mp.weixin.qq.com`, localhost).
- `cdpInput` must stay enabled for trusted paste.
- `nativeShell` / Native Host must be installed for the current extension id.

## Success criteria for WeChat

Outbox `method` should be `trusted_paste` (or fallback `paste-event`). If `failCriteria: "insertHTML_only"`, treat as **FAIL** for publish quality gates.
