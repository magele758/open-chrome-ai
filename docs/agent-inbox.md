# Agent Inbox — external agents → PageLens

Zero-new-daemon bridge: drop a JSON job under `~/.pagelens/agent-inbox/`, PageLens service worker polls every ~6s (when `agentInboxEnabled` is true, default **on**), executes, writes `~/.pagelens/agent-outbox/<id>.json`, and moves the job to `agent-inbox/processed/`.

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
- **`cose_publish`** — `companions.cosePublish` in MAIN world on an https tab where `$cose` exists.

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

## Settings

- `agentInboxEnabled` (default `true`) — set `false` in PageLens settings storage to pause polling.
- `cdpInput` must stay enabled for trusted paste.
- `nativeShell` / Native Host must be installed for the current extension id.

## Success criteria for WeChat

Outbox `method` should be `trusted_paste` (or fallback `paste-event`). If `failCriteria: "insertHTML_only"`, treat as **FAIL** for publish quality gates.
