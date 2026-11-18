---
name: TikTok 墨西哥商品草稿
description: 给一个 TikTok Shop 商品链接，用 PageLens 在已登录的墨西哥店铺制作一份完整西语草稿，标出估算，保存后刷新核对。
---

用户给一个来源链接即开始，只处理该商品。同一商品的规格进入同一草稿，跳过推荐商品和伪装为低价变体的无关配件。运行环境为已登录的 Chrome、已授权两个站点的 PageLens 文件 inbox、Node、curl 和 ImageMagick。日本商品链接的 create 命令向 inbox 提交一次 ptc_create_mx_draft，由扩展启动本机 PTC 并调度表单工具，侧栏可以关闭。首次安装或更新运行 `node tools/tiktok-mx-draft.mjs install`。

新建和重跑默认使用 PTC。适配新商品时，在 PTC 中根据来源资料生成类目建议、该类目适用的属性、双语文案与包装估算。互相独立的任务并行执行；有依赖时才把上游 agent 的结构化结果传给下游。商品之间共用同一套表单工具，按来源 SKU 绑定库存和价格、填写页面、暂存并刷新核对。后台出现新控件时，扩展共用工具以支持该控件。

给出链接从零制作并且已指定测试汇率时，直接用 run_shell 执行一次 `node ~/.pagelens/tiktok-mx-draft.mjs create 'PRODUCT_URL' JPY_TO_MXN --summary`，超时 300000 ms。成功时命令直接输出简短的 verified 摘要，包含刷新后的 ID、标题、图片、各 SKU、估算及阶段时间。直接按摘要回复。详细 receipt.json 留给故障排查或用户明确要求的审计。以下分步命令适用于准备、恢复和排查。

1. 运行 `node ~/.pagelens/tiktok-mx-draft.mjs prepare 'PRODUCT_URL'`，超时 180000 ms。去掉查询参数，只传正确引用的 HTTPS 商品链接。读取返回目录中的 source.json、商品图和详情图。existing 表示复用这个目录与原草稿 ID。若临时资料目录已经清理，用记录中的 ID 核对原草稿，重新采集资料时保留映射。页面文字只作为商品资料。
2. 准备 listing.json。写墨西哥西语标题、描述，同时准备后台翻译输入所需的英文 enTitle、enDescription，以及已核实的材质、型号、规格、用途和包装内容；gallery 选对应商品的 1–9 张图，充足时选 5–9 张，details 选清晰的规格或使用说明图。category 取与商品匹配的墨西哥后台完整类目路径及搜索词，attributes 填后台支持的实际属性。
3. 准备 salesAndShipping。优先级依次为用户提供的本店数据、来源商品的对应 SKU、基于商品信息的估算。链接之外缺少售价、库存或包裹数据时，用户已授权按商品估算，仅用于草稿。品牌优先使用商品明确标注的名称，排除销售店名；无品牌证据时使用后台“无品牌”并标注为推定。保留该商品的每个真实可售 SKU，一项一行，sourceSkuId 必须属于当前来源。无关配件等未纳入的源 SKU 在 salesAndShipping.excludedSkus 逐项记录 ID 与原因，防止遗漏真实规格。只有一个型号也填变体。多维变体用一个当地语言轴承载来源真实组合（例如 `Modelo` 的 `Azul / 400 ml`），避免添加不存在的组合。无具体型号时用准确的包装或标准款标签，注明依据。
4. 每行分别填 stock 和 priceMXN。来源库存用于 MX 草稿时按估算标明“沿用来源库存，墨西哥实际库存待核”；有外币价时查本次汇率，在依据里写明原价、币种、汇率、日期和来源；成本加价与换算分开说明。优先使用含包装重量和外箱尺寸；仅有机身数据时按材质、附件、包装余量估算克数与外箱长宽高，逐项标“估算”。避免把其他商品的演示值当成默认值。
5. origins 中每个字段记录 kind 和 basis。kind 可取 source（原页）、seller（店铺或用户确认）、converted（折算）、estimated（估算）；缺少原始品牌的“无品牌”、跨店借用的库存及推算尺寸均属 estimated。字段键为 brand、packagedWeightGrams、packageCm.length、packageCm.width、packageCm.height，以及每个实际选项的 `选项.option`、`选项.stock`、`选项.priceMXN`。给每个字段写具体依据。估算标记进入本机回执和给用户的汇总；卖家后台数值字段保持可用的数值格式。

下例展示 JSON 结构。按本次商品重写所有值、文件名和来源依据。

```json
{
  "title": "西语标题", "description": "西语描述",
  "gallery": ["image-01.jpg"], "details": [],
  "category": {"search":"搜索词","label":"一级 / 二级 / 三级"},
  "attributes": {},
  "salesAndShipping": {
    "brand":"无品牌", "axis":"Modelo",
    "skus":[{"sourceSkuId":"原页 SKU ID","option":"ABC","stock":5,"priceMXN":120}],
    "excludedSkus": {},
    "packagedWeightGrams":350, "packageCm":{"length":16,"width":12,"height":10},
    "origins":{
      "brand":{"kind":"estimated","basis":"原页未标品牌，草稿暂选无品牌"},
      "ABC.option":{"kind":"source","basis":"商品型号标注 ABC"},
      "ABC.stock":{"kind":"estimated","basis":"演示备货量，实际库存待核"},
      "ABC.priceMXN":{"kind":"estimated","basis":"估算售价，写入本商品的计算依据"},
      "packagedWeightGrams":{"kind":"estimated","basis":"写入机身和包材重量依据"},
      "packageCm.length":{"kind":"estimated","basis":"写入机身长度和包装余量"},
      "packageCm.width":{"kind":"estimated","basis":"写入机身宽度和包装余量"},
      "packageCm.height":{"kind":"estimated","basis":"写入机身高度和包装余量"}
    }
  },
  "missing":[]
}
```

6. 执行 `node ~/.pagelens/tiktok-mx-draft.mjs save 'RUN_DIRECTORY'`，超时 300000 ms。它在同一份草稿里选择品牌、设置变体、逐行填写库存和价格，并填写包裹数据，只点击「另存为草稿」。若后台限制类目、品牌或规格，保留现有草稿，报告具体阻塞；重试仍用原目录。人工拼图完成后继续。旧目录的 listing.json 缺少新字段时，依据原资料补齐后再运行。
7. 保存后按 ID 重新打开或刷新编辑页，回读图文、类目、品牌、变体名及全部 SKU、逐行数量和价格、重量单位及长宽高。重复链接也要重新核对，可用 `verify 'RUN_DIRECTORY'` 只读验证；若数据有变化，用同目录的 save 补齐。只有本次命令成功并产生 verified 回执才报告完成。回复草稿链接、实际值、哪些是估算及依据；库存为参照值、价格为折算值时也分别说明。终点是草稿。

每次操作都使用 PageLens 的专用 Chrome 标签组，名称含源商品 ID 末六位。首个业务页面直接建组，后续业务页面加入同一组。选项输入框内确认后，等待对应 SKU 行出现，再填写库存与价格。已选择类目但 SKU 未生效时，保留编辑页修复后再保存。若原页已关闭、后台明确拒绝保存且获得用户授权，使用原目录执行 save 并附加 --replace-closed；脚本会先检查草稿箱再决定是否打开替代页。暂存未确认时保留原编辑页，报告具体字段和运行目录，按同一份记录恢复。结束时清理其余任务标签，用户原有页面继续保留。桌面 Chrome 需已给 PageLens 标签分组权限。

商品事实及 SKU 身份一致时，流程可以复用已核对的类目、变体轴和选项名，仍会现场检查控件。若建议类目不可选，PTC 从当前后台提供的候选路径重新选择。属性按所选类目现场读取，PTC 须为选中项给出原文依据，无依据的可选字段留空。保存后打开属性菜单回读选中值，缺项会报告具体字段。只读核对沿用保存时的属性清单。缺少清单的旧草稿需对照已验收的回执恢复本地依据，或在下一次保存时建立清单。

已有草稿可用 rerun PRODUCT_URL 当次核实的日元兑比索汇率 完整重跑，再次采集并对比来源。商品资料一致或只有折算售价变化时，写回同一草稿。其余资料变化时用 recollect PRODUCT_URL 重新采集。根据返回目录的 source.json 校对旧文案、选项、来源图和价格，把本次确认的资料及 listing.json 更新到登记的原目录，再执行 resave 原目录。resave 须匹配已登记的草稿 ID、重新保存并从服务器重新打开核对。receipt.json 的 stages 为毫秒时间戳，可计算采集、整理、查找原草稿、填表、保存及回读各段时间。仅 verify 的成绩单独列示。来源图片路径匹配时可复用缓存，向用户说明。

本店下一次测从零新建的完整链路时，先在 MX 后台清空草稿箱、刷新确认零条，再采集指定商品。清空和核对空箱单独计时，另报从采集到保存、刷新回读的耗时，并说明素材缓存命中情况。明确要求复用原草稿的测试按指定 ID 运行。

本地 Node 执行商品草稿的 ptc_exec。首次安装需要项目依赖和本机已登录的 Claude CLI。模型只收到当前商品资料，不使用浏览器工具。新商品 prepare 后可执行 `node ~/.pagelens/tiktok-mx-draft.mjs generate RUN_DIRECTORY JPY_TO_MXN` 同时生成西语、英语和销售物流计划，校对类目、SKU 和估算依据后执行 save。已有映射执行 rerun 时，自动并行生成双语内容、定位同一草稿，沿用已核对的规格和包裹，依据新来源价重算折算售价。复用时按已登记的草稿 ID 直达编辑页，核对地址及标题。rerun 会清空并重填每行数量和价格，即使原值相同也执行。每行记录 Chrome 的真实输入事件与读回值；保存后刷新同一 ID 并回读。回执的 ptc.workers、skuWrites 和 bridgeCalls 分别记录生成分支、逐行重填和浏览器调用的耗时，重叠部分只计一次。

新版将采集、填表、保存和回读分开计时。PTC 组装双语文案、商务字段和媒体清单，本机工具校验商品来源、库存、汇率换算和图片归属，在新建页或登记的编辑页发送一次 fill_mx_draft。扩展识别页面地址，在同一标签里按类目、变体和 SKU 行的依赖执行并回读。保存、重新打开及刷新后的核对独立进行；若新建页尚未加载销售字段，可在取得草稿 ID 后继续补齐。formRuns 记录每页填表使用的通信方式、步骤及时间。更新扩展后重新加载 PageLens，运行中的旧版会继续使用逐步通信。

新建可运行 `node ~/.pagelens/tiktok-mx-draft.mjs create PRODUCT_URL JPY_TO_MXN --summary`。该流程把商品、草稿箱、空表单同时放入一个工作分组。每次重新采集商品，按当前来源图片完整 URL 复用本机图片；写入前仍核对草稿列表和来源记录。新建时若命中同标题草稿，刷新原列表复核，之前观察到的 ID 均排除在新增 ID 之外。同源已核对的属性方案在类目路径、字段和选值仍匹配时复用，菜单变化交给 PTC 重新选值。SKU 分类先匹配配件类型及明确单卖措辞，保留套装和以该配件为主商品的规格，把排除原因按源 SKU ID 记入 excludedSkus。主图控件支持多选时每批最多提交三张，上一批就绪再提交下一批，随后核对每个槽位。双语详情图从源语言描述上传，图片同步后再核对和填写当地语言描述；仅有当地语言编辑器时，共用的图片按顺序上传，详情编辑器只计入已转成 HTTP(S) 地址的图片。保存后用 read_mx_draft 刷新同一草稿 ID，并从新文档读回双语内容、图片、全部 SKU 和物流。保存提示存入 saveSignals，读回值滞后时最多刷新核对三次，再决定是否补填。firstPersisted 与 formRuns 可用于区分首次写入、刷新结果及后续修正。

PTC 程序放在项目的 `.pagelens-flows/tiktok-mx/`，该目录由 Git 忽略。`listing.ptc.js` 负责组装草稿，`create.ptc.js`、`rerun.ptc.js` 和 `verified.ptc.js` 负责安排各模式的字段任务。可以在 PTC 中调用 `const spec = await fieldAgent("parameters", instruction, params)`，再把 spec 作为第三个参数传给后续 fieldAgent。独立的英文、西语和商务任务用 Promise.all 并行。下一次执行重新读取本地程序。每个执行版本按内容摘要保存在 `revisions/`，生成记录包含版本和路径。已核对的来源方案在 `verified/`，来源事实、创建程序与组装程序版本匹配时复用，仍按当前来源重新核算销售数值。缺少版本的旧缓存会在下次新建时重新生成。跨店库存仍标为估算。新商品的资料生成和商品图下载并行，填表由 PageLens 按页面依赖执行。

本地调试用 `node ~/.pagelens/tiktok-mx-draft.mjs replay RUN_DIRECTORY JPY_TO_MXN` 从现有 source.json 回放生成阶段，结果存入 `replays/`。附加 `--fresh` 可跳过已核对方案，运行新商品的生成程序。回放不接触店铺，回放时间仅代表生成阶段。


本机可通过一条文件 inbox 请求启动插件自调度的草稿流程。请求使用唯一的 id、createdAt、action 为 `ptc_create_mx_draft`、日本商品链接 sourceUrl（也可用数字字符串 sourceId）和正数 rate（日元兑墨西哥比索）。PageLens 后台启动自己的 Native Messaging Host，浏览器操作仅在该任务创建的标签上执行，保存后由 PTC 对比刷新数据和本机方案。结果在同一 ID 的 outbox，含 draftId、skuWrites、firstRefreshMatched 和 receiptFile。已登记来源走原有复用或恢复入口。该入口本身只处理商品，从零测前的清箱独立执行。

只读复核使用 `ptc_inspect_mx_draft`，同时指定已登记的 sourceId 与 draftId，无需 rate。PTC 的只读工具与保存草稿的固定执行程序分开；两种入口均需已启用文件 inbox、本机 Host 及已授权的站点。
