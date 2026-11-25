# Temu 商品上架

选择商品目录或填写商品描述，再点击「开始上品」。PageLens 会推荐类目并在本次进入的商品编辑页核对表单回显。页面可能在进入第二步时分配草稿编号。

商品目录中的来源售价与申报价分别保存。申报价、发货承诺、产地和运费模板使用明确的输入。材质等类目属性从 Temu 的实时字段和可见选项读取。开启上品助手并有可用商品图时，可补齐清晰可辨的通用材质。流程会在上传后复查能准确定位的校验问题，缺少证据或回读失败时显示待核对。

在 `product.json` 中用 `temu.attributes` 指定适用于当前类目的属性。字段可用 Temu 页面标签、标签的中文或英文部分，或 `productProperties[数字]` 键。单项可以写字符串，多选请写数组。可在 `temu.composition` 中按原始商品资料声明成分和比例，每行包含 `material` 和 `percent`，合计为 100%。SKU 独立提供 `price`、`quantity`、`weightG`、`lengthCm`、`widthCm`、`heightCm`，以及可选的 `retailPrice` 和 `packageContents`。

服装每个颜色的 `variantGroups[].options[].imagePath` 对应第一张轮播图。用同一选项的 `galleryImages` 数组按顺序补充材质效果、版型效果、细节特写和工艺特写。多个颜色共用这些图时，可以填写 `temu.sharedGalleryImages`。颜色有自己的 `galleryImages` 时优先使用该数组。图片路径写成相对于当前商品目录的路径，例如 `images/blue-main.jpg`。

货源的颜色名称与 Temu 色值不同时，在颜色选项上填当前类目的 `temuValue`。例如保留货源名称「黑白条纹」，用页面支持的「花色」作为 Temu 色值。SKU 和图片仍按货源颜色绑定。

图片上传需要本次勾选同意。素材中心出现新素材后，先核对文件名和素材标识，再把图片选入商品轮播、SKU 预览或详情装修。详情装修使用它自己的「保存」应用编辑结果。商品试填止于主表单复核。若出现无法复核的页面状态，侧栏显示回读未完成。服装尺码按当前页面可用选项匹配；颜色超过 20 个时保留目录内容，试填其余可填写字段。

目录输入和试填边界可分别运行 `node scripts/run-tests.mjs test_temu_listing_input test_temu_listing` 验证。
