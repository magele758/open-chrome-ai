import { injectVideo, injectPageAudio, sleep } from './chrome.js';
import { beginPageCapture, discardCapture } from './tab-audio.js';

/** Owns exactly one temporary background tab. The visible tab is never used
 * for capture, so pausing it to buffer cannot deadlock the producer.
 */
export async function createInterpretSource(tabId, start, signal) {
  const original = await chrome.tabs.get(tabId);
  const picked = await injectVideo(tabId, 'state');
  const source = await chrome.tabs.create({ url: original.url, active: false });
  let capture;
  const check = () => signal?.throwIfAborted();
  const close = async () => {
    if (capture) await discardCapture(capture).catch(() => {});
    await chrome.tabs.remove(source.id).catch(() => {});
  };
  try {
    const deadline = Date.now() + 30000;
    let ready = false;
    while (Date.now() < deadline) {
      check();
      try {
        const state = await injectVideo(source.id, 'state', { index: picked.index });
        // Avoid collecting pre-roll advertising as though it were the video.
        if (state?.ok && state.duration > 0 && Math.abs(state.duration - picked.duration) < 3) { ready = true; break; }
      } catch { /* the tab may still be navigating */ }
      await sleep(250);
    }
    if (!ready) throw new Error('后台视频未能加载到相同内容，请等待页面广告结束后重试同传。');
    const seek = async (seconds, epochSignal = signal) => {
      epochSignal?.throwIfAborted();
      const result = await injectVideo(source.id, 'seek', { seconds, paused: true });
      if (!result?.ok) throw new Error('后台视频无法定位到所选时间。');
      const until = Date.now() + 15000;
      while (Date.now() < until) {
        epochSignal?.throwIfAborted();
        const state = await injectVideo(source.id, 'state');
        if (!state.seeking && state.readyState >= 2 && Math.abs(state.currentTime - seconds) < 0.5) {
          if (capture) await injectPageAudio(source.id, 'take');
          return;
        }
        await sleep(100);
      }
      throw new Error('后台视频定位超时，请检查视频是否可以拖动进度。');
    };
    await seek(start);
    check();
    capture = await beginPageCapture(source.id, { fromStart: false });
    return { ...capture, seek, close };
  } catch (error) {
    await close();
    throw error;
  }
}
