// Runs on www.youtube.com. Three small jobs, all opt-in except the import:
//  1. Send the YouTube home page to YourHome (setting: replaceHome).
//  2. Hide the recommendations column and end-screen grid (setting: hideRecs).
//  3. Import subscriptions when YourHome opens /feed/channels#yourhome-import.
(() => {
  const api = globalThis.browser ?? globalThis.chrome;
  const HOME_URL = api.runtime.getURL('yourhome.html');
  const IMPORT_HASH = '#yourhome-import';
  const wantsImport = location.pathname === '/feed/channels' && location.hash === IMPORT_HASH;
  let settings = {};

  // ---- 1 + 2: settings-driven behaviour -------------------------------------

  // Read once: YouTube rewrites the URL right after load and drops unknown parameters.
  const optOut = new URLSearchParams(location.search).has('yourhome-off');

  function apply() {
    document.documentElement.classList.toggle('yourhome-hide-recs', !!settings.hideRecs);
    if (settings.replaceHome && location.pathname === '/' && !optOut) location.replace(HOME_URL);
  }

  api.storage.local.get('settings').then((d) => {
    settings = d.settings ?? {};
    apply();
  });
  api.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.settings) {
      settings = changes.settings.newValue ?? {};
      apply();
    }
  });
  // YouTube is a single-page app: clicking the logo doesn't reload the page.
  document.addEventListener('yt-navigate-finish', apply);

  // ---- 3: subscription import -----------------------------------------------

  if (!wantsImport) return;

  // In Firefox, content.fetch makes the request as the page itself (same cookies, same origin).
  const pageFetch =
    typeof content === 'object' && content && typeof content.fetch === 'function'
      ? content.fetch.bind(content)
      : fetch.bind(globalThis);

  const CHANNEL_ID = /^UC[\w-]{22}$/;

  // Find `marker` in `text` and parse the balanced {...} object that follows it.
  function jsonAfter(text, marker, from = 0) {
    const at = text.indexOf(marker, from);
    if (at < 0) return null;
    const start = text.indexOf('{', at + marker.length);
    if (start < 0) return null;
    let depth = 0, inString = false, escaped = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
      } else if (ch === '"') inString = true;
      else if (ch === '{') depth++;
      else if (ch === '}' && --depth === 0) {
        try {
          return { value: JSON.parse(text.slice(start, i + 1)), end: i + 1 };
        } catch {
          return null;
        }
      }
    }
    return null;
  }

  function readConfig(html) {
    const cfg = {};
    let pos = 0, hit;
    while ((hit = jsonAfter(html, 'ytcfg.set(', pos))) {
      Object.assign(cfg, hit.value);
      pos = hit.end;
    }
    return cfg;
  }

  const text = (t) => t?.simpleText ?? t?.runs?.map((r) => r.text).join('') ?? t?.content ?? '';
  const bestThumb = (t) => {
    const list = t?.thumbnails ?? t?.sources ?? [];
    const url = list[list.length - 1]?.url;
    return url ? (url.startsWith('//') ? 'https:' + url : url) : '';
  };

  // Walk YouTube's JSON, collecting channels and the next continuation token.
  function collect(root, found) {
    let token = null;
    const stack = [root];
    while (stack.length) {
      const node = stack.pop();
      if (!node || typeof node !== 'object') continue;
      const ch = node.channelRenderer;
      if (ch && CHANNEL_ID.test(ch.channelId ?? '')) {
        found.set(ch.channelId, { id: ch.channelId, title: text(ch.title), avatar: bestThumb(ch.thumbnail) });
      }
      if (typeof node.continuationCommand?.token === 'string') token = node.continuationCommand.token;
      for (const k in node) if (node[k] && typeof node[k] === 'object') stack.push(node[k]);
    }
    return token;
  }

  async function authHeader() {
    const m = document.cookie.match(/(?:^|;\s*)(?:SAPISID|__Secure-3PAPISID)=([^;]+)/);
    if (!m) return null;
    const ts = Math.floor(Date.now() / 1000);
    const bytes = new TextEncoder().encode(`${ts} ${m[1]} https://www.youtube.com`);
    const digest = await crypto.subtle.digest('SHA-1', bytes);
    const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
    return `SAPISIDHASH ${ts}_${hex}`;
  }

  async function browseMore(cfg, token) {
    const context = cfg.INNERTUBE_CONTEXT ?? {
      client: { clientName: 'WEB', clientVersion: cfg.INNERTUBE_CLIENT_VERSION },
    };
    const headers = {
      'Content-Type': 'application/json',
      'X-Origin': 'https://www.youtube.com',
      'X-Goog-AuthUser': String(cfg.SESSION_INDEX ?? 0),
      'X-Youtube-Client-Name': String(cfg.INNERTUBE_CONTEXT_CLIENT_NAME ?? 1),
      'X-Youtube-Client-Version': String(context.client?.clientVersion ?? ''),
    };
    if (cfg.DELEGATED_SESSION_ID) headers['X-Goog-PageId'] = cfg.DELEGATED_SESSION_ID;
    const auth = await authHeader();
    if (auth) headers.Authorization = auth;
    const key = cfg.INNERTUBE_API_KEY ? `&key=${encodeURIComponent(cfg.INNERTUBE_API_KEY)}` : '';
    const res = await pageFetch(`https://www.youtube.com/youtubei/v1/browse?prettyPrint=false${key}`, {
      method: 'POST',
      credentials: 'include',
      headers,
      body: JSON.stringify({ context, continuation: token }),
    });
    if (!res.ok) throw new Error(`YouTube answered ${res.status} while paging`);
    return res.json();
  }

  async function readSubscriptions(onProgress) {
    const res = await pageFetch('https://www.youtube.com/feed/channels', { credentials: 'include' });
    const html = await res.text();
    const data = jsonAfter(html, 'ytInitialData = ')?.value ?? jsonAfter(html, 'ytInitialData"] = ')?.value;
    const cfg = readConfig(html);
    if (!data) throw new Error('Could not read the YouTube page. Try reloading it.');
    if (cfg.LOGGED_IN === false) throw new Error('You are not signed in to YouTube in this browser.');

    const found = new Map();
    let token = collect(data, found);
    let partial = false;
    for (let page = 0; token && page < 200; page++) {
      onProgress(found.size);
      try {
        token = collect(await browseMore(cfg, token), found);
      } catch (err) {
        console.warn('[YourHome] paging stopped:', err);
        partial = true;
        break;
      }
    }
    return { channels: [...found.values()], partial };
  }

  async function saveChannels(list) {
    const { channels = {} } = await api.storage.local.get('channels');
    let added = 0;
    for (const ch of list) {
      if (channels[ch.id]) {
        channels[ch.id] = { ...channels[ch.id], title: ch.title || channels[ch.id].title, avatar: ch.avatar || channels[ch.id].avatar };
      } else {
        channels[ch.id] = { ...ch, addedAt: Date.now() };
        added++;
      }
    }
    await api.storage.local.set({ channels, lastImport: { at: Date.now(), found: list.length, added } });
    return added;
  }

  function overlay() {
    const box = document.createElement('div');
    box.className = 'yourhome-import';
    const title = document.createElement('strong');
    title.textContent = 'YourHome';
    const msg = document.createElement('p');
    const actions = document.createElement('div');
    box.append(title, msg, actions);
    document.documentElement.append(box);
    return {
      say(t) { msg.textContent = t; },
      button(label, onClick) {
        const b = document.createElement('button');
        b.textContent = label;
        b.addEventListener('click', onClick);
        actions.append(b);
      },
    };
  }

  async function runImport() {
    history.replaceState(null, '', location.pathname); // drop the hash so a reload doesn't re-import
    const ui = overlay();
    ui.say('Reading your subscriptions…');
    try {
      const { channels, partial } = await readSubscriptions((n) => ui.say(`Reading your subscriptions… ${n} so far`));
      if (!channels.length) {
        throw new Error('No subscriptions found. Are you signed in to the right YouTube account?');
      }
      const added = await saveChannels(channels);
      ui.say(
        `Found ${channels.length} channels, ${added} new.` +
          (partial ? ' YouTube stopped the list early: some channels may be missing. You can run the import again, or use a Takeout file.' : ' Taking you back to YourHome…')
      );
      ui.button('Back to YourHome', () => location.assign(HOME_URL));
      if (!partial) setTimeout(() => location.assign(HOME_URL), 1500);
    } catch (err) {
      ui.say(err.message || String(err));
      ui.button('Back to YourHome', () => location.assign(HOME_URL));
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', runImport, { once: true });
  else runImport();
})();
