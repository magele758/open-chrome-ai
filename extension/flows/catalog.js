const productCapture = {
  id: "product-capture", name: "提取商品",
  description: "读取当前商品详情，保存资料或导出图片目录。",
};

export const workflowPlatforms = [
  { id: "shopee", name: "Shopee", icon: "shopee.png", features: [
    { id: "product-listing", name: "商品上架", description: "单个或目录批量试填，支持主图、SKU 图和尺码表。" },
    { id: "campaign-data", name: "活动数据", description: "读取官方活动、商品提报和店铺促销，支持中文翻译和导出。" },
    { id: "campaign-draft", name: "活动表单试填", description: "试填折扣名称，查看活动时段和商品要求。" },
    { id: "voucher-data", name: "优惠券数据", description: "整理领取期限、折扣、使用量和状态，支持导出。" },
    { id: "voucher-draft", name: "优惠券表单试填", description: "试填店铺固定金额券，核对券码、门槛和数量。" },
  ] },
  { id: "temu", name: "Temu", icon: "temu.png", features: [
    { id: "temu-product-listing", name: "商品上架", description: "按站点与类目逐步试填，读取商品目录并上传图片。" },
    { id: "temu-product-data", name: "商品数据", description: "读取商品列表的商品、经营站点、SKU、库存和价格。" },
    { id: "temu-campaign-data", name: "活动数据", description: "读取营销活动、报名记录与结果。" },
    { id: "temu-campaign-draft", name: "活动报名试填", description: "在已打开的报名表填写活动价格与库存。" },
    { id: "temu-marketing-data", name: "营销数据", description: "读取商品推广页的可见报表。" },
    { id: "temu-order-data", name: "订单数据", description: "导出当前订单筛选范围内的业务字段。" },
    { id: "temu-finance-data", name: "资金数据", description: "读取资金中心、对账和结算页面中的数据。" },
    productCapture,
  ] },
  { id: "shein", name: "SHEIN", icon: "shein.png", features: [
    { id: "shein-product-listing", name: "商品上架", description: "读取当前类目的表单，用商品资料试填并核对结果。" },
  ] },
  { id: "amazon", name: "Amazon", icon: "amazon.png", features: [productCapture] },
  { id: "tiktok-shop", name: "TikTok Shop", icon: "tiktok-shop.png", features: [
    { id: "tiktok-mx-draft", name: "墨西哥商品草稿", skillName: "TikTok 墨西哥商品草稿",
      description: "打开草稿技能，在对话中补充商品链接后发送。" },
  ] },
  { id: "zhfulfill", name: "智猴云仓", icon: "zhfulfill.png", features: [productCapture] },
];
