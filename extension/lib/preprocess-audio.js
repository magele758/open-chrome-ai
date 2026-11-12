import { loadFullMediaArchive } from "./audio-composer.js";
import { dubArchiveVersion } from "./interpret-policy.js";
import { runPlannedInterpret } from "./planned-interpret.js";
import { isTtsReady } from "./storage.js";

export async function preprocessAudio(row, settings, progress, signal) {
  const archive = await loadFullMediaArchive(row.id);
  signal?.throwIfAborted();
  if (archive?.complete && archive.hasAudio && archive.hasCompactAudio &&
      archive.processingVersion === dubArchiveVersion(settings.asr)) return archive.expireAt;
  if (!isTtsReady(settings.tts)) throw Error("请先配置语音合成（TTS）");
  let expiry, warning;
  await runPlannedInterpret({
    sourceUrl: row.url, title: row.title, settings, signal, audioOnly: true, generateFull: true,
    // Resolve the source captured at enqueue time even after its tab closes.
    video: async cmd => cmd === "media" ? row.media : undefined,
    onEvent(event) {
      if (event.type === "status") progress(event.message);
      if (event.type === "generation_progress") progress(`已配音 ${event.ready} 句 · 已分析 ${Math.round(event.covered)} / ${Math.round(event.duration)} 秒`);
      if (event.type === "warn") warning = event.message;
      if (event.type === "archive_saved") expiry = event.archive.expireAt;
    },
  });
  if (!expiry) throw Error(warning || "没有可保存的完整配音");
  return expiry;
}
