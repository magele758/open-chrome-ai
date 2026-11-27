---
name: pagelens-tiktok-mx-listing
description: Use the PageLens Chrome extension to list, test-reprice, publish, inspect, repair, optimize, or delist TikTok Shop México (MX) products from TikTok Shop Japan (JP) product URLs or spreadsheet/list files (.numbers, .csv, .txt, .json), supporting both single-item runs and 3-window concurrent batch listing with per-stage timing and exact plugin PTC token reporting. Trigger when the user asks to "用 PageLens 上架", "调用插件上架商品", "TikTok 墨西哥上架", "批量上架商品", "日本商品转墨西哥", "建草稿/改测试价/提审/下架", "查墨西哥店铺订单", "TikTok MX listing", "ptc_create_mx_draft", "reprice_draft", or "publish_draft".
---

# PageLens TikTok Shop MX Listing

Drive the locally installed PageLens Chrome extension through its file inbox (`~/.pagelens/agent-inbox/<extensionId>/`) using the bundled zero-dependency CLI [`scripts/mx-list.mjs`](scripts/mx-list.mjs).

Set `CLI` to the `scripts/mx-list.mjs` inside this skill directory (repo copy `.agents/skills/pagelens-tiktok-mx-listing/scripts/mx-list.mjs` or user-global copy `~/.agents/skills/pagelens-tiktok-mx-listing/scripts/mx-list.mjs`).

## Guardrails (Always Enforce)

1. **Plugin inbox only**: Never connect directly to Chrome CDP / port 9222, never edit the PageLens repository during listing tasks, and never fabricate success from screenshots—every step must be backed by a verified outbox receipt (`~/.pagelens/agent-outbox/<jobId>.json`).
2. **Never touch protected product `1738630710999877196`** (shared test bread rack). `scripts/mx-list.mjs` blocks mutating actions against it.
3. **Never bypass CAPTCHAs or verification**: If PageLens reports a slider/puzzle or seller verification (`exit code 2`), stop immediately, leave the verification window untouched, ask the user to complete verification in Chrome, and resume later with the same `--progress` file.
4. **Stop immediately if Seller Center is not logged in**: If the MX shop session has expired or redirects to a login page (`SELLER_LOGIN_REQUIRED`, `exit code 3`), stop automation immediately—do NOT retry or launch remaining waves—and ask the user to log into TikTok Seller Center MX in Chrome before resuming with the same `--progress` file.
5. **Confirm intent before publishing**: If the user did not explicitly state the endpoint or pricing rule, ask once before running `reprice` or `publish`:
   - **Endpoint**: `draft` (save draft only), `publish` (submit for review and keep live), or `test-delist` (submit -> confirm `active` -> delist -> confirm `inactive`).
   - **Pricing**: `test` (`reprice_draft` with `--multiplier 100` or `10` + dynamic Seller Center price ceiling + `--max-total-stock 10`) vs `1x` (`--no-reprice`, publish at converted baseline price).
   - **FX rate**: JPY -> MXN rate (`--rate`, default `0.1161`).

## Step 0: Preflight Health Check

Before starting any single or batch run, verify Chrome, PageLens extension, and Native Host are alive and idle:

```bash
node "$CLI" status
```

Confirm `"ok": true` and `result.busy === false`. The script auto-discovers the active extension ID from `--extension-id`, `$PAGELENS_EXTENSION_ID`, `<repo>/extension/local-development.json`, or `~/.pagelens/agent-inbox/<extId>/`.

## Single-Product Workflows

```bash
# 1. Draft only (safe default)
node "$CLI" run --url 'https://shop.tiktok.com/jp/pdp/1735551813631117257' \
  --rate 0.1161 --stage draft

# 2. Test-price (100x with dynamic ceiling, stock <= 10) + submit for review
node "$CLI" run --url 'https://shop.tiktok.com/jp/pdp/1735551813631117257' \
  --rate 0.1161 --stage publish --multiplier 100 --max-total-stock 10

# 3. Direct 1x converted price publish (skip reprice_draft)
node "$CLI" run --url 'https://shop.tiktok.com/jp/pdp/1735551813631117257' \
  --rate 0.1161 --stage publish --no-reprice
```

For full **test-and-delist** verification on a single item:
1. Run `--stage publish` above and record `productId`.
2. Wait ~2 minutes (two background Seller Center polling cycles), then check `listing_status` until `status: "active"`.
3. Run `action --mode delist_listing --product-id <productId>` (automatically follows up with `listing_status` to verify `status: "inactive"`).

## Batch Listing (3-Window Concurrency)

PageLens executes up to 3 `ptc_create_mx_draft` jobs concurrently (`MAX_PARALLEL_MX_CREATES = 3`). Each job opens its own unfocused normal Chrome window (isolated by window without creating Chrome tab groups, avoiding leftover/saved tab groups in Chrome), staggers startup to avoid Seller Center rate limits, and auto-closes its dedicated window on completion.

```bash
# Optional: inspect & normalize .numbers / .csv / .tsv / .txt / .json first
node "$CLI" parse --input ~/Downloads/products.numbers --out /tmp/products.json

# Run full batch in waves of 3 with resumable checkpoint
node "$CLI" run \
  --input ~/Downloads/products.numbers \
  --wave 3 --rate 0.1161 \
  --stage publish --multiplier 100 --max-total-stock 10 \
  --progress /tmp/mx-batch-progress.json
```

### Resuming & Retrying

- **Resume after CAPTCHA or interruption**: Re-run the exact same command with the same `--progress` path. Items that already reached the target stage are skipped automatically.
- **Retry only failed items**: Add `--retry-failed` (or target exact 1-based rows with `--only 1,4,17` or `--from 1 --to 10`).
- **Anti-duplicate safety**: If a `publish_draft` job times out or returns an unconfirmed submission state, it is marked `publish_unconfirmed` and skipped by `--retry-failed`. Always run `action --mode listing_status --product-id <draftId>` first to verify whether Seller Center already received it.
- **Null-ID cleanup**: When `ptc_create_mx_draft` fails (non-CAPTCHA) before obtaining a draft ID, `mx-list.mjs` automatically deletes unconfirmed null-ID `~/.pagelens/mx-draft-sources/<sourceId>.json` records so retries succeed cleanly.

## Post-Listing & Draft Maintenance (`action`)

```bash
# Check live listing status
node "$CLI" action --mode listing_status --product-id 1738660929444349516

# Delist + verify inactive
node "$CLI" action --mode delist_listing --product-id 1738660929444349516

# Update Spanish title on a live listing (requires exact Seller Center editor URL)
node "$CLI" action --mode optimize_listing \
  --product-id 1738660929444349516 \
  --editor-url 'https://seller.tiktokshopglobalselling.com/product/edit/1738660929444349516?shop_region=MX' \
  --before-title 'Old ES title' --after-title 'New ES title'

# Read orders (all | to_ship | shipped | completed | cancelled)
node "$CLI" action --mode read_orders --order-status to_ship

# Read-only refresh readback of an existing draft
node "$CLI" action --mode inspect --source-id 1735551813631117257 --draft-id 1738660929444349516

# Repair blank attributes or category on an existing draft
node "$CLI" action --mode repair --source-id 1735551813631117257 --draft-id 1738660929444349516 --repair attributes
node "$CLI" action --mode repair --source-id 1735551813631117257 --draft-id 1738660929444349516 --repair category --queries "Cortador,Utensilios de cocina"
```

## Timing & Plugin Token Reporting

`run` prints a Markdown report automatically on exit (omitting untouched `pending` rows by default; pass `--all` to show all rows). To regenerate or export JSON from any checkpoint at any time:

```bash
node "$CLI" report --progress /tmp/mx-batch-progress.json
node "$CLI" report --progress /tmp/mx-batch-progress.json --all
node "$CLI" report --progress /tmp/mx-batch-progress.json --json
```

When reporting results to the user, include:
- Per-item status, `draftId` / `productId`, final SKU prices (noting dynamic ceiling clamps), and total stock.
- Wall-clock time and per-stage averages (`create`, `reprice`, `publish`).
- Exact PageLens plugin PTC token consumption (`calls`, `inputTokens`, `outputTokens`, `cacheReadInputTokens`, `totalTokens` from `receipt.tokenUsage`), noting that `reprice_draft` and `publish_draft` are deterministic and consume `0` LLM tokens.
- Any failed / `publish_unconfirmed` items and their outbox receipt paths.

## Low-Level Contracts & Troubleshooting

For direct `tools/agent-inbox.mjs` invocations, exact JSON schemas, file layout, and error recovery, read [`references/inbox-contracts.md`](references/inbox-contracts.md).
