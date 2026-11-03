import { api, load, save, onExternalChange } from './store.js';
import { fetchChannel, resolveChannel, FeedError } from './feeds.js';
import { parseSubscriptionFile } from './importers.js';

const DAY = 864e5;
const STALE_MS = 15 * 60 * 1000;
const CONCURRENCY = 6;
const YT = 'https://www.youtube.com';
const SESSION_KEY = 'yourhome-session';

let state;          // { channels, groups, settings, watched, feed, lastSeenAt }
let newSince = 0;   // videos published after this are marked "New" during this visit
let query = '';
let refreshing = null;     // { done, total } while a refresh runs
const pending = new Set(); // channels added while a refresh was running
let fullPending = false;   // a full refresh was asked for while one was running
let expanded = new Set();  // "section|channelId" folds opened during this visit
let editing = null;        // the group being edited: { original, picked }

const $ = (sel, root = document) => root.querySelector(sel);
const channelFilter = () => new URLSearchParams(location.hash.slice(1)).get('c') ?? '';

// ---- tiny DOM helpers --------------------------------------------------------

function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  el.append(...children.flat().filter((c) => c != null && c !== false));
  return el;
}

function icon(paths) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = paths;
  return svg;
}

const ICON_CHECK = '<path d="m5 12.5 4.5 4.5L19 7.5"/>';
const ICON_EYE_OFF = '<path d="M3 3l18 18M10.6 6.1A9.8 9.8 0 0 1 12 6c5 0 8.5 4.2 9.5 6-.4.8-1.3 2-2.5 3.2M6.6 7.6C4.6 8.9 3.1 10.8 2.5 12c1 1.8 4.5 6 9.5 6 1.6 0 3-.4 4.3-1.1"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/>';

function avatar(ch, size = '') {
  if (ch.avatar) {
    return h('img', { class: `avatar ${size}`, src: ch.avatar, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' });
  }
  let hash = 0;
  for (const c of ch.id) hash = (hash * 31 + c.charCodeAt(0)) >>> 0;
  const letter = h('span', { class: `avatar letter ${size}` }, (ch.title || '?').trim().charAt(0).toUpperCase());
  letter.style.setProperty('--hue', hash % 360);
  return letter;
}

// ---- formatting --------------------------------------------------------------

function ago(ms) {
  const min = (Date.now() - ms) / 60000;
  if (min < 1) return 'just now';
  if (min < 60) return `${Math.floor(min)} min ago`;
  const hr = min / 60;
  if (hr < 24) return `${Math.floor(hr)} h ago`;
  const d = Math.floor(hr / 24);
  if (d < 7) return d === 1 ? '1 day ago' : `${d} days ago`;
  if (d < 30) return d < 14 ? '1 week ago' : `${Math.floor(d / 7)} weeks ago`;
  return new Date(ms).toLocaleDateString('en', { day: 'numeric', month: 'short', year: d > 300 ? 'numeric' : undefined });
}

function sectionOf(ms) {
  const today = new Date().setHours(0, 0, 0, 0);
  if (ms >= today) return 'Today';
  if (ms >= today - DAY) return 'Yesterday';
  if (ms >= today - 6 * DAY) return 'This week';
  if (ms >= today - 13 * DAY) return 'Last week';
  return 'Earlier';
}

const norm = (s) => (s || '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const byTitle = (a, b) => (a.title || a.id).localeCompare(b.title || b.id);

// ---- data --------------------------------------------------------------------

const activeGroup = () => (state.groups.includes(state.settings.group) ? state.settings.group : '');
const inGroup = (ch) => !activeGroup() || ch.group === activeGroup();
const onHome = (ch) => !ch.hidden && inGroup(ch);

function videosFor(filter) {
  const { channels, settings, watched, feed } = state;
  const since = filter ? 0 : Date.now() - settings.days * DAY;
  const q = norm(query);
  const out = [];
  for (const [cid, vids] of Object.entries(feed.videos)) {
    const ch = channels[cid];
    if (!ch || (filter ? cid !== filter : !onHome(ch))) continue;
    const channelMatches = q && norm(ch.title).includes(q);
    for (const v of vids) {
      if (v.p < since) continue;
      if (settings.hideWatched && watched[v.id] && !filter) continue;
      if (q && !channelMatches && !norm(v.t).includes(q)) continue;
      out.push(v);
    }
  }
  return out.sort((a, b) => b.p - a.p);
}

// Read-modify-write on storage, so two open YourHome tabs never overwrite each other's channels.
async function updateChannels(change) {
  const { channels = {} } = await api.storage.local.get('channels');
  const result = change(channels);
  await save({ channels });
  state.channels = channels;
  return result;
}

async function addChannels(list) {
  const added = await updateChannels((channels) => {
    const fresh = [];
    for (const ch of list) {
      const old = channels[ch.id];
      if (old) {
        if (!old.title && ch.title) old.title = ch.title;
        if (!old.avatar && ch.avatar) old.avatar = ch.avatar;
        if (ch.group) old.group = ch.group;
        if (ch.hidden) old.hidden = true;
      } else {
        channels[ch.id] = { id: ch.id, title: ch.title || '', avatar: ch.avatar || '', addedAt: Date.now() };
        if (ch.group) channels[ch.id].group = ch.group;
        if (ch.hidden) channels[ch.id].hidden = true;
        fresh.push(ch.id);
      }
    }
    return fresh;
  });
  render();
  if (added.length) refresh(added);
  return added.length;
}

/** Patch one channel; falsy values remove the key (e.g. { group: '' }, { hidden: false }). */
async function setChannel(id, patch) {
  await updateChannels((channels) => {
    const ch = channels[id];
    if (!ch) return;
    for (const [k, v] of Object.entries(patch)) {
      if (v) ch[k] = v;
      else delete ch[k];
    }
  });
  render();
}

async function removeChannel(id) {
  const ch = state.channels[id];
  if (!ch || !confirm(`Remove ${ch.title || 'this channel'} from YourHome?`)) return;
  await updateChannels((channels) => delete channels[id]);
  delete state.feed.videos[id];
  delete state.feed.errors[id];
  await save({ feed: state.feed });
  location.hash = '';
}

function setWatched(id, value) {
  if (value) state.watched[id] = Date.now();
  else delete state.watched[id];
  save({ watched: state.watched });
  queueRender();
}

async function setSetting(key, value) {
  state.settings[key] = value;
  await save({ settings: state.settings });
  applyLayout();
  render();
}

function applyLayout() {
  document.body.dataset.size = state.settings.cardSize;
  document.body.classList.toggle('sidebar-collapsed', !!state.settings.sidebarCollapsed);
}

// ---- refreshing feeds ----------------------------------------------------------

async function pool(items, size, fn) {
  const queue = [...items];
  const worker = async () => { while (queue.length) await fn(queue.shift()); };
  await Promise.all(Array.from({ length: Math.min(size, queue.length) }, worker));
}

async function refresh(ids) {
  if (refreshing) {
    if (ids) ids.forEach((id) => pending.add(id));
    else fullPending = true;
    return;
  }
  const full = !ids;
  ids ??= Object.keys(state.channels);
  if (!ids.length) return;

  const { feed } = state;
  let longOnly = state.settings.hideShorts;
  const notFound = new Set();
  const titles = new Map(); // names learned from feeds, for channels imported without one

  const pass = (list) => {
    refreshing = { done: 0, total: list.length };
    return pool(list, CONCURRENCY, async (id) => {
      try {
        const res = await fetchChannel(id, longOnly);
        feed.videos[id] = res.videos;
        delete feed.errors[id];
        const ch = state.channels[id];
        if (ch && !ch.title && res.title) {
          ch.title = res.title;
          titles.set(id, res.title);
        }
      } catch (err) {
        if (longOnly && err instanceof FeedError && err.status === 404) {
          // The long-form playlist doesn't exist: this channel only posts Shorts (or nothing).
          notFound.add(id);
          feed.videos[id] = [];
          delete feed.errors[id];
        } else {
          feed.errors[id] = err.message || 'Network error';
        }
      }
      refreshing.done++;
      queueRender();
    });
  };

  queueRender();
  await pass(ids);

  // Safety net: if YouTube ever removes the long-form playlists, every channel 404s.
  // Better to show Shorts than an empty page.
  if (longOnly && ids.length >= 3 && notFound.size === ids.length) {
    longOnly = false;
    await pass(ids);
    showBanner('YouTube’s Shorts filter isn’t answering right now, so Shorts may appear. CleanTube will try again on the next refresh.');
  }

  if (full) {
    feed.fetchedAt = Date.now();
    feed.mode = longOnly ? 'long' : 'all';
  }
  refreshing = null;
  await save({ feed });
  if (titles.size) {
    await updateChannels((channels) => {
      for (const [id, title] of titles) if (channels[id] && !channels[id].title) channels[id].title = title;
    });
  }
  render();
  const next = [...pending].filter((id) => state.channels[id] && !(id in feed.videos));
  pending.clear();
  if (fullPending) {
    fullPending = false;
    refresh();
  } else if (next.length) refresh(next);
}

function refreshIfNeeded() {
  const { feed, settings, channels } = state;
  const mode = settings.hideShorts ? 'long' : 'all';
  if (Date.now() - feed.fetchedAt > STALE_MS || feed.mode !== mode) return refresh();
  const missing = Object.keys(channels).filter((id) => !(id in feed.videos));
  if (missing.length) refresh(missing);
}

// ---- rendering ---------------------------------------------------------------

let renderQueued = false;
function queueRender() {
  if (renderQueued) return;
  renderQueued = true;
  setTimeout(() => { renderQueued = false; render(); }, 250);
}

function render() {
  renderStatus();
  renderSidebar();
  renderMain();
}

function renderStatus() {
  const status = $('#status');
  const bar = $('#progress');
  bar.hidden = !refreshing;
  $('#refresh').classList.toggle('spinning', !!refreshing);
  if (refreshing) {
    bar.firstElementChild.style.width = `${(refreshing.done / refreshing.total) * 100}%`;
    status.textContent = `Checking ${refreshing.done} of ${refreshing.total}…`;
    status.title = '';
    return;
  }
  const failed = Object.keys(state.feed.errors).filter((id) => state.channels[id]);
  status.textContent = state.feed.fetchedAt ? `Updated ${ago(state.feed.fetchedAt)}` : '';
  if (failed.length) status.textContent += ` · ${failed.length} failed`;
  status.title = failed.map((id) => `${state.channels[id].title || id}: ${state.feed.errors[id]}`).join('\n');
}

function renderSidebar() {
  const nav = $('#channels');
  const filter = channelFilter();
  const group = activeGroup();
  const since = Date.now() - state.settings.days * DAY;
  const q = norm(query);
  const all = Object.values(state.channels).filter(inGroup);
  const rows = all
    .filter((ch) => !q || norm(ch.title).includes(q))
    .map((ch) => {
      const vids = state.feed.videos[ch.id] ?? [];
      return {
        ch,
        latest: Math.max(0, ...vids.map((v) => v.p)),
        unseen: vids.filter((v) => v.p >= since && !state.watched[v.id]).length,
      };
    })
    .sort((a, b) =>
      state.settings.sidebarSort === 'az'
        ? !!a.ch.hidden - !!b.ch.hidden || byTitle(a.ch, b.ch)
        : !!a.ch.hidden - !!b.ch.hidden || b.latest - a.latest || byTitle(a.ch, b.ch)
    );

  if (!Object.keys(state.channels).length) return nav.replaceChildren();
  const sortBtn = (value, label) =>
    h('button', { class: state.settings.sidebarSort === value ? 'on' : '', 'aria-pressed': String(state.settings.sidebarSort === value), onclick: () => setSetting('sidebarSort', value) }, label);

  nav.replaceChildren(
    h('a', { class: `chan all${filter ? '' : ' active'}`, href: '#' }, h('span', { class: 'name' }, group || 'All channels'), h('span', { class: 'count' }, all.length)),
    h('div', { class: 'side-head' }, h('span', {}, 'Channels'), h('div', { class: 'seg', role: 'group', 'aria-label': 'Sort channels' }, sortBtn('recent', 'Recent'), sortBtn('az', 'A–Z'))),
    ...rows.map(({ ch, unseen }) =>
      h('a', {
        class: `chan${filter === ch.id ? ' active' : ''}${state.feed.errors[ch.id] ? ' failed' : ''}${ch.hidden ? ' hidden-home' : ''}`,
        href: `#c=${ch.id}`,
        title: ch.hidden ? `${ch.title} (not shown in Home)` : ch.title,
      },
        avatar(ch),
        h('span', { class: 'name' }, ch.title || ch.id),
        ch.hidden ? icon(ICON_EYE_OFF) : unseen ? h('span', { class: 'count' }, unseen) : ''
      )
    )
  );
}

function card(v) {
  const ch = state.channels[v.c] ?? { id: v.c, title: '' };
  const watched = !!state.watched[v.id];
  const isNew = !watched && newSince && v.p > newSince;
  const href = `${YT}/watch?v=${v.id}`;
  const target = state.settings.newTab ? '_blank' : null;
  const open = (e) => { if (e.button <= 1) setWatched(v.id, true); };
  return h('article', { class: `card${watched ? ' watched' : ''}` },
    h('a', { class: 'thumb', href, target, rel: 'noopener', tabindex: '-1', 'aria-hidden': 'true', onclick: open, onauxclick: open },
      h('img', { src: `https://i.ytimg.com/vi/${v.id}/mqdefault.jpg`, alt: '', loading: 'lazy', decoding: 'async' }),
      isNew ? h('span', { class: 'badge new' }, 'New') : '',
      watched ? h('span', { class: 'badge' }, 'Watched') : ''
    ),
    h('button', {
      class: 'mark', title: watched ? 'Mark as not watched' : 'Mark as watched',
      'aria-label': watched ? 'Mark as not watched' : 'Mark as watched', 'aria-pressed': String(watched),
      onclick: () => setWatched(v.id, !watched),
    }, icon(ICON_CHECK)),
    h('div', { class: 'info' },
      h('a', { class: 'title', href, target, rel: 'noopener', title: v.t, onclick: open, onauxclick: open }, v.t),
      h('div', { class: 'meta' },
        h('a', { class: 'by', href: `#c=${v.c}` }, ch.title || 'Unknown channel'),
        h('span', { class: 'when', title: new Date(v.p).toLocaleString() }, ago(v.p))
      )
    )
  );
}

// Busy channels (news, bulk uploads) shouldn't take over the page: keep their newest
// videos and fold the rest into one tile that expands in place.
function foldBusy(list, section) {
  const limit = state.settings.perChannel;
  if (!limit) return list;
  const total = new Map();
  for (const v of list) total.set(v.c, (total.get(v.c) ?? 0) + 1);
  const seen = new Map();
  const out = [];
  for (const v of list) {
    const n = total.get(v.c);
    const i = seen.get(v.c) ?? 0;
    const key = `${section}|${v.c}`;
    seen.set(v.c, i + 1);
    if (n <= limit + 1) {
      out.push(v);
    } else if (expanded.has(key)) {
      out.push(v);
      if (i === n - 1) out.push({ fold: 'less', c: v.c, key });
    } else if (i < limit) {
      out.push(v);
      if (i === limit - 1) out.push({ fold: 'more', c: v.c, key, n: n - limit });
    }
  }
  return out;
}

function foldTile({ fold, c, key, n }) {
  const ch = state.channels[c] ?? { id: c, title: '' };
  const more = fold === 'more';
  const toggle = () => {
    if (more) expanded.add(key);
    else expanded.delete(key);
    render();
    if (!more) $(`[data-fold="${CSS.escape(key)}"]`)?.scrollIntoView({ block: 'nearest' });
  };
  return h('button', { class: `card fold ${fold}`, 'data-fold': key, 'aria-expanded': String(!more), onclick: toggle },
    h('span', { class: 'thumb' }, avatar(ch, 'lg'), h('strong', {}, more ? `+${n} more` : 'Show less')),
    h('span', { class: 'info' },
      h('span', { class: 'title' }, ch.title || 'This channel'),
      h('span', { class: 'meta' }, more ? 'Click to show them here' : 'Fold these videos again')
    )
  );
}

function sections(videos, compact) {
  const groups = new Map();
  for (const v of videos) {
    const s = sectionOf(v.p);
    if (!groups.has(s)) groups.set(s, []);
    groups.get(s).push(v);
  }
  return [...groups].map(([label, list]) =>
    h('section', { class: 'group' },
      h('h2', {}, label, h('span', {}, list.length)),
      h('div', { class: 'grid' }, (compact ? foldBusy(list, label) : list).map((item) => (item.fold ? foldTile(item) : card(item))))
    )
  );
}

function groupTabs() {
  const active = activeGroup();
  const tab = (label, value) =>
    h('button', { class: `tab${active === value ? ' active' : ''}`, 'aria-pressed': String(active === value), onclick: () => { setSetting('group', value); window.scrollTo(0, 0); } }, label);
  return h('nav', { class: 'tabs', 'aria-label': 'Groups' },
    tab('All', ''),
    ...state.groups.map((g) => tab(g, g)),
    active ? h('button', { class: 'tab ghost', onclick: () => openGroupEditor(active) }, 'Edit group') : '',
    h('button', { class: 'tab ghost', onclick: () => openGroupEditor() }, '+ New group')
  );
}

function skeleton() {
  return h('div', { class: 'grid skeleton' }, Array.from({ length: 8 }, () => h('div', { class: 'card' }, h('div', { class: 'thumb' }), h('i'), h('i'))));
}

function welcome() {
  return h('section', { class: 'welcome' },
    h('h1', {}, 'Only the channels you chose.'),
    h('p', { class: 'lead' }, 'No algorithm, no Shorts, no recommendations. The latest videos from the people you follow, newest first, and a clear end when you’re caught up.'),
    adders(),
    h('p', { class: 'fine' }, 'Everything stays in this browser. CleanTube has no server and collects nothing.')
  );
}

function channelHead(ch, videos) {
  const err = state.feed.errors[ch.id];
  const loaded = ch.id in state.feed.videos;
  return h('header', { class: 'page-head channel-head' },
    avatar(ch, 'lg'),
    h('div', { class: 'grow' },
      h('h1', {}, ch.title || ch.id),
      h('p', { class: 'muted' },
        err ? `Couldn’t load this channel: ${err}` :
        !loaded ? 'Loading…' :
        videos.length ? plural(videos.length, 'recent video') :
        state.settings.hideShorts ? 'No recent long-form videos. This channel may only post Shorts.' : 'No recent videos.')
    ),
    h('div', { class: 'row' },
      h('a', { class: 'btn', href: `${YT}/channel/${ch.id}/videos`, target: state.settings.newTab ? '_blank' : null, rel: 'noopener' }, 'Open on YouTube'),
      h('button', { class: 'btn quiet', onclick: () => removeChannel(ch.id) }, 'Remove')
    ),
    h('div', { class: 'channel-controls' },
      h('label', { class: 'control' },
        h('span', {}, 'Group'),
        h('select', { onchange: (e) => setChannel(ch.id, { group: e.target.value }) },
          h('option', { value: '' }, 'None'),
          ...state.groups.map((g) => h('option', { value: g, selected: ch.group === g }, g))
        )
      ),
      h('label', { class: 'control' },
        h('input', { type: 'checkbox', checked: !ch.hidden, onchange: (e) => setChannel(ch.id, { hidden: !e.target.checked }) }),
        h('span', {}, 'Show in Home'),
        h('small', {}, ch.hidden ? 'Hidden from the Home feed; still here and in the sidebar.' : 'Untick to keep it out of the Home feed.')
      )
    )
  );
}

function renderMain() {
  const main = $('#main');
  const filter = channelFilter();
  const channelCount = Object.keys(state.channels).length;
  document.body.classList.toggle('empty', !channelCount);

  if (!channelCount) return main.replaceChildren(welcome());

  if (filter && !state.channels[filter]) {
    location.hash = '';
    return;
  }

  const videos = videosFor(filter);
  const parts = [];

  if (filter) {
    parts.push(channelHead(state.channels[filter], videos));
  } else {
    const group = activeGroup();
    const fresh = newSince ? videos.filter((v) => v.p > newSince && !state.watched[v.id]).length : 0;
    const today = new Date().toLocaleDateString('en', { weekday: 'long', day: 'numeric', month: 'long' });
    parts.push(groupTabs(), h('header', { class: 'page-head' },
      h('h1', {}, today),
      h('p', { class: 'muted' },
        query ? `${plural(videos.length, 'result')} for “${query}”` :
        newSince ? (fresh ? `${plural(fresh, 'new video')} since your last visit.` : 'Nothing new since your last visit.') :
        `Videos from ${group ? `the ${group} group` : `your ${plural(channelCount, 'channel')}`}.`)
    ));
    if (group && !Object.values(state.channels).some((ch) => ch.group === group)) {
      parts.push(h('div', { class: 'note' },
        h('span', {}, 'This group has no channels yet.'),
        h('button', { class: 'btn primary', onclick: () => openGroupEditor(group) }, 'Choose channels')));
    }
  }

  if (!videos.length && refreshing && !state.feed.fetchedAt) {
    parts.push(skeleton());
  } else {
    parts.push(...sections(videos, !filter && !query));
    if (!filter) {
      parts.push(h('footer', { class: 'end' },
        h('span', { class: 'end-mark' }, icon(ICON_CHECK)),
        h('strong', {}, query ? 'End of results.' : 'You’re all caught up.'),
        h('span', {}, `${plural(videos.length, 'video')} from the last ${state.settings.days} days.`)
      ));
    }
  }
  main.replaceChildren(...parts);
}

// ---- groups ------------------------------------------------------------------

function openGroupEditor(name = null) {
  editing = {
    original: name,
    picked: new Set(Object.values(state.channels).filter((c) => name && c.group === name).map((c) => c.id)),
  };
  $('#ge-title').textContent = name ? 'Edit group' : 'New group';
  $('#ge-name').value = name ?? '';
  $('#ge-filter').value = '';
  $('#ge-delete').hidden = !name;
  renderGroupList();
  $('#group-editor').showModal();
  if (!name) $('#ge-name').focus();
}

function renderGroupList() {
  const q = norm($('#ge-filter').value);
  const list = Object.values(state.channels).filter((c) => !q || norm(c.title).includes(q)).sort(byTitle);
  $('#ge-list').replaceChildren(...list.map((c) =>
    h('label', { class: 'check' },
      h('input', { type: 'checkbox', value: c.id, checked: editing.picked.has(c.id) }),
      avatar(c),
      h('span', { class: 'name' }, c.title || c.id),
      c.group && c.group !== editing.original ? h('span', { class: 'tag', title: 'Ticking moves it to this group' }, c.group) : ''
    )
  ));
  $('#ge-count').textContent = `${plural(editing.picked.size, 'channel')} selected`;
}

async function saveGroup() {
  const name = $('#ge-name').value.trim();
  if (!name) return $('#ge-name').focus();
  const { original, picked } = editing;
  if (name !== original && state.groups.includes(name)) return toast('A group with that name already exists.');
  state.groups = original ? state.groups.map((g) => (g === original ? name : g)) : [...state.groups, name];
  await save({ groups: state.groups });
  await updateChannels((channels) => {
    for (const ch of Object.values(channels)) {
      if (picked.has(ch.id)) ch.group = name;
      else if (ch.group === original || ch.group === name) delete ch.group;
    }
  });
  $('#group-editor').close();
  await setSetting('group', name);
}

async function deleteGroup() {
  const { original } = editing;
  if (!confirm(`Delete the group “${original}”? Its channels stay in YourHome.`)) return;
  state.groups = state.groups.filter((g) => g !== original);
  await save({ groups: state.groups });
  await updateChannels((channels) => {
    for (const ch of Object.values(channels)) if (ch.group === original) delete ch.group;
  });
  $('#group-editor').close();
  await setSetting('group', '');
}

// ---- channel adders (welcome screen + settings) -------------------------------

function adders() {
  return $('#adders-tpl').content.firstElementChild.cloneNode(true);
}

async function hasAccess() {
  try {
    return await api.permissions.contains({ origins: [`${YT}/*`] });
  } catch {
    return true;
  }
}

async function requestAccess() {
  const ok = await api.permissions.request({ origins: [`${YT}/*`] });
  if (ok) location.reload();
}

async function importFromYouTube() {
  if (!(await hasAccess())) return requestAccess();
  location.assign(`${YT}/feed/channels#yourhome-import`);
}

async function importFile(input) {
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  const { channels, settings, groups } = parseSubscriptionFile(await file.text());
  if (!channels.length) return toast('No YouTube channels found in that file.');
  if (settings) {
    Object.assign(state.settings, settings);
    await save({ settings: state.settings });
    applyLayout();
  }
  const fromChannels = channels.map((c) => c.group).filter(Boolean);
  const merged = [...new Set([...state.groups, ...(groups ?? []), ...fromChannels])];
  if (merged.length !== state.groups.length) {
    state.groups = merged;
    await save({ groups: state.groups });
  }
  const added = await addChannels(channels);
  toast(`Found ${plural(channels.length, 'channel')}, ${added} new.`);
}

async function addOne(form) {
  const out = $('output', form);
  const input = form.elements.q;
  const button = $('button', form);
  out.textContent = 'Looking it up…';
  out.className = '';
  button.disabled = true;
  try {
    const ch = await resolveChannel(input.value);
    if (state.channels[ch.id]) {
      out.textContent = `${ch.title} is already in YourHome.`;
    } else {
      await addChannels([ch]);
      out.textContent = `Added ${ch.title}.`;
      input.value = '';
    }
  } catch (err) {
    out.textContent = err.message;
    out.className = 'error';
  } finally {
    button.disabled = false;
  }
}

function exportBackup() {
  const data = {
    app: 'cleantube',
    version: 1,
    exportedAt: new Date().toISOString(),
    settings: state.settings,
    groups: state.groups,
    channels: Object.values(state.channels).map(({ id, title, avatar, group, hidden }) => ({ id, title, avatar, group, hidden })),
  };
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  h('a', { href: url, download: `yourhome-backup-${new Date().toISOString().slice(0, 10)}.json` }).click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---- settings, banners, toasts ---------------------------------------------------

function openSettings() {
  const dialog = $('#settings');
  for (const el of dialog.querySelectorAll('[data-setting]')) {
    const value = state.settings[el.dataset.setting];
    if (el.type === 'checkbox') el.checked = !!value;
    else el.value = String(value);
  }
  const slot = $('[data-slot="adders"]', dialog);
  if (!slot.firstChild) slot.append(adders());
  dialog.showModal();
}

async function changeSetting(el) {
  const key = el.dataset.setting;
  const before = state.settings[key];
  const value = el.type === 'checkbox' ? el.checked : 'number' in el.dataset ? Number(el.value) : el.value;
  await setSetting(key, value);
  if (key === 'hideShorts' && before !== value) refresh();
}

function showBanner(text, action) {
  const banner = $('#banner');
  banner.replaceChildren(h('span', {}, text), action ? h('button', { class: 'btn primary', onclick: action.run }, action.label) : '');
  banner.hidden = false;
}

let toastTimer;
function toast(text) {
  const el = $('#toast');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 4000);
}

// ---- coming back from a video: same place, same open folds ------------------------

function rememberPlace() {
  try {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify({ hash: location.hash, y: window.scrollY, expanded: [...expanded], newSince }));
  } catch {}
}

function restorePlace() {
  const nav = performance.getEntriesByType('navigation')[0];
  if (nav?.type !== 'back_forward' && nav?.type !== 'reload') return null;
  try {
    const saved = JSON.parse(sessionStorage.getItem(SESSION_KEY));
    if (!saved) return null;
    expanded = new Set(saved.expanded);
    return { newSince: saved.newSince, y: saved.hash === location.hash ? saved.y : null };
  } catch {
    return null;
  }
}

// ---- wiring --------------------------------------------------------------------

function wire() {
  document.addEventListener('click', (e) => {
    const action = e.target.closest('[data-action]')?.dataset.action;
    if (action === 'import-youtube') importFromYouTube();
    if (action === 'export') exportBackup();
  });
  document.addEventListener('change', (e) => {
    if (e.target.matches('[data-action="import-file"]')) importFile(e.target);
    if (e.target.matches('[data-setting]')) changeSetting(e.target);
  });
  document.addEventListener('submit', (e) => {
    if (e.target.matches('[data-action="add-one"]')) {
      e.preventDefault();
      addOne(e.target);
    }
  });

  $('#refresh').addEventListener('click', () => refresh());
  $('#open-settings').addEventListener('click', openSettings);
  $('#toggle-sidebar').addEventListener('click', () => setSetting('sidebarCollapsed', !state.settings.sidebarCollapsed));
  for (const d of document.querySelectorAll('dialog')) {
    d.addEventListener('click', (e) => { if (e.target === d) d.close(); });
  }

  $('#ge-filter').addEventListener('input', renderGroupList);
  $('#ge-list').addEventListener('change', (e) => {
    if (e.target.checked) editing.picked.add(e.target.value);
    else editing.picked.delete(e.target.value);
    $('#ge-count').textContent = `${plural(editing.picked.size, 'channel')} selected`;
  });
  $('#ge-save').addEventListener('click', saveGroup);
  $('#ge-delete').addEventListener('click', deleteGroup);
  $('#ge-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); saveGroup(); } });

  const search = $('#q');
  search.addEventListener('input', () => { query = search.value.trim(); render(); });
  search.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { search.value = ''; query = ''; render(); search.blur(); }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === '/' && !e.target.closest('input, textarea, select, dialog')) {
      e.preventDefault();
      search.focus();
    }
  });

  window.addEventListener('hashchange', () => { render(); window.scrollTo(0, 0); });
  window.addEventListener('pagehide', rememberPlace);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') rememberPlace();
    else refreshIfNeeded();
  });
  setInterval(renderStatus, 60_000);

  // Channels imported from a youtube.com tab, or changes made in another YourHome tab.
  onExternalChange((changes) => {
    if (changes.channels) {
      const next = changes.channels.newValue ?? {};
      const added = Object.keys(next).filter((id) => !state.channels[id]);
      state.channels = next;
      render();
      if (added.length) refresh(added);
    }
    if (changes.groups) {
      state.groups = changes.groups.newValue ?? [];
      render();
    }
    if (changes.settings) {
      state.settings = { ...state.settings, ...changes.settings.newValue };
      applyLayout();
    }
  });
}

async function main() {
  state = await load();
  const place = restorePlace(); // back from a video: keep the same "new" markers and scroll
  newSince = place?.newSince ?? state.lastSeenAt;
  save({ lastSeenAt: Date.now(), watched: state.watched });

  applyLayout();
  wire();
  render();
  if (place?.y != null) requestAnimationFrame(() => window.scrollTo(0, place.y));

  if (!(await hasAccess())) {
    showBanner('CleanTube needs access to youtube.com to read the public video feeds.', { label: 'Allow access', run: requestAccess });
    return;
  }

  const { lastImport } = await api.storage.local.get('lastImport');
  if (lastImport && Date.now() - lastImport.at < 30_000) {
    toast(`Imported ${plural(lastImport.found, 'channel')} from YouTube, ${lastImport.added} new.`);
  }
  refreshIfNeeded();
}

main();
