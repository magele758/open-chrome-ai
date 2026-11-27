# PageLens Inbox & TikTok MX Action Contracts

Use `scripts/mx-list.mjs` for normal workflows. Refer to this file only when invoking `tools/agent-inbox.mjs` directly, auditing outbox receipts, or troubleshooting failures.

## Local Directories & State Files

| Path | Purpose |
|---|---|
| `~/.pagelens/agent-inbox/<extensionId>/<jobId>.json` | Directed inbox for local-only & MX draft/seller jobs (must be written atomically via `.tmp` + `rename`) |
| `~/.pagelens/agent-outbox/<jobId>.json` | Final JSON reply for each job (archive, do not delete) |
| `~/.pagelens/mx-draft-sources/<sourceId>.json` | Source-to-draft mapping `{ dir, id, title, link }` |
| `<dir>/receipt.json` | Detailed draft receipt: `readback`, `stages` (ms timestamps), `tokenUsage`, `formRuns`, `skuWrites`, `origins` |
| `<repo>/extension/local-development.json` | Active unpacked Chrome extension ID (`extensionId`) and synced Git commit (`revision`) |

> **Gotcha:** Always pass `--extension-id <id>` explicitly (or unset stale `PAGELENS_EXTENSION_ID` env vars) when running `tools/agent-inbox.mjs`.

## Direct `tools/agent-inbox.mjs` Commands

```bash
REPO="${PAGELENS_REPO:-.}"
EXT_ID="$(node -p "require('$REPO/extension/local-development.json').extensionId")"
CLI="$REPO/tools/agent-inbox.mjs"

# 1. Health check
JOB=$(node "$CLI" enqueue --extension-id "$EXT_ID" --action dev_status)
node "$CLI" wait "$JOB" --timeout 20000

# 2. Create MX draft from TikTok JP URL (supports /jp/pdp/<id> and /jp/pdp/<slug>/<id>)
JOB=$(node "$CLI" enqueue --extension-id "$EXT_ID" --follow-up \
  --action ptc_create_mx_draft \
  --source-url 'https://shop.tiktok.com/jp/pdp/1735551813631117257' \
  --rate 0.1161)
node "$CLI" wait "$JOB" --timeout 300000

# 3. Inspect saved draft (read-only refresh readback)
JOB=$(node "$CLI" enqueue --extension-id "$EXT_ID" \
  --action ptc_inspect_mx_draft \
  --source-id "$SOURCE_ID" --draft-id "$DRAFT_ID")
node "$CLI" wait "$JOB" --timeout 180000

# 4. Repair missing attributes or category
JOB=$(node "$CLI" enqueue --extension-id "$EXT_ID" \
  --action ptc_repair_mx_draft \
  --source-id "$SOURCE_ID" --draft-id "$DRAFT_ID" \
  --repair attributes)
# For category repair, optional --queries-json '["term1","term2"]' (1-6 terms, <=35 chars each)
```

## `ptc_mx_seller_action` Request Schemas (`--request-json`)

All `ptc_mx_seller_action` jobs require `--extension-id` and strict field matching (no extra keys).

### 1. `reprice_draft`
```json
{
  "mode": "reprice_draft",
  "sourceId": "1735551813631117257",
  "draftId": "1738660929444349516",
  "baselinePricesMXN": [{ "label": "Plateado Único", "priceMXN": 32 }],
  "multiplier": 100,
  "maxTotalStock": 10
}
```
- `multiplier` must be `10` or `100`.
- `maxTotalStock` is optional; when provided, only `10` is accepted.
- Price ceilings are read dynamically from Seller Center's live validation prompt (never hardcode a fixed cap). If clamped, the reply includes `maxPriceMXN` and the clamped `afterMXN`.

### 2. `publish_draft`
```json
{
  "mode": "publish_draft",
  "sourceId": "1735551813631117257",
  "draftId": "1738660929444349516",
  "offer": {
    "brand": "无品牌",
    "packagedWeightGrams": 100,
    "packageCm": { "length": 15, "width": 8, "height": 6 },
    "skus": [{ "label": "Plateado Único", "priceMXN": 3200, "stock": 10 }]
  }
}
```
- Verified reply contains `submitted: true`, `verified: true`, `productId`, `status` (typically `under_review` or `active`), `elapsedSeconds`.

### 3. `listing_status` & `delist_listing`
```json
{ "mode": "listing_status", "productId": "1738660929444349516" }
```
```json
{ "mode": "delist_listing", "productId": "1738660929444349516" }
```
- After `delist_listing`, always confirm with `listing_status` that `verified: true` and `status: "inactive"`.

### 4. `optimize_listing`
```json
{
  "mode": "optimize_listing",
  "productId": "1738660929444349516",
  "editorUrl": "https://seller.tiktokshopglobalselling.com/product/edit/1738660929444349516?shop_region=MX",
  "beforeTitle": "Old Spanish title",
  "afterTitle": "New Spanish title"
}
```

### 5. `read_orders`
```json
{ "mode": "read_orders", "orderStatus": "to_ship" }
```
- `orderStatus` (optional): `all` | `to_ship` | `shipped` | `completed` | `cancelled`.

## Troubleshooting & Known Behaviors

| Symptom | Cause & Fix |
|---|---|
| `SELLER_LOGIN_REQUIRED` (`exit code 3`) | TikTok Seller Center MX is not logged in (redirected to `/account/login` or `accounts.tiktok.com`). Automation stops immediately without launching further waves and closes automation windows. Sign in to Seller Center MX in Chrome, then resume with the same `--progress` file. |
| `dev_status` times out | Chrome not running, PageLens extension disabled/unloaded, file inbox toggle off in PageLens settings, or Native Host not installed (`node tools/tiktok-mx-draft.mjs install`). |
| `Source already registered; use rerun` | Previous `ptc_create_mx_draft` failed after writing `{ id: null }` to `~/.pagelens/mx-draft-sources/<sourceId>.json`. Delete the record only when `id` is null/empty (`mx-list.mjs` does this automatically on non-CAPTCHA failures). |
| `submission_unconfirmed` / outbox timeout on `publish_draft` | **Never blindly re-submit.** First inspect the original outbox file and run `action --mode listing_status --product-id <draftId>` to confirm whether Seller Center already received it. |
| `"captcha":false` in error string | Not a CAPTCHA! Only treat `"captcha":true` or explicit verification prompts (`拖动完成上方拼图` / `Verify to continue` / `TikTok verification is open`) as CAPTCHA blocks. |
| Category rejected by shop business scope | Handled automatically by PageLens: the extension filters suggestions against the shop's permitted leaf categories and falls back via the `category-scope` PTC cell. |
| Automation windows / tab groups left open | PageLens opens each TikTok MX job in its own unfocused normal window (`MAX_PARALLEL_MX_CREATES = 3`) without creating Chrome tab groups (preventing leftover/saved tab groups), ungroups any grouped tabs before closing, and auto-closes the dedicated window when finished. A window stays open intentionally only if verification/CAPTCHA is required. |
