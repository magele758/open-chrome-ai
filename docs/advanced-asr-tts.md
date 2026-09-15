# 高级功能：自建转写与配音

这两项都是**可选**的。不填设置、不点测试，PageLens 仍然能读网页、问答、点选、管标签。视频总结和同声传译需要 ASR；朗读和配音需要 TTS。

不要把内网 IP、机器路径、账号写进仓库或截图。下面用占位地址。

## 语音转写（ASR）

设置 → 语音转写：

- 预设选 **自建 /v1/transcribe**
- `base_url` 填转写服务根地址，例如 `http://127.0.0.1:8002`（或你的 GPU 主机，不要提交真实地址）
- `model_name`、`api_key` 可空（模型在服务端已加载）
- 识别语言：自动 / 中文 / English

健康检查（浏览器或终端）：

```bash
curl -sS http://127.0.0.1:8002/health
```

期望大致为：`status=ok`，`model_loaded=true`。

上传音视频转写：

```bash
curl -sS -F "file=@/path/to/clip.wav" \
  -F "language=zh" \
  -F "vad_filter=true" \
  http://127.0.0.1:8002/v1/transcribe
```

扩展实际调用同一路径：`POST {base_url}/v1/transcribe`，字段 `file` + `language`（可选）+ `task=transcribe` + `vad_filter=true`。

成功时 JSON 含：

- `text`
- `language`
- `duration`
- `segments`: `{ start, end, text }[]`
- `srt`（扩展目前用 segments 生成时间轴，不强制用 srt）
- `elapsed_sec`

侧栏「一键总结」连本机 `http://127.0.0.1:18789`（`tools/media_helper.py` + yt-dlp + ffmpeg）下载完整音轨，按约 5 分钟一段 POST 这个接口，合并时间戳后保存全文。点总结时若服务未就绪，会经 Native Host 执行 `--ensure` 自动拉起；仍失败则给出 conda 命令，不会改为跟随播放录音。若本机服务已在跑仍提示未启动，到 `chrome://extensions` → PageLens → 网站设置，允许「本地网络」。

```bash
conda create -n pagelens-media -c conda-forge python=3.12 ffmpeg yt-dlp -y   # 只需一次
conda run -n pagelens-media python tools/media_helper.py --ensure
curl -sS http://127.0.0.1:18789/health
```

装了 Native Host 时，再写成 `~/.cache/pagelens-docs` 下的 `original.vtt` / `transcript.md`，不写入 Obsidian 文稿文件夹。长文稿分段阅读后汇总，不截取开头代替全文。「同声传译」始终按声音约 5 秒一片走同一接口。两项可以同时运行，取消各自独立。

也兼容 Groq / OpenAI 形态：`POST {base_url}/audio/transcriptions`。按预设切换即可。

扩展**不会**调用服务端本机路径接口（`/v1/transcribe_path`）。那只适合 GPU 机器上的文件，不适合浏览器。

## 配音（Index-TTS 2.5 / Gradio）

设置 → 配音（高级，可选）：

- 预设 **Index-TTS 2.5（Gradio）**
- `base_url` 例如 `http://127.0.0.1:7860`
- 语言：`ZH` / `EN` / `JA` / `AR` / `ES`
- `duration_factor` 默认 `1.0`
- **参考音色**：上传 3–10 秒 wav，或点 **从当前视频截取音色**（约 7 秒）。只存在本机 IndexedDB。这份参考音供「试听一句」和朗读工具使用；同传默认改用当前分段的原音，不写入或覆盖这份参考音。

Index-TTS 2.5 的 `/gen_single` 共 26 个参数。扩展固定：

- `emo_control_method` = `Same as the voice reference`（与音色参考音频相同，保证克隆同一把声音）
- `prompt` = 参考 wav
- `text` + `lang_choice`（默认 `ZH`）

不是对口型。多人、音乐底、DRM 页效果会差。同传时会关掉原片扬声器，只留中文配音；点「停止同传」后恢复。

「测试连接」只打 `GET {base_url}/gradio_api/info`，确认有 `/gen_single`，不占 GPU。

「试听一句」：`/gradio_api/upload` → `POST /gradio_api/call/gen_single` → 拉回 wav 播放。

Agent 工具 `tts_speak`：用户明确要求朗读短句时才用，最多 500 字。不会自动给整段视频配音。

浏览器也可直接打开 `{base_url}` 看 Gradio 界面。

## 还没接

- 翻译服务（例如独立 MiniCPM 端口）：同传和总结都用文本模型自己译，不接独立翻译端口
- 离线成片、对口型时间轴

**同声传译**：始终在当前观看页进行，不新开后台标签。始终按声音约 5 秒一段走 ASR，不读取站点字幕。配了 TTS 时用该段录音当临时参考。临时参考不写 IndexedDB、不复用全局上传缓存。截取失败才退回设置里的参考音。过短、含噪声或多人混说的参考会影响音色。这不是逐字对口型。

## 不配时的行为

| 功能 | 未配置 ASR | 未配置 TTS |
|---|---|---|
| 读页 / 问答 / 点击 | 正常 | 正常 |
| 「一键总结」 | 请到设置填转写地址，并启动本机媒体服务 | 无关 |
| 「同声传译」 | 请到设置填转写地址 | 仍出中文字幕，没有中文配音 |
| `tts_speak` / 试听 | 无关 | 提示未配置，不报崩 |
