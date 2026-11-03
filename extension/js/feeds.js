// YouTube's public RSS feeds: no API key, no quota, no login.
// The trick for hiding Shorts: every channel UCxxxx has an uploads playlist
// UULFxxxx that contains only long-form videos (UUSHxxxx is Shorts only).
const FEED = 'https://www.youtube.com/feeds/videos.xml';
const YT_NS = 'http://www.youtube.com/xml/schemas/2015';
export const CHANNEL_ID = /^UC[\w-]{22}$/;

export class FeedError extends Error {
  constructor(status) {
    super(status === 404 ? 'Not found' : `YouTube answered ${status}`);
    this.status = status;
  }
}

const get = (url) => fetch(url, { credentials: 'include', cache: 'no-store' });

export function parseFeed(xml) {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const feedAuthor = doc.querySelector('feed > author > name')?.textContent ?? '';
  const videos = [...doc.getElementsByTagName('entry')].map((e) => ({
    id: e.getElementsByTagNameNS(YT_NS, 'videoId')[0]?.textContent,
    c: e.getElementsByTagNameNS(YT_NS, 'channelId')[0]?.textContent,
    t: e.getElementsByTagName('title')[0]?.textContent ?? '',
    p: Date.parse(e.getElementsByTagName('published')[0]?.textContent ?? '') || 0,
  }));
  return { title: feedAuthor, videos: videos.filter((v) => v.id) };
}

/** Latest uploads of one channel. longOnly=true excludes Shorts and lives. */
export async function fetchChannel(channelId, longOnly) {
  const url = longOnly
    ? `${FEED}?playlist_id=UULF${channelId.slice(2)}`
    : `${FEED}?channel_id=${channelId}`;
  const res = await get(url);
  if (!res.ok) throw new FeedError(res.status);
  return parseFeed(await res.text());
}

const meta = (html, prop) =>
  html.match(new RegExp(`<meta property="${prop}" content="([^"]*)"`))?.[1]?.replace(/&amp;/g, '&') ?? '';

const decode = (s) => {
  const t = document.createElement('textarea');
  t.innerHTML = s;
  return t.value;
};

async function fromChannelPage(path) {
  // ucbcb=1 skips the EU cookie-consent redirect for people who never opened youtube.com.
  const res = await get(`https://www.youtube.com${path}${path.includes('?') ? '&' : '?'}ucbcb=1`);
  if (!res.ok) throw new Error(res.status === 404 ? 'That channel does not exist.' : `YouTube answered ${res.status}.`);
  if (new URL(res.url).hostname !== 'www.youtube.com') {
    throw new Error('YouTube asked for cookie consent. Open youtube.com once, then try again.');
  }
  const html = await res.text();
  const id = html.match(/<link rel="canonical" href="https:\/\/www\.youtube\.com\/channel\/(UC[\w-]{22})"/)?.[1];
  if (!id) throw new Error('Could not find a channel on that page.');
  return { id, title: decode(meta(html, 'og:title')), avatar: meta(html, 'og:image') };
}

async function fromId(id) {
  const { title } = await fetchChannel(id, false).catch(() => {
    throw new Error('No channel with that ID.');
  });
  return { id, title, avatar: '' };
}

/** Accepts @handle, a channel URL, a channel ID, or any video URL. */
export async function resolveChannel(input) {
  const raw = input.trim();
  if (!raw) throw new Error('Paste a channel link or @handle.');
  if (CHANNEL_ID.test(raw)) return fromId(raw);
  if (raw.startsWith('@')) return fromChannelPage(`/${encodeURIComponent(raw)}`.replace('%40', '@'));

  let url;
  try {
    url = new URL(/^https?:\/\//.test(raw) ? raw : `https://${raw}`);
  } catch {
    throw new Error('That does not look like a YouTube link.');
  }
  const host = url.hostname.replace(/^(www|m|music)\./, '');
  if (host !== 'youtube.com' && host !== 'youtu.be') throw new Error('That is not a YouTube link.');

  const channel = url.pathname.match(/^\/channel\/(UC[\w-]{22})/);
  if (channel) return fromId(channel[1]);

  const isVideo = host === 'youtu.be' || /^\/(watch|shorts\/|live\/|embed\/)/.test(url.pathname);
  if (isVideo) {
    const res = await get(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(url.href)}`);
    if (!res.ok) throw new Error('Could not find that video.');
    const { author_url } = await res.json();
    return fromChannelPage(new URL(author_url).pathname);
  }

  const path = url.pathname.match(/^\/(@[^/]+|c\/[^/]+|user\/[^/]+|[^/]+)/)?.[0];
  if (!path || path === '/feed' || path === '/results') throw new Error('That link is not a channel.');
  return fromChannelPage(path);
}
