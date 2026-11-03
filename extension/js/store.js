// Everything lives in the browser's extension storage. Nothing is sent anywhere.
export const api = globalThis.browser ?? globalThis.chrome;

export const DEFAULT_SETTINGS = {
  hideShorts: true,
  hideWatched: false,
  days: 30,
  replaceHome: false,
  hideRecs: false,
  // layout and navigation
  cardSize: 'm',          // s | m | l
  perChannel: 2,          // videos per channel per section before folding; 0 = never fold
  newTab: false,          // open videos in a new tab
  sidebarSort: 'recent',  // recent | az
  sidebarCollapsed: false,
  group: '',              // the group tab last selected ('' = all)
};

const WATCHED_TTL = 180 * 24 * 3600 * 1000;

export async function load() {
  const d = await api.storage.local.get(null);
  const watched = d.watched ?? {};
  const cutoff = Date.now() - WATCHED_TTL;
  for (const id in watched) if (watched[id] < cutoff) delete watched[id];
  return {
    channels: d.channels ?? {},
    groups: d.groups ?? [],
    settings: { ...DEFAULT_SETTINGS, ...d.settings },
    watched,
    feed: { fetchedAt: 0, mode: null, videos: {}, errors: {}, ...d.feed },
    lastSeenAt: d.lastSeenAt ?? 0,
  };
}

export const save = (data) => api.storage.local.set(data);

export function onExternalChange(fn) {
  api.storage.onChanged.addListener((changes, area) => {
    if (area === 'local') fn(changes);
  });
}
