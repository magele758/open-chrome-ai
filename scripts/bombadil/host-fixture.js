import { activeWindowStorageKey, INDEX_KEY, itemKey, normalizeSession, toSummary } from '../../extension/lib/sessions.js';
import { CLIPPINGS_STORAGE_KEY } from '../../extension/lib/clippings.js';

const tabs = ['video', 'article'].map((kind, i) => ({
  id: 17 + i, windowId: 1, title: 'Fixture ' + kind, url: 'https://fixture.invalid/' + kind,
}));
let tab = tabs[0];
const activations = new Set();
document.addEventListener('fixture-activate-tab', event => {
  const next = tabs.find(t => t.id === event.detail);
  if (!next || next === tab) return;
  tab = next;
  for (const listen of activations) listen({ tabId: tab.id, windowId: 1 });
});
const sessions = ['Alpha', 'Beta'].map((name, i) => normalizeSession({
  id: name, createdAt: i + 1, updatedAt: i + 1, pages: [],
  messages: [{ id: 'q-' + name, role: 'user', text: 'Question ' + name },
    { id: 'a-' + name, role: 'bot', text: 'Reading ' + name }],
  // Migrated threads can share a local id in different sessions.
  sideChats: [{ id: 'sc-0', title: 'Note ' + name, forkType: 'selection', parentMessageId: 'a-' + name,
    anchor: { quoteText: name, plainStart: 8, plainEnd: 8 + name.length, status: 'attached' } }],
}));

const clips = [
  { id: 'one', title: 'Scheduler', topics: ['agent', 'queue'], domains: ['Engineering'] },
  { id: 'two', title: 'Notebook', topics: ['agent', 'notes'], domains: ['Research'] },
].map(({ topics, domains, ...clip }) => ({ ...clip, topicIndex: { version: 1, topics, domains }, note: clip.title }));

const listeners = new Set();
function storageArea(area, data) {
  return {
    async get(keys) {
      const names = keys == null ? Object.keys(data) : [].concat(keys);
      return JSON.parse(JSON.stringify(Object.fromEntries(names.filter(k => k in data).map(k => [k, data[k]]))));
    },
    async set(values) {
      const changes = {};
      for (const [key, value] of Object.entries(values)) {
        changes[key] = { oldValue: data[key], newValue: value };
        data[key] = JSON.parse(JSON.stringify(value));
      }
      for (const listener of listeners) listener(changes, area);
    },
    async remove(keys) { for (const key of [].concat(keys)) delete data[key]; },
  };
}

const local = {
  settings: { text: { baseUrl: 'https://model.invalid', model: 'fixture', apiKey: 'fixture' } },
  [INDEX_KEY]: sessions.map(toSummary), [activeWindowStorageKey(1)]: 'Alpha',
  [CLIPPINGS_STORAGE_KEY]: clips, ...Object.fromEntries(sessions.map(s => [itemKey(s.id), s])),
};
const event = { addListener() {}, removeListener() {} };
Object.assign(globalThis.chrome ??= {}, {
  storage: { local: storageArea('local', local), session: storageArea('session', {}),
    onChanged: { addListener(fn) { listeners.add(fn); }, removeListener(fn) { listeners.delete(fn); } } },
  windows: { getCurrent: async () => ({ id: 1 }), getAll: async () => [{ id: 1 }], onCreated: event, onRemoved: event },
  tabs: { get: async id => tabs.find(t => t.id === id), query: async () => [tab],
    onActivated: { addListener(fn) { activations.add(fn); } }, onUpdated: event },
  permissions: { contains: async () => true },
  scripting: { executeScript: async ({ target }) => {
    const source = tabs.find(t => t.id === target.tabId);
    return [{ result: { ...source, video: source === tabs[0] ? { duration: 120, currentTime: 0 } : null,
      videoIsPrimary: source === tabs[0] } }];
  } },
  runtime: { id: 'fixture', onMessage: event, getURL: path => 'https://extension.invalid/' + path,
    sendMessage: async () => ({ ok: false, error: 'Service unavailable in fixture' }) },
});
globalThis.fetch = async () => { throw new Error('Offline UI fixture'); };
