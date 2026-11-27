---
name: TikTok 墨西哥上架闭环
description: 贴一个日本商品链接加一句意图，完成建草稿、改测试价、提审、在售通知、下架或改标题的完整闭环，每步留回执。
---

目标：用户贴一条日本商品链接并给一句意图（例如「上架测试：建草稿、改到测试价、提审、确认在售后下架」或「正式上架这件」或「把已上架的 XX 下架/改标题」），按下面的固定步骤执行到对应终点。所有卖家操作只走本插件，不直连 CDP，不改仓库代码，不动别人已测过的商品（面包架 `1738630710999877196`）。

## 前置条件

- Chrome 已运行并登录墨西哥店铺，Seller Center 已授权；PageLens 已启用「文件 inbox」和卖家入口。
- 在 PageLens「设置 → 高级配置 → 安装与诊断」复制当前扩展 ID，并设置 `export PAGELENS_EXTENSION_ID='<当前扩展 ID>'`。
- 每条命令都是：`node tools/agent-inbox.mjs enqueue …` 拿到 JOB_ID，再 `node tools/agent-inbox.mjs wait "$JOB_ID" --timeout 180000`。
- 回执在 `~/.pagelens/agent-outbox/<JOB_ID>.json`，按 job id 存档，不要删。

## 步骤

### 1. 建草稿（ptc_create_mx_draft）

```bash
node tools/agent-inbox.mjs enqueue --action ptc_create_mx_draft \
  --source-url '日本商品链接' --rate 汇率
```

验收：回执 `ok:true`，记录 `draftId`、`sourceId`、商品名、各 SKU 的 label 与基准价 priceMXN、回执路径。同一来源已有登记草稿时回执走复用，沿用原 draftId。草稿有空白类目/属性时先 `ptc_repair_mx_draft`（`--source-id --draft-id --repair attributes|category`）补齐并复核。

### 2. 核对（ptc_inspect_mx_draft）

```bash
node tools/agent-inbox.mjs enqueue --action ptc_inspect_mx_draft \
  --source-id "$SOURCE_ID" --draft-id "$DRAFT_ID"
```

验收：回执给出刷新后的图文、类目、全部 SKU 与包裹数据。用它提取改价基准价。

### 3. 改到测试价（reprice_draft）

```bash
node tools/agent-inbox.mjs enqueue --action ptc_mx_seller_action --request-json '{
  "mode":"reprice_draft","sourceId":"…","draftId":"…",
  "baselinePricesMXN":[{"label":"SKU 标签","priceMXN":基准价}],
  "multiplier":100,"maxTotalStock":10}'
```

- 基准价来自第 2 步核对回执，每个已存 SKU 一行 `{label,priceMXN}`。
- 回执里某 SKU 出现卖家售价上限时，采用当场返回的上限价作为该 SKU 成交价；重试沿用原始基准价。
- 验收：回执记录的 saved 价与刷新核对一致、总库存 ≤ 10。若刷新回读报 `Unexpected stock change`，保留原编辑页与回执，如实报告，不要反复重试覆盖。

### 4. 提审（publish_draft）

```bash
node tools/agent-inbox.mjs enqueue --action ptc_mx_seller_action --request-json '{
  "mode":"publish_draft","sourceId":"…","draftId":"…",
  "offer":{"brand":"品牌","packagedWeightGrams":克数,
    "packageCm":{"length":…,"width":…,"height":…},
    "skus":[{"label":"SKU 标签","priceMXN":第 3 步成交价,"stock":…}]}}'
```

- offer 各字段取自草稿核对回执；价格用第 3 步保存后的价。
- 保存任务 ID、提审时间、回执里的 `productId`。
- 建议框（如图片数量建议）插件会自动确认一次；其余对话框不代答。
- **防重复提审**：wait 超时先读原 job 的 outbox 回执再决定——结果不确定的回执已记录待对账，禁止再次提审；只有回执明确停在卖家对话框（未派发）时才安全重试。
- 验收：回执 `submitted:true`、`verified:true`，记录 `intentAt` 与 `status`（通常 `under_review`）。

### 5. 审核通过通知

审核跟踪默认关闭。在提审前已通过「设置 → 高级配置 → TikTok Shop 审核跟踪」开启、且用户在提审后打开或刷新过墨西哥商品管理的「全部」列表时，可等待两个完整轮询周期。设置里可查看等待原因或停止跟踪。需要立即核对或未启用跟踪时，使用本次任务的手动查询：

```bash
node tools/agent-inbox.mjs enqueue --action ptc_mx_seller_action --request-json '{
  "mode":"listing_status","productId":"第 4 步 productId"}'
```

记录触发顺序：Inbox 活动、桌面通知、手动 listing_status，各自的时间与结果。验收：`verified:true` 且 `status:"active"` 才算在售。

### 6. 测试场景收尾（delist_listing）

确认在售后（测试上架）立即下架：

```bash
node tools/agent-inbox.mjs enqueue --action ptc_mx_seller_action --request-json '{
  "mode":"delist_listing","productId":"同一 productId"}'
```

下架后单独再跑一次第 5 步的 `listing_status`，验收同一 ID `verified:true` 且 `status:"inactive"`。

### 7. 既有商品的改标题（optimize_listing）与订单（read_orders）

```bash
# 改标题：editorUrl 必须是该商品行打开的精确编辑链接，标题用西语
node tools/agent-inbox.mjs enqueue --action ptc_mx_seller_action --request-json '{
  "mode":"optimize_listing","productId":"…","editorUrl":"…",
  "beforeTitle":"旧西语标题","afterTitle":"新西语标题"}'
# 订单：orderStatus 可选 all/to_ship/shipped/completed/cancelled
node tools/agent-inbox.mjs enqueue --action ptc_mx_seller_action --request-json '{
  "mode":"read_orders","orderStatus":"to_ship"}'
```

## 汇报

最终结果用一张表汇报：商品名与 productId、原价与最终售价、总库存、提审时间、首次在售时间、Inbox 通知、桌面通知、最终状态、总耗时（首条 enqueue 到最后一条回执）、关键回执路径（各 job id → outbox 文件）。未走到的步骤标注「不适用」。

## 红线

- 面包架 `1738630710999877196` 是他人测试商品，禁止对它执行任何卖家动作。
- 卖家动作只通过 `tools/agent-inbox.mjs` 走插件，不直连 CDP、不开 9222。
- 不修改仓库代码；每一步以回执为准，不凭页面截图宣称成功。
