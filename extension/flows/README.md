# 平台工作流

工作流使用 `extension/flows/<平台>/<功能>/`。各功能的流程定义、页面操作和回归测试放在对应目录。活动和优惠券的读取与试填分别提供入口。

## 侧栏入口

打开 PageLens「工作流」，先选平台，再点击要执行的功能。可通过「返回工作流」切换功能。当前 Shopee 提供商品上架试填和营销面板，TikTok Shop 提供墨西哥草稿 Skill 入口。选择 TikTok 功能时会在对话中填好 Skill 指令，补充商品链接后由用户发送。

新增平台或功能时，在 [功能目录](catalog.js) 登记可执行入口，再接入它的侧栏面板和回归测试。

## 已接入

| 平台 | 功能 | 调试入口 |
| --- | --- | --- |
| TikTok Shop | 墨西哥商品草稿 | [`tiktok-mx-draft`](../skills/tiktok-mx-draft/SKILL.md) |
| Shopee | 单商品和目录批量试填 | [`shopee/product-listing/`](shopee/product-listing/README.md) |
| Shopee | 活动数据读取、翻译与导出 | [`shopee/campaign-data/`](shopee/README.md#活动数据) |
| Shopee | 营销活动表单探测与试填 | [`shopee/campaign-draft/`](shopee/README.md#活动试填) |
| Shopee | 优惠券数据读取与导出、优惠券表单试填 | [`shopee/vouchers/`](shopee/README.md#优惠券) |

## 目录命名示例

| 平台 | 功能 | 目录 |
| --- | --- | --- |
| Shopee | 活动报名 | `shopee/campaign-enrollment/` |
| Temu | 商品上架 | `temu/product-listing/` |
| Temu | 活动报名 | `temu/campaign-enrollment/` |
| Temu | 活动数据 | `temu/campaign-data/` |

在仓库根目录执行 `node scripts/run-tests.mjs <平台>/<功能>` 可以运行指定功能目录中的测试。
