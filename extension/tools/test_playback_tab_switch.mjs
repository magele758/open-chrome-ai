import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const app = fs.readFileSync(new URL('../sidepanel/app.js', import.meta.url), 'utf8');
const refreshStart = app.indexOf('async function refreshTab()');
const refreshEnd = app.indexOf('\nasync function executeLoop');
const refresh = app.slice(refreshStart, refreshEnd);
const captions = app.slice(app.indexOf('function applyCaptions('), app.indexOf('function stopInterpret('));

function el() {
  return { classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } } };
}

function makeRefreshContext({ mode, videoTab, articleTab, loadTabPack }) {
  const video = videoTab || { id: 1, url: 'https://video.test/watch', title: '视频课' };
  const article = articleTab || { id: 2, url: 'https://other.test/post', title: '一篇文章' };
  let queries = 0;
  let stopped = 0;
  const state = {
    tab: { ...video },
    pack: { title: video.title, url: video.url, video: {}, videoIsPrimary: true, captionsText: '旧视频文稿', captionsComplete: true },
    share: true,
    dubPlaying: mode === 'archive',
    mediaTab: null,
    mediaPack: null,
    pageRevision: 0,
    dismissedPage: null,
    originalAudioOn: true,
  };
  const context = vm.createContext({
    state,
    compactSessionOpen: mode === 'compact-playback',
    compactSegments: ['keep'],
    compactGenerationMessage: '',
    compactFullGenerating: false,
    interpretController: {
      isRunning: (id) => mode === 'interpret' && id === video.id,
      getState: (id) => ({ status: mode === 'interpret' && id === video.id ? 'running' : 'idle', tabId: id }),
      getTask: () => ({ originalAudioOn: true }),
      getRunningTasks: () => mode === 'interpret' ? [{ tabId: video.id, url: video.url, title: video.title }] : [],
      stop: () => { stopped += 1; throw new Error('must not stop interpret'); },
    },
    compactController: {
      isRunning: (id) => mode === 'compact-generation' && id === video.id,
      getState: async () => ({ status: 'idle' }),
      stop: () => { stopped += 1; throw new Error('must not stop compact'); },
    },
    chrome: {
      tabs: {
        get: async (id) => {
          assert.equal(id, video.id);
          return { ...video };
        },
      },
    },
    pickTargetTab: async () => { queries += 1; return { ...article }; },
    isTranscribing: () => false,
    restrictedUrl: () => false,
    loadTabPack: loadTabPack || (async (id) => {
      if (id === article.id) return { title: article.title, url: article.url, text: '文章正文', quotes: [] };
      return { title: video.title, url: video.url, video: {}, videoIsPrimary: true };
    }),
    loadPageCaptions: async () => ({ status: 'none' }),
    videoIdentity: () => null,
    loadFullMediaArchive: async () => null,
    syncPackToLibrary: async () => {},
    renderContext() {},
    renderSkills() {},
    renderCompactPlayer() {},
    checkSmartRecall: async () => {},
    stopCompactPlayback: () => { throw new Error('must preserve playback'); },
    stopDubPlayback: () => { throw new Error('must preserve playback'); },
    $: () => el(),
  });
  vm.runInContext(refresh, context);
  return { context, state, video, article, queries: () => queries, stopped: () => stopped };
}

for (const mode of ['interpret', 'compact-generation', 'compact-playback', 'archive']) {
  const { context, state, video, article, queries } = makeRefreshContext({ mode });
  await vm.runInContext('refreshTab()', context);
  assert.equal(queries(), 1, `${mode}: 必须刷新当前页`);
  assert.equal(state.tab.id, article.id, `${mode}: 对话应切到文字页`);
  assert.equal(state.tab.url, article.url, `${mode}: 对话 URL 应是新页`);
  assert.equal(state.pack.title, article.title, `${mode}: pack 应是新页`);
  assert.equal(state.pack.text, '文章正文', `${mode}: 正文应是新页`);
  assert.notEqual(state.pack.captionsText, '旧视频文稿', `${mode}: 文章 pack 不能沿用视频文稿`);
  assert.equal(state.mediaTab.id, video.id, `${mode}: 媒体来源仍是视频页`);
  assert.equal(state.mediaTab.url, video.url, `${mode}: 媒体 URL 不变`);
}

{
  const video = { id: 1, url: 'https://video.test/watch', title: '视频课' };
  const article = { id: 2, url: 'https://other.test/post', title: '一篇文章' };
  let resolveStale;
  let loads = 0;
  const { context, state } = makeRefreshContext({
    mode: 'interpret',
    videoTab: video,
    articleTab: article,
    loadTabPack: async (id) => {
      const n = ++loads;
      if (n === 1) {
        await new Promise((r) => { resolveStale = r; });
        return { title: '过期页', url: article.url, text: 'STALE' };
      }
      return { title: article.title, url: article.url, text: 'FRESH' };
    },
  });
  const first = vm.runInContext('refreshTab()', context);
  await Promise.resolve();
  const second = vm.runInContext('refreshTab()', context);
  await second;
  resolveStale();
  await first;
  assert.equal(state.pack.text, 'FRESH', '迟到的 loadTabPack 不得写回旧页');
  assert.equal(state.tab.id, article.id);
  assert.equal(state.mediaTab.id, video.id);
}

{
  const video = { id: 1, url: 'https://video.test/watch', title: '视频课' };
  const article = { id: 2, url: 'https://other.test/post', title: '一篇文章' };
  const { context, state } = makeRefreshContext({ mode: 'interpret', videoTab: video, articleTab: article });
  await vm.runInContext('refreshTab()', context);
  vm.runInContext(captions, context);
  context.applyCaptions({ tabId: video.id, status: 'ready', source: 'interpret', text: '同传字幕', complete: true });
  assert.equal(state.pack.text, '文章正文', '字幕不得改写文章正文');
  assert.notEqual(state.pack.captionsText, '同传字幕', '字幕不得写入文章 pack');
  assert.equal(state.mediaPack.captionsText, '同传字幕', '字幕应写入媒体 pack');
}

{
  const video = { id: 1, url: 'https://video.test/watch', title: '视频课' };
  const { context, state, queries } = makeRefreshContext({
    mode: 'interpret',
    videoTab: video,
    articleTab: video,
    loadTabPack: async () => ({ title: video.title, url: video.url, video: {}, videoIsPrimary: true, captionsText: '视频文稿' }),
  });
  state.mediaTab = { ...video };
  state.mediaPack = { title: video.title, url: video.url, video: {}, captionsText: '媒体文稿' };
  await vm.runInContext('refreshTab()', context);
  assert.equal(queries(), 1, '切回视频页仍要读当前页目标');
  assert.equal(state.tab.id, video.id);
  assert.equal(state.pack.captionsText, '媒体文稿', '切回视频页复用媒体 pack');
}

{
  const video = { id: 1, url: 'https://video.test/watch', title: '视频课' };
  const { context, state } = makeRefreshContext({
    mode: 'interpret',
    videoTab: video,
    articleTab: video,
    loadTabPack: async () => ({ title: video.title, url: video.url, video: {}, videoIsPrimary: true, text: '不应读取' }),
  });
  state.share = false;
  state.dismissedPage = { ...video };
  state.pack = { title: video.title, text: '旧正文' };
  await vm.runInContext('refreshTab()', context);
  assert.equal(state.share, false, '去掉网页后停在同一页不应恢复');
  assert.equal(state.pack, null, '去掉网页后不应继续带旧 pack');
  assert.equal(state.mediaTab.id, video.id, '去掉网页上下文不得停同传');
}

{
  const { context, state, video, article } = makeRefreshContext({ mode: 'interpret' });
  state.share = false;
  state.dismissedPage = { ...video };
  await vm.runInContext('refreshTab()', context);
  assert.equal(state.share, true, '切到新网页应恢复带上当前页');
  assert.equal(state.dismissedPage, null);
  assert.equal(state.tab.id, article.id);
  assert.equal(state.pack.title, article.title);
  assert.equal(state.pack.text, '文章正文');
  assert.equal(state.mediaTab.id, video.id, '恢复网页上下文不得停同传');
}

console.log('PASS interpret stays on the video while chat context follows the article page');
