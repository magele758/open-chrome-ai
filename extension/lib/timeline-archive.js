import { loadFullMediaArchive } from "./audio-composer.js";
import { linesToCaptions } from "./interpret.js";
import { withInterpretDeadline } from "./interpret-semantic.js";
import { videoIdentity } from "./library.js";

export async function loadTimelineArchive(url) {
  const id = videoIdentity(url);
  const archive = await loadFullMediaArchive(id);
  if (!archive?.audioBlob || archive.complete === false) return null;
  // Bilibili parts share a BV number but have independent audio timelines.
  if (id.startsWith("bili:")) {
    const part = value => new URL(value).searchParams.get("p") || "1";
    if ((archive.url ? part(archive.url) : "1") !== part(url)) return null;
  }
  const header = String.fromCharCode(...new Uint8Array(await archive.audioBlob.slice(0, 12).arrayBuffer()));
  if (!header.startsWith("RIFF") || header.slice(8) !== "WAVE") return null;
  // Keep only the timeline track alive during playback, not the compact WAV or its buffers.
  const { audioBlob, duration, lines, cues } = archive;
  return { audioBlob, duration, lines, cues };
}

// This runs in the same offscreen task as generated interpretation. The tab's
// player remains the clock, including after the side panel closes or reopens.
export async function playTimelineArchive(archive, { video, signal, onEvent, wantOriginalAudio, createAudio = url => new Audio(url) }) {
  const lines = archive.lines?.length ? archive.lines : (archive.cues || []).map(cue => ({ ...cue, zh: cue.text }));
  const url = URL.createObjectURL(archive.audioBlob);
  let audio, shown, revision, watching = false;
  try {
    audio = createAudio(url);
    await video("watch", { initiallyPlaying: true });
    watching = true;
    const state = await video("state");
    signal.throwIfAborted();
    if (!state?.ok) throw Error("播放器已关闭");
    audio.currentTime = state.currentTime || 0;
    if (!wantOriginalAudio?.() && !(await video("silence"))?.ok) throw Error("无法切换原声");
    signal.throwIfAborted();
    const playing = await video("control", { action: "play", system: true });
    if (!playing?.ok || playing.paused) throw Error("无法恢复视频播放");
    const message = "正在播放已缓存的同传配音";
    onEvent({ type: "status", message });
    for (;;) {
      signal.throwIfAborted();
      const live = await video("state");
      signal.throwIfAborted();
      if (!live?.ok) throw Error("播放器已关闭");
      if (live.ended) break;
      if (audio.error) throw Error("缓存配音播放失败");
      const time = live.currentTime || 0;
      if (revision !== live.seekRevision || Math.abs(audio.currentTime - time) > 0.3) audio.currentTime = time;
      revision = live.seekRevision;
      audio.playbackRate = live.playbackRate || 1;
      if (live.paused || live.seeking || live.readyState < 3) audio.pause();
      else if (audio.paused && !audio.ended) {
        await withInterpretDeadline(() => audio.play(), signal, 15000, { stage: "缓存配音播放" });
      }
      const line = lines.find(line => line.start <= time && line.end > time);
      if (line !== shown) {
        shown = line;
        onEvent(line ? { ...line, type: "line", editable: false } : { type: "status", message, clearLine: true });
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    return { mode: "audio", lines, captions: linesToCaptions(lines), complete: true };
  } catch (error) {
    if (!signal.aborted) await video("control", { action: "pause", system: true }).catch(() => {});
    throw error;
  } finally {
    if (audio) { audio.pause(); audio.src = ""; }
    URL.revokeObjectURL(url);
    await video("restore").catch(() => {});
    if (watching) await video("unwatch").catch(() => {});
  }
}
