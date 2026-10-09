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
  "action": "paste_html | clipboard_write | cose_publish | wechat_fill_draft",
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
