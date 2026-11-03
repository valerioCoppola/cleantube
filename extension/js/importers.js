// Reads subscription lists exported by other tools:
//   Google Takeout (subscriptions.csv), OPML, NewPipe, FreeTube, and YourHome backups.
const ID = /UC[\w-]{22}/;

function add(out, id, title = '', avatar = '', extra = {}) {
  if (!id || out.has(id)) return;
  out.set(id, { id, title: String(title || '').trim(), avatar: typeof avatar === 'string' && /^https?:/.test(avatar) ? avatar : '', ...extra });
}

// Group and visibility only exist in YourHome backups.
const extras = (node) => ({
  ...(typeof node.group === 'string' && node.group ? { group: node.group } : {}),
  ...(node.hidden === true ? { hidden: true } : {}),
});

function fromJson(root, out) {
  const stack = [root];
  while (stack.length) {
    const node = stack.pop();
    if (!node || typeof node !== 'object') continue;
    if (!Array.isArray(node)) {
      const ref = [node.id, node.channelId, node.url, node.channelUrl].find((v) => typeof v === 'string' && ID.test(v));
      if (ref) add(out, ref.match(ID)[0], node.title ?? node.name, node.avatar ?? node.thumbnail, extras(node));
    }
    for (const k in node) if (node[k] && typeof node[k] === 'object') stack.push(node[k]);
  }
}

function fromOpml(text, out) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  for (const o of doc.querySelectorAll('outline')) {
    const ref = o.getAttribute('xmlUrl') ?? o.getAttribute('htmlUrl') ?? '';
    const id = ref.match(ID)?.[0];
    if (id) add(out, id, o.getAttribute('title') ?? o.getAttribute('text'));
  }
}

function csvRows(text) {
  const rows = [];
  let row = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

function fromCsv(text, out) {
  // Takeout column names are translated, so match by content, not by header.
  for (const cells of csvRows(text)) {
    const idCell = cells.find((c) => ID.test(c));
    if (!idCell) continue;
    const title = [...cells].reverse().find((c) => c.trim() && !ID.test(c) && !/^https?:/.test(c));
    add(out, idCell.match(ID)[0], title);
  }
}

/** Returns { channels: [{id,title,avatar,group?,hidden?}], settings?, groups? } */
export function parseSubscriptionFile(text) {
  const out = new Map();
  const t = text.replace(/^﻿/, '').trim();
  let settings, groups;
  if (t.startsWith('{') || t.startsWith('[')) {
    let parsed;
    try {
      parsed = [JSON.parse(t)];
    } catch {
      // FreeTube .db files: one JSON object per line.
      parsed = t.split('\n').flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
    }
    for (const p of parsed) {
      if (p?.app === 'cleantube') {
        settings = p.settings;
        groups = Array.isArray(p.groups) ? p.groups.filter((g) => typeof g === 'string' && g) : undefined;
      }
      fromJson(p, out);
    }
  } else if (t.startsWith('<')) {
    fromOpml(t, out);
  } else {
    fromCsv(t, out);
  }
  return { channels: [...out.values()], settings, groups };
}
