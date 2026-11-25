# Shopee 营销工作流

在登录后的 Shopee 卖家中心打开 PageLens 侧栏，选择「工作流 → Shopee」下的「活动数据」「活动表单试填」「优惠券数据」或「优惠券表单试填」。面板使用当前标签的店铺身份。下面的页面均位于 `https://seller.shopee.cn`，需要当前店铺的 `cnsc_shop_id`。

## 活动数据

在营销中心选择「读取并整理」。勾选「读取当前筛选的各页（营销中心会汇总各列表）」时，营销中心会汇总已支持的列表。在单个列表页运行时，读取范围以页面当前筛选为准。面板显示来源和读取提示，并提供 JSON 与 CSV 导出。

| 页面 | 路径 | 读取内容 |
| --- | --- | --- |
| 营销中心 | `/portal/marketing` | 推荐活动 |
| 官方活动 | `/portal/marketing/cmt-cb/list/campaign` | 活动名称、类型、活动与提名时间、可报名数量及标签状态 |
| 商品提报 | `/portal/marketing/cmt-cb/list` | 提报名单、报名状态、方式、时间与可报名店铺 |
| 折扣活动 | `/portal/marketing/list/discount` | 活动列表及页面显示的销售指标 |
| 全球商品折扣 | `/portal/marketing/global-discount/list` | 活动列表与状态 |
| 店铺限时抢购 | `/portal/marketing/shop-flash-sale/list` | 活动列表及页面显示的销售与点击指标 |

翻译由 PageLens 配置的文本模型批量完成。结果保留名称与说明原文，另附中文字段。翻译失败时仍可读取与导出原文。数值、编号、链接和平台显示的时间不经过翻译。

实现位于 [`campaign-data/`](campaign-data/)。`page-state.js` 处理推荐活动、官方活动和商品提报，`seller-promotions.js` 处理商家促销页，`translate.js` 处理批量翻译。

## 活动试填

从「活动表单试填」打开目标页，在 PageLens 选择「探测试填表单」，然后填写参数并点「开始试填」。回执显示已回读字段和仍需处理的项目，试填停在当前页面，保存、创建、报名和购买均不触发。

| 表单 | 路径 | 支持范围 |
| --- | --- | --- |
| 折扣活动 | `/portal/marketing/discount/create` | 试填活动名称，读取日期与商品要求 |
| 全球商品折扣 | `/portal/marketing/global-discount/create` | 试填活动名称，读取日期与商品要求 |
| 店铺限时抢购 | `/portal/marketing/shop-flash-sale/create` | 读取时段与商品要求 |

实现位于 [`campaign-draft/page-state.js`](campaign-draft/page-state.js)。

## 优惠券

优惠券列表位于 `/portal/marketing/vouchers/list`。从当前列表读取优惠券类型、优惠金额、使用数量、领取期限和状态，并支持独立导出 CSV 和 JSON。

新建商店优惠券的页面位于 `/portal/marketing/vouchers/new?usecase=1`。固定金额模式下，可试填名称、优惠码后缀、折扣金额、最低消费、发放总数和每人限领数。领取期限和当前优惠模式在回执中显示，保存操作由用户控制。

[`vouchers/page-state.js`](vouchers/page-state.js) 读取列表，[`vouchers/draft.js`](vouchers/draft.js) 负责探测、试填和回读商店优惠券。

## 调试

在仓库根目录运行目标功能的测试。

```sh
node scripts/run-tests.mjs shopee/campaign-data shopee/campaign-draft shopee/vouchers
```

页面结构调整时，在对应店铺的实际页面确认路径、字段标签和渲染状态，再修改功能目录中的提取器或试填映射。侧栏通过 [`marketing-panel.js`](marketing-panel.js) 绑定页面结果和操作回执。
