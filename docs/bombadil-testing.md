# PageLens 的 Bombadil 测试流程

从仓库根目录运行。先跑确定性的操作序列，再让独立 Chromium 对同一批界面做属性测试。核对功能范围时可对照[产品 PRD](02-prd.md)、[SideChat PRD](sidechat-prd.md)、[侧栏改版验收标准](sidepanel-redesign-development.md)和[产品功能地图](feature-map.md)。

| 场景 | 测试操作 | 成功条件 |
| --- | --- | --- |
| [设置](../scripts/bombadil/settings.spec.js)，400px | 点击两个标签，使用方向键、Home、End | 基础和高级都实际显示过。选中项、面板和键盘焦点一致，未保存的模型名保留 |
| [主侧栏](../scripts/bombadil/panel.spec.js)，400px／900px | 从 Alpha 的旁注写草稿，经历史打开 Beta，再回 Alpha；打开旁注列表、标记掌握，切换设置／盘点／对话，展开或收起视频工具，移除网页上下文后从视频标签切到文章 | 两份草稿分别出现，返回 Alpha 时恢复原稿。旁注标题、引文和掌握标记属于当前会话；窄屏抽屉遮罩与宽屏分栏对应；历史搜索结果、分组折叠和当前视图标记一致；媒体按钮状态对应面板；切到文章后重新带上该页上下文 |
| [剪藏知识图谱](../scripts/bombadil/graph.spec.js)，900px | 选择领域、搜索标题或主题、点击主题与关联主题，输入无匹配词后恢复 | 实际到过双来源、单来源、领域筛选和空结果。主题索引、当前选中项、图谱中心以及来源列表符合两份已知剪藏 |

主侧栏和图谱使用生产 HTML、样式和入口模块。用于驱动它们的 Chrome API、标签元数据、剪藏及会话是本地测试数据。旁注和图谱的自定义动作直接触发 DOM 控件事件，设置用例还会生成浏览器点击和按键。Markdown 富文本渲染、指针遮挡、系统权限弹窗、文件选择器、推理服务和音视频质量需要各自的专项检查。同传变更仍按 [AGENTS.md](../AGENTS.md) 做真实服务验证。

## 本地运行

需要仓库依赖、Node 22 的受支持补丁版本或更新版本。第一条安装依赖，第二条构建侧栏依赖并运行固定序列，第三条启动 Bombadil 0.7.10。随机测试需要可用的 Chrome 和本地回环端口。有多个浏览器时，环境变量 `CHROME` 可指定独立测试浏览器的可执行文件。

```sh
npm ci
npm run test:bombadil:smoke
npm exec --yes --package=@antithesishq/bombadil@0.7.10 -- npm run test:bombadil
```

已有对应版本的 `bombadil` 时可直接使用下面的入口。默认依次跑四组，每组探索 45 秒。单场景可以指定视口和时间预算；输出目录下每次都会新建一份结果。

```sh
npm run test:bombadil -- --case panel --width 400 --time 5m --output /tmp/pagelens-runs
```

运行器只在 `127.0.0.1` 上提供生成的测试页，并接收该页根据 DOM 状态发出的覆盖记录。主侧栏先走完跨会话草稿往返，再探索其他动作。即使 CLI 返回 0，缺少 trace 或必要界面状态仍会导致失败。覆盖记录衡量用户到达过的状态；`elapsedMs` 是测试耗时，无法据此推断界面响应速度或源码行覆盖率。

## PR 和手动运行

[GitHub Actions 工作流](../.github/workflows/bombadil.yml)在相关 PR 上并行运行四组，单组失败后其他组继续。也可以在 **Actions → Bombadil UI → Run workflow** 选择每组 45 秒或 5 分钟。CI 会安装独立 Chrome，使用合成数据，保留各组产物七天。确定性序列也通过现有的 `npm test` 执行。

打开 artifact 中包含 `run.json` 的场景目录。里面的 `fixture.html` 是当次页面，`spec.js` 包含当次属性及其本地依赖，`run.json` 记录场景、视口、端口、源码提交、CLI 版本及显式指定的 Chrome 版本；正常启动的 CLI 退出后会写 `report.json`。遇到启动或安装错误而缺少报告时，看对应 job 的日志。

| report.json 的 status | 如何处理 |
| --- | --- |
| `passed` | 查看 `visited` 核对实际到达的状态 |
| `violation` | 查看 trace 中最早失败的属性和前一个动作，再运行固定序列复现 |
| `insufficient-coverage` | 看 `missing`，检查对应动作或控件是否可达 |
| `missing-trace`、`runner-error` | 检查 CLI、Chrome、端口及进程日志 |

## 复查失败

下载并解压 artifact，切换到相同代码版本，并使用相同版本的 Bombadil 和 Chrome。把 `CASE_DIR` 指向刚才的场景目录。第一条查看时间线和截图；第二条会在记录的端口启动保存下来的夹具，使用原视口、保存的 spec 和原 trace 进行重放，并把重放结果写到新的目录。

```sh
CASE_DIR=/path/to/panel-400
bombadil browser inspect "$CASE_DIR/trace"
npm run test:bombadil -- --replay "$CASE_DIR"
```

重放属于 best-effort，可能发生分歧。可稳定重现的错误应在[固定序列](../extension/tools/test_bombadil_flows.mjs)或相应功能测试里保留最短回归路径。上游细节见 [CLI 手册](https://antithesishq.github.io/bombadil/browser/5.1.1-bombadil-browser-test.html)。
