# SHEIN 商品上架

在已登录的 SHEIN 卖家中心打开 PageLens，选择「工作流 → SHEIN → 商品上架」，或使用对话框上的快捷入口。[SHEIN 卖家中心](https://sellerhub.shein.com/#/spmp/commdities/list)

选择商品资料目录、单件商品的图片目录，或直接输入商品描述。图片目录可将图片放在所选目录或其 `images` 子目录。可分别选择将图片上传到 SHEIN、允许已配置的 AI 分析商品资料及图片。

点击「开始上品」启动流程。PageLens 读取当前类目的表单，核对填入内容并在侧栏显示待处理问题。检查无误后，可在 SHEIN 发布商品。

## 商品资料文件格式

PageLens 商品导出及内部目录读取使用 `product.json`。以下字段和值用于说明格式，正式商品使用实际资料。

```json
{
  "title": "Insulated Travel Tumbler",
  "description": "Stainless steel travel tumbler with a sliding lid.",
  "sku": "EXAMPLE-CUP",
  "shein": {
    "categoryPath": ["家居&生活", "厨房&餐厅", "饮具", "真空瓶和保温杯"],
    "attributes": { "产品功能": ["无"] },
    "variantGroups": [{
      "name": "颜色",
      "options": [
        {"value": "黑色", "imagePath": "images/black/front.jpg", "squareImagePath": "images/black/square.jpg", "swatchImagePath": "images/black/swatch.jpg"},
        {"value": "粉色", "imagePath": "images/pink/front.jpg", "squareImagePath": "images/pink/square.jpg", "swatchImagePath": "images/pink/swatch.jpg"}
      ]
    }],
    "sharedGalleryImages": ["images/shared/lid.jpg", "images/shared/side.jpg"],
    "sites": ["美国站"],
    "package": {"weightG": 340, "lengthCm": 22, "widthCm": 10, "heightCm": 10},
    "skus": [
      {"options": {"颜色": "黑色"}, "sellerSku": "EXAMPLE-CUP-BK", "priceUsd": 39.5, "quantity": 1, "imagePath": "images/black/front.jpg"},
      {"options": {"颜色": "粉色"}, "sellerSku": "EXAMPLE-CUP-PK", "priceUsd": 39.5, "quantity": 1, "imagePath": "images/pink/front.jpg"}
    ]
  }
}
```

- 商品目录有中文标题或描述时，可补充 `shein.englishTitle` 和 `shein.englishDescription`。
- 可搜索的属性下拉在当前列表没有精确匹配时，会用该字段的搜索框再查一次。选择后会核对实际选中值。
- 基础商品尺寸用 `shein.dimensions`，包装尺寸用 SKU 行里的 `lengthCm`、`widthCm`、`heightCm` 和 `weightG`。
- 为每个主规格登记首图 `imagePath` 和方形图 `squareImagePath`。当前表单有「色块图」时，需使用 80×80 像素、3 MB 以内的 JPG、JPEG 或 PNG，路径填在 `swatchImagePath`。省略路径时，PageLens 可以从该规格已匹配的首图生成色块图。各规格的「细节图」按自己的首图、共用细节图的顺序写入。共用图可登记在 `shein.sharedGalleryImages` 或 `detailImages`，最多带四张共用图。SKU 图使用对应 SKU 行的 `imagePath`。
- 图片路径相对于选中的商品目录。选择上传后，PageLens 通过 SHEIN 原有上传控件上传，并按主规格或 SKU 核对页面回显。如果 SHEIN 已从同一首图生成对应方形图，核对后会复用。指定的方形图与已有图片不同、缺图或遇到平台拒收时，侧栏显示对应行和待处理原因。
