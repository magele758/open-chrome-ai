# 同传评估素材

`01`–`04` 是固定输入素材，评估器直接调用生产规划逻辑。

- `mock-evaluation-report.json`：离线结构测试结果；占位译文和估算配音时长不能用于判断真实质量或性能。
- `baseline.json`、`sentence-report.json`：旧评估器的历史输出，仅保留作对照，不是当前修复的验收证据，不可据此宣称语义模式质量提升。
- `live-evaluation-report.json`（显式运行真实模型评估后生成）：使用实际模型译文；配音时长若仍使用估算，同样不能视为实机播放延迟。

执行 `npm run eval:interpret` 进行离线结构检查；使用 `node extension/tools/eval_interpret_quality.mjs --live` 运行真实模型评估。真实翻译需配置 `INTERPRET_EVAL_TEXT_*` 或 `PAGELENS_TEXT_*`，具体校验以脚本为准。不要将含凭据的配置或私人素材写入评估结果。
