// IPTV Manager web UI: plain DOM, hash routing, no build step.

// ---------------------------------------------------------------- helpers --

function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (['value', 'checked', 'disabled', 'selected', 'indeterminate'].includes(k)) el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  append(el, kids);
  return el;
}

function append(el, kids) {
  for (const k of kids.flat(Infinity)) {
    if (k == null || k === false) continue;
    el.append(k instanceof Node ? k : document.createTextNode(String(k)));
  }
  return el;
}

// Like replaceChildren, but skips null/false instead of rendering them as text.
function fill(el, ...kids) {
  el.replaceChildren();
  return append(el, kids);
}

const $app = document.getElementById('app');
let cleanups = [];

class ApiError extends Error {}

async function api(method, path, body, raw = false) {
  const res = await fetch(path, {
    method,
    headers: raw ? { 'x-requested-with': 'fetch' } : { 'content-type': 'application/json', 'x-requested-with': 'fetch' },
    body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
  });
  let data = null;
  try {
    data = await res.json();
  } catch {}
  if (res.status === 401 && !path.startsWith('/api/login')) {
    route();
    throw new ApiError('Session expired');
  }
  if (!res.ok) throw new ApiError(data?.error || `Request failed (${res.status})`);
  return data;
}

function toast(msg, kind = 'ok') {
  const el = h('div', { class: `toast ${kind}` }, msg);
  document.getElementById('toasts').append(el);
  setTimeout(() => el.remove(), kind === 'error' ? 6000 : 3000);
}

async function attempt(fn, okMsg) {
  try {
    const r = await fn();
    if (okMsg) toast(okMsg);
    return r;
  } catch (e) {
    toast(e.message, 'error');
    throw e;
  }
}

function ago(ts) {
  if (!ts) return 'never';
  const s = Math.round(Date.now() / 1000 - ts);
  const f = (n, u) => `${n} ${u}${n === 1 ? '' : 's'}`;
  const abs = Math.abs(s);
  const txt = abs < 60 ? f(abs, 'second') : abs < 3600 ? f(Math.round(abs / 60), 'minute')
    : abs < 86400 ? f(Math.round(abs / 3600), 'hour') : f(Math.round(abs / 86400), 'day');
  return s >= 0 ? `${txt} ago` : `in ${txt}`;
}

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Plain-HTTP homelab pages have no clipboard API; fall back to a hidden textarea.
    const ta = h('textarea', { class: 'offscreen' });
    ta.value = text;
    document.body.append(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  toast('Copied');
}

function copyField(label, value) {
  return h('div', { class: 'copy-field' },
    h('label', null, label),
    h('div', { class: 'row' },
      h('input', { value, readonly: true, onfocus: (e) => e.target.select() }),
      h('button', { class: 'btn', onclick: () => copy(value) }, 'Copy')));
}

function modal(title, body, actions = [], onClose = null) {
  const close = () => {
    if (!bg.isConnected) return;
    bg.remove();
    document.removeEventListener('keydown', onKey);
    onClose?.();
  };
  const onKey = (e) => e.key === 'Escape' && close();
  const bg = h('div', { class: 'modal-bg', onmousedown: (e) => e.target === bg && close() },
    h('div', { class: 'modal', role: 'dialog', 'aria-label': title },
      h('div', { class: 'modal-head' }, h('h2', null, title), h('button', { class: 'icon-btn', onclick: close, 'aria-label': 'Close' }, '✕')),
      h('div', { class: 'modal-body' }, body),
      actions.length ? h('div', { class: 'modal-actions' }, actions) : null));
  document.body.append(bg);
  document.addEventListener('keydown', onKey);
  bg.querySelector('input, select, textarea')?.focus();
  return close;
}

function confirmBox(message, okLabel = 'Delete') {
  return new Promise((resolve) => {
    let answer = false;
    const close = modal('Are you sure?', h('p', null, message), [
      h('button', { class: 'btn', onclick: () => close() }, 'Cancel'),
      h('button', { class: 'btn danger', onclick: () => { answer = true; close(); } }, okLabel),
    ], () => resolve(answer));
  });
}

function field(label, control, hint) {
  return h('label', { class: 'field' }, h('span', { class: 'field-label' }, label), control, hint ? h('span', { class: 'hint' }, hint) : null);
}

function badge(text, kind = '') {
  return h('span', { class: `badge ${kind}` }, text);
}

function statusBadge(src) {
  if (src.job === 'running') return badge('Refreshing…', 'info');
  if (src.job === 'queued') return badge('Queued', 'info');
  if (!src.enabled) return badge('Disabled', 'muted');
  if (src.last_status === 'ok') return badge('OK', 'ok');
  if (src.last_status === 'warning') return badge('Warning', 'warn');
  if (src.last_status === 'error') return badge('Error', 'error');
  return badge('Not refreshed', 'muted');
}

// Each navigation bumps routeSeq; timers from an older view stop themselves.
let routeSeq = 0;

function poll(fn, ms) {
  const seq = routeSeq;
  let busy = false;
  const t = setInterval(async () => {
    if (seq !== routeSeq) return clearInterval(t);
    if (document.hidden || busy || document.querySelector('.modal-bg')) return;
    busy = true;
    try {
      await fn();
    } catch {
      // Transient; the next tick retries.
    } finally {
      busy = false;
    }
  }, ms);
}

/**
 * Keep a container's children in step with a list without re-rendering unchanged items:
 * only items whose data (or `extra` signature) changed are rebuilt, so polling never
 * flashes the page or disturbs focus and scroll.
 */
function syncList(container, items, keyOf, render, extra = () => '') {
  const prev = container._keyed || new Map();
  const next = new Map();
  const nodes = items.map((it) => {
    const key = keyOf(it);
    const sig = JSON.stringify(it) + extra(it);
    const old = prev.get(key);
    const node = old && old.sig === sig ? old.node : render(it);
    next.set(key, { sig, node });
    return node;
  });
  nodes.forEach((n, i) => {
    if (container.children[i] !== n) container.insertBefore(n, container.children[i] || null);
  });
  while (container.children.length > nodes.length) container.lastElementChild.remove();
  container._keyed = next;
}

// "x minutes ago" labels drift, so let rows re-render once a minute.
const minuteTick = () => String(Math.floor(Date.now() / 60000));

const OP_LABELS = {
  contains: 'contains',
  not_contains: 'does not contain',
  starts_with: 'starts with',
  not_starts_with: 'does not start with',
  ends_with: 'ends with',
  not_ends_with: 'does not end with',
  equals: 'equals',
  not_equals: 'does not equal',
  regex: 'matches regex',
};

// Same decision logic as src/filters.js, so rule edits preview before saving.
function testRule(rule, name) {
  const n = String(name || '').toLowerCase();
  const v = String(rule.value || '').toLowerCase();
  switch (rule.op) {
    case 'contains': return n.includes(v);
    case 'not_contains': return !n.includes(v);
    case 'starts_with': return n.startsWith(v);
    case 'not_starts_with': return !n.startsWith(v);
    case 'ends_with': return n.endsWith(v);
    case 'not_ends_with': return !n.endsWith(v);
    case 'equals': return n === v;
    case 'not_equals': return n !== v;
    case 'regex': try { return new RegExp(rule.value, 'i').test(name); } catch { return false; }
    default: return false;
  }
}

/**
 * Include and Exclude boxes for a rule list, with drag-and-drop (by the ⠿ handle) plus
 * ↑/↓/⇄ buttons for touch and keyboard. `rules` is edited in place and kept includes-first.
 * Order is only for organizing: a match in any include counts, and any exclude match wins.
 *   fields(rule)      the controls between the handle and the buttons
 *   commit()          after a move, reorder or removal
 *   onAdd(rule)       after "+ Add" (the new rule has no value yet)
 *   newRule(action)   the rule "+ Add" creates
 */
function ruleGroups({ rules, subject, fields, commit, onAdd, newRule, off = false }) {
  const regroup = () => {
    const inc = rules.filter((r) => r.action === 'include');
    const exc = rules.filter((r) => r.action !== 'include');
    rules.splice(0, rules.length, ...inc, ...exc);
  };
  regroup();
  let dragging = null;

  const moveTo = (rule, action, before) => {
    rules.splice(rules.indexOf(rule), 1);
    rule.action = action;
    const end = action === 'include' ? rules.filter((r) => r.action === 'include').length : rules.length;
    rules.splice(before ? rules.indexOf(before) : end, 0, rule);
    regroup();
    commit();
  };
  const neighbor = (rule, step) => {
    for (let i = rules.indexOf(rule) + step; i >= 0 && i < rules.length; i += step) {
      if (rules[i].action === rule.action) return i;
    }
    return -1;
  };
  const swap = (rule, step) => {
    const i = rules.indexOf(rule);
    const j = neighbor(rule, step);
    if (j < 0) return;
    [rules[i], rules[j]] = [rules[j], rules[i]];
    commit();
  };
  const clearMarks = () => document.querySelectorAll('.drop-before, .drop-target').forEach((el) => el.classList.remove('drop-before', 'drop-target'));

  const row = (r) => {
    const other = r.action === 'include' ? 'exclude' : 'include';
    const el = h('div', {
      class: 'rule-row',
      ondragstart: (e) => {
        dragging = r;
        el.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', '');
      },
      ondragend: () => {
        dragging = null;
        el.draggable = false;
        el.classList.remove('dragging');
        clearMarks();
      },
      ondragover: (e) => {
        if (!dragging || dragging === r) return;
        e.preventDefault();
        e.stopPropagation();
        clearMarks();
        el.classList.add('drop-before');
      },
      ondrop: (e) => {
        if (!dragging || dragging === r) return;
        e.preventDefault();
        e.stopPropagation();
        moveTo(dragging, r.action, r);
      },
    },
    h('span', {
      class: `drag-handle ${off ? 'disabled' : ''}`,
      title: off ? '' : 'Drag to reorder, or into the other box to switch',
      // Only the handle starts a drag, so text in the inputs can still be selected.
      onmousedown: () => { if (!off) el.draggable = true; },
      onmouseup: () => { el.draggable = false; },
    }, '⠿'),
    fields(r),
    h('span', { class: 'rule-buttons' },
      h('button', { class: 'icon-btn', disabled: off || neighbor(r, -1) < 0, title: 'Move up', onclick: () => swap(r, -1) }, '↑'),
      h('button', { class: 'icon-btn', disabled: off || neighbor(r, 1) < 0, title: 'Move down', onclick: () => swap(r, 1) }, '↓'),
      h('button', { class: 'icon-btn', disabled: off, title: `Move to ${other === 'include' ? 'Include' : 'Exclude'}`, onclick: () => moveTo(r, other, null) }, '⇄'),
      h('button', { class: 'icon-btn', disabled: off, title: 'Remove rule', onclick: () => { rules.splice(rules.indexOf(r), 1); commit(); } }, '✕')));
    if (r === ruleGroups.focus) {
      ruleGroups.focus = null;
      setTimeout(() => el.querySelector('input')?.focus());
    }
    return el;
  };

  const group = (action) => {
    const list = rules.filter((r) => r.action === action);
    const box = h('div', {
      class: `rule-group ${action}`,
      ondragover: (e) => {
        if (!dragging) return;
        e.preventDefault();
        clearMarks();
        box.classList.add('drop-target');
      },
      ondrop: (e) => {
        if (!dragging) return;
        e.preventDefault();
        moveTo(dragging, action, null);
      },
    },
    h('div', { class: 'rule-group-head' },
      h('b', null, action === 'include' ? 'Include' : 'Exclude'),
      h('span', { class: 'meta' }, action === 'include'
        ? ` ${subject} matching any of these`
        : ` ${subject} matching any of these. Exclusions always win.`)),
    list.map(row),
    list.length ? null : h('p', { class: 'meta rule-empty' }, `No ${action} rules${off ? '' : '. Add one, or drag a rule here.'}`),
    h('button', {
      class: 'btn small',
      disabled: off,
      onclick: () => {
        const r = newRule(action);
        rules.push(r);
        regroup();
        ruleGroups.focus = r;
        onAdd(r);
      },
    }, `+ Add ${action} rule`));
    return box;
  };

  return h('div', { class: 'rule-groups' }, group('include'), group('exclude'));
}

function categoryState(cat, rules, override, includeAll) {
  if (override) return { included: override === 'include', reason: 'manual' };
  const applicable = rules.filter((r) => r.value !== '' && (r.source_id == null || r.source_id === cat.source_id));
  const exclude = applicable.find((r) => r.action === 'exclude' && testRule(r, cat.name));
  if (exclude) return { included: false, reason: 'rule', rule: exclude };
  const includes = applicable.filter((r) => r.action === 'include');
  if (!includes.length) return { included: !!includeAll, reason: 'default' };
  const hit = includes.find((r) => testRule(r, cat.name));
  return hit ? { included: true, reason: 'rule', rule: hit } : { included: false, reason: 'nomatch' };
}

// ------------------------------------------------------------------ shell --

let shell = null; // { header, main, links } while logged in

function ensureShell(view) {
  if (!shell || !shell.header.isConnected) {
    const links = [['dashboard', 'Dashboard'], ['sources', 'Sources'], ['outputs', 'Outputs'], ['settings', 'Settings']]
      .map(([v, label]) => h('a', { href: `#/${v}`, 'data-view': v }, label));
    const header = h('header', { class: 'topbar' },
      h('a', { class: 'brand', href: '#/' }, h('img', { src: '/favicon.svg', alt: '' }), 'IPTV Manager'),
      h('nav', null, links),
      h('a', { class: 'update-badge', href: '#/settings', hidden: true }, 'Update available'),
      h('button', { class: 'btn ghost', onclick: async () => { await api('POST', '/api/logout'); route(); } }, 'Log out'));
    const main = h('main', { class: 'content' });
    fill($app, header, main);
    shell = { header, main, links };
  }
  for (const a of shell.links) a.classList.toggle('active', a.dataset.view === view);
}

// Views render into a detached <main> and are swapped in only when complete,
// so navigating never shows a blank page in between.
async function route() {
  const seq = ++routeSeq;
  for (const c of cleanups.splice(0)) c();
  document.querySelectorAll('.modal-bg').forEach((m) => m.remove());
  let session;
  try {
    session = await fetch('/api/session').then((r) => r.json());
  } catch {
    shell = null;
    fill($app, h('div', { class: 'center-card' }, h('p', null, 'Cannot reach the server.')));
    return;
  }
  if (seq !== routeSeq) return;
  if (session.setup_required || !session.authenticated) {
    shell = null;
    return renderAuth(session.setup_required);
  }

  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  const view = parts[0] || 'dashboard';
  const main = h('main', { class: 'content' });
  try {
    if (view === 'sources' && parts[1]) await sourceDetail(main, Number(parts[1]));
    else if (view === 'sources') await sourcesView(main);
    else if (view === 'outputs' && parts[1]) await outputEditor(main, Number(parts[1]));
    else if (view === 'outputs') await outputsView(main);
    else if (view === 'settings') await settingsView(main);
    else await dashboard(main);
  } catch (e) {
    if (e instanceof ApiError && e.message === 'Session expired') return;
    fill(main, h('div', { class: 'card error-card' }, h('h2', null, 'Something went wrong'), h('p', null, e.message)));
  }
  if (seq !== routeSeq) return;
  ensureShell(view);
  shell.main.replaceWith(main);
  shell.main = main;
  refreshUpdateBadge();
}

function renderAuth(setup) {
  const pw = h('input', { type: 'password', autocomplete: setup ? 'new-password' : 'current-password', required: true, minlength: setup ? 8 : null });
  const pw2 = setup ? h('input', { type: 'password', autocomplete: 'new-password', required: true }) : null;
  const err = h('p', { class: 'form-error' });
  const form = h('form', {
    class: 'center-card card',
    onsubmit: async (e) => {
      e.preventDefault();
      err.textContent = '';
      if (setup && pw.value !== pw2.value) return (err.textContent = 'Passwords do not match');
      try {
        await api('POST', setup ? '/api/setup' : '/api/login', { password: pw.value });
        route();
      } catch (ex) {
        err.textContent = ex.message;
      }
    },
  },
  h('div', { class: 'brand big' }, h('img', { src: '/favicon.svg', alt: '' }), 'IPTV Manager'),
  setup ? h('p', null, 'Welcome! Choose an admin password to protect this dashboard.') : null,
  field(setup ? 'New password' : 'Password', pw, setup ? 'At least 8 characters.' : null),
  setup ? field('Repeat password', pw2) : null,
  err,
  h('button', { class: 'btn primary wide', type: 'submit' }, setup ? 'Create password' : 'Log in'));
  fill($app, form);
  pw.focus();
}

// -------------------------------------------------------------- dashboard --

async function dashboard(main) {
  const srcGrid = h('div', { class: 'grid' });
  const outGrid = h('div', { class: 'grid' });
  const getStarted = h('div', { class: 'card empty' },
    h('h2', null, 'Get started'),
    h('ol', { class: 'steps' },
      h('li', null, 'Add a source: an M3U playlist URL or your Xtream Codes login.'),
      h('li', null, 'Create an output and choose which categories to keep, using rules or by picking them by hand.'),
      h('li', null, 'Point your IPTV app at the output\'s M3U + EPG URLs or its Xtream Codes login.')),
    h('a', { class: 'btn primary', href: '#/sources' }, 'Add a source'));
  const noOutputs = h('div', { class: 'card empty' }, h('p', null, 'No outputs yet.'), h('a', { class: 'btn primary', href: '#/outputs' }, 'Create an output'));
  const srcSection = h('section', null, h('h2', null, 'Sources'), srcGrid);
  const outSection = h('section', null, h('h2', null, 'Outputs'), outGrid, noOutputs);

  const update = async () => {
    const [sources, outputs] = await Promise.all([api('GET', '/api/sources'), api('GET', '/api/outputs')]);
    getStarted.hidden = sources.length > 0;
    srcSection.hidden = outSection.hidden = !sources.length;
    noOutputs.hidden = outputs.length > 0;
    syncList(srcGrid, sources, (s) => s.id, sourceCard, minuteTick);
    syncList(outGrid, outputs, (o) => o.id, outputCard);
  };
  await update();
  fill(main, h('div', { class: 'page-head' }, h('h1', null, 'Dashboard')), getStarted, srcSection, outSection);
  poll(update, 3000);
}

function sourceCard(s) {
  const st = s.stats || {};
  return h('div', { class: 'card' },
    h('div', { class: 'card-head' }, h('h3', null, h('a', { href: `#/sources/${s.id}` }, s.name)), statusBadge(s)),
    h('div', { class: 'meta' }, TYPE_LABELS[s.type], ' · refreshed ', ago(s.last_refresh_at)),
    h('div', { class: 'stats' },
      stat(s.counts.channels, 'channels'), stat(s.counts.categories, 'categories'),
      stat(s.counts.channels ? `${Math.round((s.counts.epg_matched / s.counts.channels) * 100)}%` : '–', 'EPG matched')),
    st.newCategories ? h('p', { class: 'note' }, `${st.newCategories} new categor${st.newCategories === 1 ? 'y' : 'ies'} in the last refresh`) : null,
    s.last_error ? h('p', { class: s.last_status === 'error' ? 'form-error' : 'note warn' }, s.last_error) : null);
}

function outputCard(o) {
  return h('div', { class: 'card' },
    h('div', { class: 'card-head' }, h('h3', null, h('a', { href: `#/outputs/${o.id}` }, o.name)), badge(o.stream_mode, 'muted')),
    h('div', { class: 'stats' }, stat(o.channel_count, 'channels'), stat(o.category_count, 'categories')),
    copyField('M3U playlist', o.urls.m3u),
    copyField('XMLTV guide', o.urls.epg));
}

const TYPE_LABELS = { m3u: 'M3U', xc: 'Xtream Codes', hdhr: 'HDHomeRun' };

function stat(v, label) {
  return h('div', { class: 'stat' }, h('b', null, v ?? 0), h('span', null, label));
}

// ---------------------------------------------------------------- sources --

async function sourcesView(main) {
  const tbody = h('tbody');
  const table = h('div', { class: 'card flush' }, h('table', { class: 'table' },
    h('thead', null, h('tr', null, ['Source', 'Status', 'Channels', 'Categories', 'EPG matched', 'Last refresh', ''].map((t) => h('th', null, t)))),
    tbody));
  const empty = h('div', { class: 'card empty' }, h('p', null, 'No sources yet. Add an M3U playlist or an Xtream Codes account.'));
  const update = async () => {
    const sources = await api('GET', '/api/sources');
    table.hidden = !sources.length;
    empty.hidden = sources.length > 0;
    syncList(tbody, sources, (s) => s.id, (s) => sourceRow(s, update), minuteTick);
  };
  await update();
  fill(main,
    h('div', { class: 'page-head' }, h('h1', null, 'Sources'), h('button', { class: 'btn primary', onclick: () => sourceForm(null, update) }, '+ Add source')),
    table, empty);
  poll(update, 3000);
}

function sourceRow(s, update) {
  return h('tr', null,
    h('td', null, h('a', { href: `#/sources/${s.id}`, class: 'strong' }, s.name), h('div', { class: 'meta' }, TYPE_LABELS[s.type])),
    h('td', null, statusBadge(s), s.last_error ? h('div', { class: 'meta clip', title: s.last_error }, s.last_error) : null),
    h('td', { class: 'num' }, s.counts.channels),
    h('td', { class: 'num' }, s.counts.categories),
    h('td', { class: 'num' }, s.counts.epg_matched),
    h('td', null, ago(s.last_refresh_at), h('div', { class: 'meta' }, s.next_refresh_at ? `next ${ago(s.next_refresh_at)}` : 'manual only')),
    h('td', { class: 'actions' },
      h('button', { class: 'btn', disabled: !!s.job, onclick: () => attempt(() => api('POST', `/api/sources/${s.id}/refresh`), 'Refresh started').then(update) }, 'Refresh'),
      h('button', { class: 'btn', onclick: () => sourceForm(s, update) }, 'Edit'),
      h('button', {
        class: 'btn danger-text',
        onclick: async () => {
          if (await confirmBox(`Delete "${s.name}" and all of its channels? Outputs using it will lose those channels.`)) {
            await attempt(() => api('DELETE', `/api/sources/${s.id}`), 'Source deleted');
            update();
          }
        },
      }, 'Delete')));
}

function sourceForm(src, onSaved = route) {
  const isNew = !src;
  let type = src?.type || 'm3u';
  const v = (x) => x ?? '';
  const f = {
    name: h('input', { value: v(src?.name), placeholder: 'My provider', required: true }),
    url: h('input', { value: src?.url?.startsWith('upload:') ? '' : v(src?.url), placeholder: 'http://provider/get.php?username=…&type=m3u_plus' }),
    file: h('input', { type: 'file', accept: '.m3u,.m3u8,.gz,text/plain' }),
    epg_urls: h('textarea', { rows: 3, placeholder: 'One URL per line (optional)' }),
    epg_file: h('input', { type: 'file', accept: '.xml,.gz,text/xml' }),
    xc_host: h('input', { value: v(src?.xc_host), placeholder: 'http://provider.example:8080' }),
    xc_username: h('input', { value: v(src?.xc_username), autocomplete: 'off' }),
    xc_password: h('input', { type: 'password', autocomplete: 'new-password', placeholder: src?.has_password ? '(unchanged)' : '' }),
    xc_stream_ext: h('select', null, h('option', { value: 'ts', selected: src?.xc_stream_ext !== 'm3u8' }, 'MPEG-TS (.ts)'), h('option', { value: 'm3u8', selected: src?.xc_stream_ext === 'm3u8' }, 'HLS (.m3u8)')),
    hdhr_host: h('input', { value: v(src?.hdhr_host), placeholder: '192.168.1.50' }),
    user_agent: h('input', { value: v(src?.user_agent), placeholder: 'VLC/3.0.21 LibVLC/3.0.21 (default)' }),
    hours: h('input', { type: 'number', min: 0, step: 0.5, value: src ? src.refresh_minutes / 60 : 12 }),
    live_only: h('input', { type: 'checkbox', checked: src ? src.live_only : true }),
    enabled: h('input', { type: 'checkbox', checked: src ? src.enabled : true }),
  };
  f.epg_urls.value = v(src?.epg_urls);

  const m3uPart = h('div', null,
    field('Playlist URL', f.url, src?.url?.startsWith('upload:') ? 'Currently using an uploaded file. Enter a URL to switch back.' : 'Or upload a file below.'),
    field('…or upload a playlist file', f.file),
    h('label', { class: 'check' }, f.live_only, ' Skip movies and series (live TV only)'));
  const xcPart = h('div', null,
    field('Server URL', f.xc_host, 'The address your provider gave you, including the port.'),
    h('div', { class: 'two' }, field('Username', f.xc_username), field('Password', f.xc_password)),
    field('Stream format', f.xc_stream_ext));
  const hdhrPart = h('div', null,
    field('HDHomeRun address', f.hdhr_host,
      'The box\'s IP address, e.g. 192.168.1.50. Give it a DHCP reservation so it doesn\'t change. "hdhomerun.local" usually does not work from inside Docker.'),
    h('p', { class: 'hint' },
      'Channels come from the box\'s lineup, so run a channel scan on it first. The guide comes from SiliconDust\'s guide service using the box\'s own authorization; no account needed.'));
  const typeSwitch = isNew ? h('div', { class: 'segmented' },
    [['m3u', 'M3U playlist'], ['xc', 'Xtream Codes'], ['hdhr', 'HDHomeRun']].map(([t, label]) => h('button', {
      type: 'button',
      class: type === t ? 'on' : '',
      onclick: (e) => {
        type = t;
        e.target.parentNode.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b === e.target));
        sync();
      },
    }, label))) : null;
  const epgHint = h('p', { class: 'hint' });
  const sync = () => {
    m3uPart.hidden = type !== 'm3u';
    xcPart.hidden = type !== 'xc';
    hdhrPart.hidden = type !== 'hdhr';
    epgHint.textContent = {
      xc: 'The provider\'s own guide (xmltv.php) is used automatically. Add extra XMLTV URLs here to fill gaps.',
      hdhr: 'The HDHomeRun guide is fetched automatically. Add extra XMLTV URLs here to fill gaps.',
      m3u: 'Leave empty to use the guide named in the playlist header (url-tvg). Otherwise list XMLTV URLs (plain or .gz).',
    }[type];
  };
  sync();

  const body = h('form', { class: 'form', onsubmit: (e) => { e.preventDefault(); save(); } },
    typeSwitch,
    field('Name', f.name),
    m3uPart, xcPart, hdhrPart,
    h('details', { open: !!src?.epg_urls },
      h('summary', null, 'Guide (EPG)'),
      epgHint,
      field('Extra EPG URLs', f.epg_urls),
      field('…or upload an XMLTV file', f.epg_file)),
    h('details', null,
      h('summary', null, 'Advanced'),
      field('Refresh every (hours)', f.hours, '0 = only when you click Refresh.'),
      field('User agent', f.user_agent, 'Sent to the provider for playlists, guides and proxied streams.'),
      h('label', { class: 'check' }, f.enabled, ' Enabled')),
    h('button', { type: 'submit', hidden: true }));

  const save = async () => {
    const payload = {
      name: f.name.value, type, url: f.url.value || (src?.url?.startsWith('upload:') ? src.url : ''),
      epg_urls: f.epg_urls.value, xc_host: f.xc_host.value, xc_username: f.xc_username.value, xc_password: f.xc_password.value,
      xc_stream_ext: f.xc_stream_ext.value, hdhr_host: f.hdhr_host.value, user_agent: f.user_agent.value,
      refresh_minutes: Math.round(Number(f.hours.value || 0) * 60), live_only: f.live_only.checked, enabled: f.enabled.checked,
    };
    if (type === 'm3u' && !payload.url && !f.file.files[0]) return toast('Enter a playlist URL or choose a file', 'error');
    const saved = await attempt(() => (isNew ? api('POST', '/api/sources', payload) : api('PUT', `/api/sources/${src.id}`, payload)));
    if (f.file.files[0]) await attempt(() => api('POST', `/api/sources/${saved.id}/upload?kind=m3u`, f.file.files[0], true));
    if (f.epg_file.files[0]) await attempt(() => api('POST', `/api/sources/${saved.id}/upload?kind=epg`, f.epg_file.files[0], true));
    close();
    toast(isNew ? 'Source added; first refresh started' : 'Source saved');
    onSaved();
  };
  const close = modal(isNew ? 'Add source' : `Edit ${src.name}`, body, [
    h('button', { class: 'btn', onclick: () => close() }, 'Cancel'),
    h('button', { class: 'btn primary', onclick: save }, isNew ? 'Add and refresh' : 'Save'),
  ]);
}

async function sourceDetail(main, id) {
  let src = await api('GET', `/api/sources/${id}`);
  let cats = await api('GET', `/api/sources/${id}/categories`);
  const state = { category: null, q: '', epg: '', offset: 0 };
  const list = h('div', { class: 'card flush' });
  const catList = h('div', { class: 'cat-list' });
  const catSearch = h('input', { type: 'search', placeholder: 'Filter categories', oninput: () => drawCats() });

  const drawCats = () => {
    const q = catSearch.value.toLowerCase();
    fill(catList, 
      h('button', { class: `cat-item ${state.category == null ? 'on' : ''}`, onclick: () => pick(null) }, h('span', null, 'All channels'), h('span', { class: 'count' }, src.counts.channels)),
      cats.filter((c) => !q || (c.custom_name || c.name).toLowerCase().includes(q)).map((c) =>
        h('button', { class: `cat-item ${state.category === c.id ? 'on' : ''}`, onclick: () => pick(c.id), title: c.name },
          h('span', null, c.custom_name || c.name, c.is_new ? badge('new', 'info') : null, jellyfinBadges(c)),
          h('span', { class: 'count' }, c.channel_count))));
  };
  const pick = (cid) => {
    state.category = cid;
    state.offset = 0;
    drawCats();
    load();
  };

  const load = async () => {
    const qs = new URLSearchParams({ limit: 100, offset: state.offset });
    if (state.category) qs.set('category_id', state.category);
    if (state.q) qs.set('q', state.q);
    if (state.epg) qs.set('epg', state.epg);
    const data = await api('GET', `/api/sources/${id}/channels?${qs}`);
    const cat = cats.find((c) => c.id === state.category);
    fill(list, 
      cat ? h('div', { class: 'list-head' }, h('b', null, cat.custom_name || cat.name),
        cat.custom_name ? h('span', { class: 'meta' }, ` (provider name: ${cat.name})`) : null,
        jellyfinBadges(cat),
        h('button', { class: 'btn small', onclick: () => editCategory(cat, () => { drawCats(); load(); }) }, 'Edit group')) : null,
      h('table', { class: 'table' },
        h('thead', null, h('tr', null, ['', 'Channel', 'Category', 'tvg-id', 'Guide', ''].map((t) => h('th', null, t)))),
        h('tbody', null, data.items.map((ch) => h('tr', null,
          h('td', { class: 'logo-cell' }, (ch.custom_logo || ch.logo) ? h('img', { src: ch.custom_logo || ch.logo, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' }) : null),
          h('td', null, h('span', { class: 'strong' }, ch.custom_name || ch.name), ch.custom_name ? h('div', { class: 'meta' }, ch.name) : null),
          h('td', { class: 'meta' }, ch.category),
          h('td', { class: 'mono' }, ch.tvg_id || '–'),
          h('td', null, epgBadge(ch), ch.epg_id ? h('div', { class: 'meta mono' }, ch.custom_epg_id || ch.epg_id) : null),
          h('td', { class: 'actions' }, h('button', { class: 'btn small', onclick: () => editChannel(src, ch, load) }, 'Edit')))))),
      data.items.length ? null : h('p', { class: 'empty pad' }, 'No channels match.'),
      h('div', { class: 'pager' },
        h('span', { class: 'meta' }, data.total ? `${state.offset + 1}–${state.offset + data.items.length} of ${data.total}` : ''),
        h('button', { class: 'btn small', disabled: state.offset === 0, onclick: () => { state.offset -= 100; load(); } }, '‹ Prev'),
        h('button', { class: 'btn small', disabled: state.offset + 100 >= data.total, onclick: () => { state.offset += 100; load(); } }, 'Next ›')));
  };

  let t;
  const search = h('input', { type: 'search', placeholder: 'Search channels or tvg-id', oninput: (e) => { clearTimeout(t); t = setTimeout(() => { state.q = e.target.value; state.offset = 0; load(); }, 250); } });
  const epgFilter = h('select', { onchange: (e) => { state.epg = e.target.value; state.offset = 0; load(); } },
    h('option', { value: '' }, 'All guide states'), h('option', { value: 'matched' }, 'Has guide'), h('option', { value: 'unmatched' }, 'No guide'));

  // Header, stats and error banner are redrawn in place; lists only reload after a refresh finishes.
  const head = h('div', { class: 'page-head' });
  const statsBox = h('div');
  let headSig = '';
  const drawHead = () => {
    const sig = JSON.stringify(src) + minuteTick();
    if (sig === headSig) return;
    headSig = sig;
    const st = src.stats || {};
    fill(head,
      h('div', null, h('a', { href: '#/sources', class: 'crumb' }, '‹ Sources'), h('h1', null, src.name)),
      h('div', { class: 'row' }, statusBadge(src),
        h('button', { class: 'btn', onclick: () => sourceForm(src, refreshSource) }, 'Edit source'),
        h('button', { class: 'btn primary', disabled: !!src.job, onclick: () => attempt(() => api('POST', `/api/sources/${id}/refresh`), 'Refresh started').then(refreshSource) }, 'Refresh now')));
    fill(statsBox,
      h('div', { class: 'stats wide card' },
        stat(src.counts.channels, 'channels'), stat(src.counts.categories, 'categories'),
        stat(src.counts.epg_matched, 'with guide'),
        stat(st.epg?.programmes ?? '–', 'programmes'),
        stat(ago(src.last_refresh_at), 'last refresh'),
        src.account_info?.exp_date ? stat(new Date(Number(src.account_info.exp_date) * 1000).toLocaleDateString(), 'account expires') : null,
        src.account_info?.max_connections ? stat(src.account_info.max_connections, 'max connections') : null,
        src.account_info?.model ? stat(src.account_info.model, 'model') : null,
        src.account_info?.tuners ? stat(src.account_info.tuners, 'tuners') : null,
        st.epg?.hdhr ? h('div', { class: 'stat' }, h('span', null, `Guide: ${st.epg.hdhr}`)) : null),
      src.last_error ? h('div', { class: `card ${src.last_status === 'error' ? 'error-card' : 'warn-card'}` }, src.last_error) : null);
  };
  const refreshSource = async () => {
    const wasBusy = !!src.job;
    src = await api('GET', `/api/sources/${id}`);
    drawHead();
    if (wasBusy && !src.job) {
      cats = await api('GET', `/api/sources/${id}/categories`);
      drawCats();
      await load();
    }
  };

  drawHead();
  fill(main, head, statsBox,
    h('div', { class: 'split' },
      h('aside', { class: 'card flush side' }, h('div', { class: 'pad' }, catSearch), catList),
      h('div', null, h('div', { class: 'toolbar' }, search, epgFilter), list)));
  drawCats();
  await load();
  poll(refreshSource, 3000);
}

const JELLYFIN_CATEGORIES = [
  ['Movie', 'Movies'],
  ['Sports', 'Sports'],
  ['News', 'News'],
  ['Kids', 'Kids'],
];

function jellyfinBadges(cat) {
  return (cat.jellyfin || []).map((j) => badge(`Jellyfin: ${j}`, 'jf'));
}

/** Group-level settings shared by every channel in it: display name and Jellyfin guide categories. */
function editCategory(cat, onSaved) {
  const name = h('input', { value: cat.custom_name || '', placeholder: cat.name });
  const boxes = JELLYFIN_CATEGORIES.map(([value, label]) => {
    const box = h('input', { type: 'checkbox', value, checked: (cat.jellyfin || []).includes(value) });
    return h('label', { class: 'check' }, box, ` ${label}`);
  });
  const close = modal(`Edit group: ${cat.custom_name || cat.name}`, h('div', { class: 'form' },
    field('Display name in outputs', name, 'Leave empty to use the provider\'s name. Filter rules still match the provider\'s name.'),
    h('div', { class: 'field' },
      h('span', { class: 'field-label' }, 'Jellyfin category'),
      h('span', { class: 'hint' },
        `Tags every programme on all ${cat.channel_count ?? ''} channels in this group, so Jellyfin lists them under Movies, Sports, News or Kids. `,
        'This only applies to channels that have guide data.'),
      h('div', { class: 'row' }, boxes))), [
    h('button', { class: 'btn', onclick: () => close() }, 'Cancel'),
    h('button', {
      class: 'btn primary',
      onclick: async () => {
        const jellyfin = boxes.map((l) => l.querySelector('input')).filter((b) => b.checked).map((b) => b.value);
        const r = await attempt(() => api('PUT', `/api/categories/${cat.id}`, { custom_name: name.value, jellyfin }), 'Group saved');
        cat.custom_name = r.custom_name;
        cat.jellyfin = r.jellyfin;
        close();
        onSaved?.();
      },
    }, 'Save'),
  ]);
}

function epgBadge(ch) {
  if (!ch.epg_id) return badge('none', 'muted');
  return badge({ 'tvg-id': 'by tvg-id', name: 'by name', manual: 'manual' }[ch.epg_match] || ch.epg_match, ch.epg_match === 'manual' ? 'info' : 'ok');
}

function editChannel(src, ch, reload) {
  const f = {
    name: h('input', { value: ch.custom_name || '', placeholder: ch.name }),
    logo: h('input', { value: ch.custom_logo || '', placeholder: ch.logo || 'https://…/logo.png' }),
    chno: h('input', { value: ch.custom_chno || '', placeholder: ch.chno || '' }),
    epg: h('input', { value: ch.custom_epg_id || '', placeholder: ch.epg_id ? `${ch.epg_id} (automatic)` : 'Search the guide below' }),
  };
  const results = h('div', { class: 'epg-results' });
  let t;
  const search = h('input', {
    type: 'search',
    placeholder: `Search ${src.name}'s guide by name or id`,
    oninput: (e) => {
      clearTimeout(t);
      t = setTimeout(async () => {
        const rows = await api('GET', `/api/sources/${src.id}/epg-channels?q=${encodeURIComponent(e.target.value)}`);
        fill(results, ...rows.map((r) => h('button', {
          type: 'button',
          class: 'epg-hit',
          onclick: () => { f.epg.value = r.id; },
        }, h('span', { class: 'mono' }, r.id), h('span', { class: 'meta' }, r.names.join(' · ')))),
        rows.length ? '' : h('p', { class: 'meta' }, 'No matches.'));
      }, 250);
    },
  });
  const close = modal(`Edit ${ch.custom_name || ch.name}`, h('div', { class: 'form' },
    h('p', { class: 'hint' }, 'Blank fields keep the provider\'s values. Edits apply to every output and survive refreshes.'),
    field('Display name', f.name),
    field('Logo URL', f.logo),
    field('Channel number', f.chno, 'Ignored by outputs that renumber channels.'),
    field('Guide channel id', f.epg, `Current: ${ch.epg_id ? `${ch.epg_id} (${ch.epg_match})` : 'no guide'}. Leave empty for automatic matching.`),
    search, results), [
    h('button', { class: 'btn', onclick: () => close() }, 'Cancel'),
    h('button', {
      class: 'btn primary',
      onclick: async () => {
        await attempt(() => api('PUT', `/api/channels/${ch.id}`, {
          custom_name: f.name.value, custom_logo: f.logo.value, custom_chno: f.chno.value, custom_epg_id: f.epg.value,
        }), 'Channel saved');
        close();
        reload();
      },
    }, 'Save'),
  ]);
}

// ---------------------------------------------------------------- outputs --

async function outputsView(main) {
  const outputs = await api('GET', '/api/outputs');
  fill(main, 
    h('div', { class: 'page-head' }, h('h1', null, 'Outputs'), h('button', { class: 'btn primary', onclick: newOutput }, '+ New output')),
    h('p', { class: 'lead' }, 'Each output is its own trimmed playlist and guide with its own URLs, so you can publish a different lineup for each room, person or app.'),
    outputs.length ? h('div', { class: 'grid' }, outputs.map(outputCard))
      : h('div', { class: 'card empty' }, h('p', null, 'No outputs yet.')));
}

function newOutput() {
  const name = h('input', { placeholder: 'Living room', required: true });
  const close = modal('New output', h('form', { class: 'form', onsubmit: (e) => { e.preventDefault(); create(); } },
    field('Name', name, 'All current sources are attached; you can change that next.')), [
    h('button', { class: 'btn', onclick: () => close() }, 'Cancel'),
    h('button', { class: 'btn primary', onclick: () => create() }, 'Create'),
  ]);
  const create = async () => {
    const o = await attempt(() => api('POST', '/api/outputs', { name: name.value || 'New output' }));
    close();
    location.hash = `#/outputs/${o.id}`;
  };
}

async function outputEditor(main, id) {
  let o = await api('GET', `/api/outputs/${id}`);
  let cats = await api('GET', `/api/outputs/${id}/categories`);
  const draft = {
    name: o.name,
    stream_mode: o.stream_mode,
    number_start: o.number_start ?? '',
    epg_days: o.epg_days,
    include_all: o.include_all,
    xc_enabled: o.xc_enabled,
    xc_username: o.xc_username || '',
    xc_password: o.xc_password || '',
    sources: o.sources.map((s) => ({ ...s })),
    rules: o.rules.map((r) => ({ ...r })),
  };
  let dirty = false;
  const view = { q: '', show: 'all', open: new Set() };
  const saveBar = h('div', { class: 'savebar', hidden: true },
    h('span', null, 'Unsaved changes. The category list below already shows their effect.'),
    h('button', { class: 'btn', onclick: () => route() }, 'Discard'),
    h('button', { class: 'btn primary', onclick: () => save() }, 'Save changes'));
  const markDirty = () => {
    dirty = true;
    saveBar.hidden = false;
    drawCats();
  };
  const onLeave = (e) => {
    if (dirty) {
      e.preventDefault();
      e.returnValue = '';
    }
  };
  window.addEventListener('beforeunload', onLeave);
  cleanups.push(() => window.removeEventListener('beforeunload', onLeave));

  const sourceName = (sid) => o.sources.find((s) => s.id === sid)?.name || `#${sid}`;
  const attachedIds = () => draft.sources.filter((s) => s.attached).map((s) => s.id);

  // --- settings
  const inp = (key, props = {}) => h('input', { ...props, value: draft[key], oninput: (e) => { draft[key] = props.type === 'checkbox' ? e.target.checked : e.target.value; markDirty(); } });
  const modeInfo = {
    direct: 'The playlist holds the provider\'s own stream URLs. Nothing passes through this server. For Xtream Codes clients, this behaves like Redirect.',
    redirect: 'The playlist points at this server, which answers with a redirect to the provider. It uses no bandwidth, and URLs stay stable if the provider changes them.',
    proxy: 'This server relays the video. Provider credentials never reach the client, but every stream uses this server\'s bandwidth.',
  };
  const modeHint = h('span', { class: 'hint' }, modeInfo[draft.stream_mode]);
  const mode = h('select', { onchange: (e) => { draft.stream_mode = e.target.value; modeHint.textContent = modeInfo[draft.stream_mode]; markDirty(); } },
    ['direct', 'redirect', 'proxy'].map((m) => h('option', { value: m, selected: draft.stream_mode === m }, m[0].toUpperCase() + m.slice(1))));
  const xcBox = h('div', { class: 'two' }, field('XC username', inp('xc_username', { autocomplete: 'off' })), field('XC password', inp('xc_password', { autocomplete: 'off' })));
  xcBox.hidden = !draft.xc_enabled;
  const xcToggle = h('input', { type: 'checkbox', checked: draft.xc_enabled, onchange: (e) => { draft.xc_enabled = e.target.checked; xcBox.hidden = !e.target.checked; if (e.target.checked && !draft.xc_username) { draft.xc_username = o.name.toLowerCase().replace(/[^a-z0-9]+/g, '') || 'user'; draft.xc_password = Math.random().toString(36).slice(2, 10); xcBox.querySelectorAll('input')[0].value = draft.xc_username; xcBox.querySelectorAll('input')[1].value = draft.xc_password; } markDirty(); } });

  const settingsCard = h('section', { class: 'card' },
    h('h2', null, 'Settings'),
    h('div', { class: 'form' },
      field('Name', inp('name')),
      field('Stream delivery', mode, null), modeHint,
      h('div', { class: 'two' },
        field('Renumber channels from', inp('number_start', { type: 'number', min: 0, placeholder: 'Keep provider numbers' })),
        field('Guide days', inp('epg_days', { type: 'number', min: 1, max: 14 }))),
      h('label', { class: 'check' }, xcToggle, ' Also publish as an Xtream Codes login (live TV)'),
      xcBox));

  // --- sources
  const sourcesBox = h('div', { class: 'source-list' });
  const drawSources = () => {
    fill(sourcesBox, ...draft.sources.map((s, i) => h('div', { class: 'source-row' },
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: s.attached, onchange: (e) => { s.attached = e.target.checked; markDirty(); } }), ' ', s.name, ' ', h('span', { class: 'meta' }, TYPE_LABELS[s.type])),
      h('span', { class: 'row' },
        h('button', { class: 'icon-btn', title: 'Move up', disabled: i === 0, onclick: () => { [draft.sources[i - 1], draft.sources[i]] = [draft.sources[i], draft.sources[i - 1]]; drawSources(); markDirty(); } }, '↑'),
        h('button', { class: 'icon-btn', title: 'Move down', disabled: i === draft.sources.length - 1, onclick: () => { [draft.sources[i + 1], draft.sources[i]] = [draft.sources[i], draft.sources[i + 1]]; drawSources(); markDirty(); } }, '↓')))),
    draft.sources.length ? '' : h('p', { class: 'meta' }, 'No sources exist yet.'));
  };
  drawSources();
  const sourcesCard = h('section', { class: 'card' }, h('h2', null, 'Sources'), h('p', { class: 'hint' }, 'Channels are listed in this source order. Save to load categories from newly attached sources.'), sourcesBox);

  // --- rules
  const rulesBox = h('div', { class: 'rules' });
  const drawRules = () => {
    fill(rulesBox, ruleGroups({
      rules: draft.rules,
      subject: 'categories',
      newRule: (action) => ({ action, op: action === 'include' ? 'starts_with' : 'contains', value: '', source_id: null }),
      commit: () => { drawRules(); markDirty(); },
      onAdd: () => drawRules(),
      fields: (r) => [
        h('span', { class: 'meta' }, 'from'),
        h('select', { onchange: (e) => { r.source_id = e.target.value ? Number(e.target.value) : null; markDirty(); } },
          h('option', { value: '' }, 'any source'),
          draft.sources.filter((s) => s.attached || s.id === r.source_id).map((s) => h('option', { value: s.id, selected: r.source_id === s.id }, s.name))),
        h('span', { class: 'meta' }, 'whose name'),
        h('select', { onchange: (e) => { r.op = e.target.value; markDirty(); } },
          Object.entries(OP_LABELS).map(([k, l]) => h('option', { value: k, selected: r.op === k }, l))),
        h('input', { value: r.value, placeholder: 'e.g. US|', oninput: (e) => { r.value = e.target.value; markDirty(); } }),
      ],
    }));
  };
  drawRules();
  const includeAll = h('input', { type: 'checkbox', checked: draft.include_all, onchange: (e) => { draft.include_all = e.target.checked; markDirty(); } });
  const rulesCard = h('section', { class: 'card' },
    h('h2', null, 'Filter rules'),
    h('p', { class: 'hint' }, 'Rules run against the provider\'s category names on every refresh, so new categories that match are added automatically. ',
      'A category is kept when it matches any Include rule and no Exclude rule. Picking a category by hand below always wins. ',
      'Drag rules (⠿) to arrange them; the order is only for your own organization.'),
    rulesBox,
    h('label', { class: 'check' }, includeAll, ' When a source has no Include rules, include all of its categories'));

  // --- categories
  const catBox = h('div', { class: 'cat-table' });
  const summary = h('span', { class: 'meta' });
  const evalCat = (c) => {
    const attached = attachedIds().includes(c.source_id);
    if (!attached) return { included: false, reason: 'detached' };
    return categoryState(c, draft.rules, c.override, draft.include_all);
  };
  const reasonText = (st) => {
    if (st.reason === 'manual') return 'picked by hand';
    if (st.reason === 'detached') return 'source not attached';
    if (st.reason === 'rule' && st.rule) return `${st.rule.action}: ${OP_LABELS[st.rule.op]} "${st.rule.value}"`;
    if (st.reason === 'nomatch') return 'no include rule matched';
    return st.included ? 'included by default' : 'not selected';
  };
  const visible = () => {
    const q = view.q.toLowerCase();
    return cats.filter((c) => {
      const st = evalCat(c);
      if (q && !(c.custom_name || c.name).toLowerCase().includes(q) && !c.name.toLowerCase().includes(q)) return false;
      if (view.show === 'included') return st.included;
      if (view.show === 'excluded') return !st.included;
      if (view.show === 'new') return c.is_new;
      if (view.show === 'manual') return !!c.override;
      return true;
    });
  };
  const setOverride = async (ids, state) => {
    await attempt(() => api('PUT', `/api/outputs/${id}/categories`, { ids, state }));
    for (const c of cats) if (ids.includes(c.id)) c.override = state;
    drawCats();
    refreshCounts();
  };
  const drawCats = () => {
    const rows = visible();
    let inc = 0;
    let chans = 0;
    for (const c of cats) {
      const st = evalCat(c);
      if (st.included) {
        inc++;
        chans += c.channel_count;
      }
    }
    summary.textContent = `${inc} of ${cats.length} categories · about ${chans} channels${dirty ? ' (preview)' : ''}`;
    const LIMIT = 500;
    fill(catBox, 
      ...rows.slice(0, LIMIT).map((c) => {
        const st = evalCat(c);
        const seg = (label, val, cls) => h('button', { class: `${c.override === val ? 'on' : ''} ${cls}`, title: val ? `Always ${val}` : 'Follow the rules', onclick: () => setOverride([c.id], val) }, label);
        const row = h('div', { class: `cat-row ${st.included ? 'in' : 'out'}` },
          h('button', { class: 'expander', title: 'Show channels', onclick: () => { view.open.has(c.id) ? view.open.delete(c.id) : view.open.add(c.id); drawCats(); } }, view.open.has(c.id) ? '▾' : '▸'),
          h('span', { class: 'dot' }),
          h('span', { class: 'cat-name' }, c.custom_name || c.name, c.is_new ? badge('new', 'info') : null, jellyfinBadges(c),
            c.channel_rules?.length ? badge(`${c.channel_rules.length} channel rule${c.channel_rules.length === 1 ? '' : 's'}`, 'info') : null,
            c.hide_empty ? badge('hides empty events', 'info') : null,
            c.hide_by_guide ? badge(c.hide_unlisted ? 'hides by guide + unlisted' : 'hides by guide', 'info') : null,
            h('span', { class: 'meta' }, ` ${sourceName(c.source_id)} · ${c.channel_count} ch · ${reasonText(st)}`)),
          h('button', { class: 'icon-btn', title: 'Edit group (display name, Jellyfin category)', onclick: () => editCategory(c, drawCats) }, '✎'),
          h('span', { class: 'segmented small' }, seg('Auto', null, ''), seg('Include', 'include', 'inc'), seg('Exclude', 'exclude', 'exc')));
        if (!view.open.has(c.id)) return row;
        return h('div', null, row, channelPanel(c));
      }),
      rows.length > LIMIT ? h('p', { class: 'meta pad' }, `Showing the first ${LIMIT} of ${rows.length}. Use the search box to narrow the list.`) : null,
      rows.length ? null : h('p', { class: 'meta pad' }, 'No categories to show.'));
  };
  // Expanded category: its channel rules plus the channel list. Panels are kept per
  // category and reused across redraws, reloading only when the category's state changes.
  const panels = new Map();
  const channelPanel = (c) => {
    const key = `${c.override}|${c.included}`;
    let p = panels.get(c.id);
    if (!p) {
      p = { el: h('div', { class: 'ch-panel' }, h('p', { class: 'meta' }, 'Loading…')), key, rules: [] };
      panels.set(c.id, p);
      loadPanel(c, p);
    } else if (p.key !== key) {
      p.key = key;
      loadPanel(c, p);
    }
    return p.el;
  };

  const loadPanel = async (c, p) => {
    const data = await api('GET', `/api/outputs/${id}/channels?category_id=${c.id}`);
    p.rules = data.rules.map((r) => ({ ...r }));
    renderPanel(c, p, data);
  };

  const renderPanel = (c, p, data) => {
    const saveRules = async () => {
      await attempt(() => api('PUT', `/api/outputs/${id}/categories/${c.id}/channel-rules`, { rules: p.rules }));
      c.channel_rules = p.rules.filter((r) => r.value !== '');
      await loadPanel(c, p);
      refreshCounts();
      drawCats();
    };
    const setChannels = async (ids, state) => {
      if (!ids.length) return;
      await attempt(() => api('PUT', `/api/outputs/${id}/channels`, { ids, state }));
      await loadPanel(c, p);
      refreshCounts();
    };
    const chans = data.channels;
    // Channel rules and picks only mean something once the category is in the output;
    // until then everything is shown but locked.
    const off = !data.category_included;

    // Live feedback: how many channels a rule's text matches, even before it is saved.
    const matchText = (r) => (r.value ? `matches ${chans.filter((ch) => testRule(r, ch.name)).length} of ${chans.length}` : '');
    const ruleBox = ruleGroups({
      rules: p.rules,
      subject: 'channels',
      off,
      newRule: (action) => ({ action, op: 'contains', value: '' }),
      commit: saveRules,
      // A new rule has no value yet, so it is shown but only saved once text is entered.
      onAdd: () => renderPanel(c, p, data),
      fields: (r) => {
        const count = h('span', { class: 'meta match-count' }, matchText(r));
        return [
          h('span', { class: 'meta' }, 'name'),
          h('select', { disabled: off, onchange: (e) => { r.op = e.target.value; count.textContent = matchText(r); if (r.value) saveRules(); } },
            Object.entries(OP_LABELS).map(([k, l]) => h('option', { value: k, selected: r.op === k }, l))),
          h('input', {
            value: r.value,
            disabled: off,
            placeholder: 'e.g. backup',
            oninput: (e) => { count.textContent = matchText({ ...r, value: e.target.value }); },
            onchange: (e) => { r.value = e.target.value; saveRules(); },
            onkeydown: (e) => { if (e.key === 'Enter') e.target.blur(); },
          }),
          count,
        ];
      },
    });

    const included = chans.filter((ch) => ch.included).length;
    const overridden = chans.filter((ch) => ch.override).map((ch) => ch.id);
    const reason = (ch) => ({
      manual: 'picked by hand', rule: 'by rule', nomatch: 'no include rule matched', empty: 'empty event',
      guide: 'nothing on now', unlisted: 'nothing listed now',
    })[ch.reason] || '';
    const emptyCount = chans.filter((ch) => ch.is_empty_event).length;
    const guideCount = chans.filter((ch) => ch.is_guide_placeholder).length;
    const unlistedCount = chans.filter((ch) => ch.is_unlisted).length;
    const setOption = async (key, on) => {
      await attempt(() => api('PUT', `/api/outputs/${id}/categories/${c.id}/options`, { [key]: on }));
      c[key] = on;
      await loadPanel(c, p);
      refreshCounts();
      drawCats();
    };

    p.el.classList.toggle('locked', off);
    fill(p.el,
      off ? h('div', { class: 'ch-warning' },
        h('span', null, h('b', null, 'This category is not in the output. '),
          'Include it to pick channels or use channel rules.',
          overridden.length ? ` Your ${overridden.length} earlier hand pick${overridden.length === 1 ? ' comes' : 's come'} back when you do.` : ''),
        h('button', { class: 'btn small primary', onclick: () => setOverride([c.id], 'include') }, 'Include category')) : null,
      h('div', { class: 'ch-option' },
        h('label', { class: 'check' },
          h('input', { type: 'checkbox', disabled: off, checked: data.hide_empty, onchange: (e) => setOption('hide_empty', e.target.checked) }),
          h('b', null, ' Hide empty event channels'),
          h('span', { class: 'meta' }, ` · by name · ${emptyCount} of ${chans.length} look empty right now`)),
        h('span', { class: 'hint' },
          'Hides placeholders named like "ESPN+ 03:" or "PPV 12 NO EVENT" until the provider names the event. ',
          h('a', { href: '#/settings' }, 'Edit the patterns'),
          '. Names update when the source refreshes, so give event sources a short refresh interval.'),
        h('label', { class: 'check second' },
          h('input', { type: 'checkbox', disabled: off, checked: data.hide_by_guide, onchange: (e) => setOption('hide_by_guide', e.target.checked) }),
          h('b', null, ' Hide channels by guide'),
          h('span', { class: 'meta' }, ` · by what's on now · ${guideCount} of ${chans.length} show a placeholder now`)),
        h('span', { class: 'hint' },
          'Hides a channel while the programme on now is titled like "No Game Today" or "Off Air", and shows it again when a real listing starts. ',
          h('a', { href: '#/settings' }, 'Edit the patterns'),
          '. Players only notice when they reload the playlist.'),
        h('label', { class: 'check sub' },
          h('input', { type: 'checkbox', disabled: off || !data.hide_by_guide, checked: data.hide_unlisted, onchange: (e) => setOption('hide_unlisted', e.target.checked) }),
          ' Also hide channels with nothing listed right now',
          h('span', { class: 'meta' }, ` · ${unlistedCount} of ${chans.length}`)),
        h('span', { class: 'hint sub' },
          'For event channels whose guide stays empty until a game is scheduled. Counts channels that have a guide id but no programme ',
          '(or a blank title) airing now. Channels without any guide id are never hidden, and if this source\'s guide has nothing airing ',
          'now on any channel (it ran out or failed to refresh), nothing is hidden this way.'),
        data.hide_unlisted && !data.guide_current
          ? h('span', { class: 'hint sub warn-text' }, 'This source\'s guide has nothing airing now on any channel, so no channels are being hidden as "nothing listed". Check the source\'s guide refresh.')
          : null),
      h('div', { class: 'ch-rules' },
        h('div', { class: 'ch-rules-head' },
          h('b', null, 'Channel rules'),
          h('span', { class: 'hint' }, 'Filter channels inside this category by name. Channels the provider adds later are sorted by these rules too.')),
        ruleBox),
      h('div', { class: 'ch-toolbar' },
        h('span', { class: 'meta' }, `${included} of ${chans.length} channels included`),
        h('span', { class: 'row' },
          h('button', { class: 'btn small', disabled: off, title: 'Include every channel in this category by hand', onclick: () => setChannels(chans.map((ch) => ch.id), 'include') }, 'Select all'),
          h('button', { class: 'btn small', disabled: off, title: 'Exclude every channel in this category by hand', onclick: () => setChannels(chans.map((ch) => ch.id), 'exclude') }, 'Deselect all'),
          h('button', { class: 'btn small', disabled: off || !overridden.length, title: 'Clear hand picks so the category and channel rules decide', onclick: () => setChannels(overridden, null) }, 'Reset to rules'))),
      h('div', { class: 'ch-box' },
        // Two lines per channel: the name gets the full width; details go underneath.
        chans.map((ch) => {
          const name = ch.custom_name || ch.name;
          const why = !off && ch.reason !== 'category' ? reason(ch) : '';
          const now = ch.now_title ? h('span', { class: `now-title ${ch.is_guide_placeholder ? 'placeholder' : ''}`, title: `On now: ${ch.now_title}` }, `▸ ${ch.now_title}`)
            : ch.is_unlisted ? h('span', { class: 'now-title placeholder', title: 'Nothing airing now in the guide' }, '▸ nothing listed') : null;
          return h('label', { class: `ch-row ${ch.override && !off ? 'overridden' : ''} ${ch.included ? '' : 'out'}`, title: off ? 'Include the category first' : [name, why].filter(Boolean).join('\n') },
            h('input', { type: 'checkbox', disabled: off, checked: ch.included, onchange: (e) => setChannels([ch.id], e.target.checked ? 'include' : 'exclude') }),
            h('span', { class: 'ch-name' }, name),
            now || why || (ch.override && !off)
              ? h('span', { class: 'ch-details' },
                why ? h('span', { class: 'ch-why' }, why) : null,
                now,
                ch.override && !off ? h('button', { class: 'link', onclick: (e) => { e.preventDefault(); setChannels([ch.id], null); } }, 'reset') : null)
              : null);
        }),
        chans.length ? null : h('p', { class: 'meta' }, 'No channels.')));
  };

  const catSearch = h('input', { type: 'search', placeholder: 'Search categories', oninput: (e) => { view.q = e.target.value; drawCats(); } });
  const show = h('select', { onchange: (e) => { view.show = e.target.value; drawCats(); } },
    [['all', 'All'], ['included', 'Included'], ['excluded', 'Excluded'], ['new', 'New'], ['manual', 'Picked by hand']].map(([v, l]) => h('option', { value: v }, l)));
  const bulk = (state) => () => setOverride(visible().map((c) => c.id), state);
  const catsCard = h('section', { class: 'card' },
    h('div', { class: 'card-head' }, h('h2', null, 'Categories'), summary),
    h('div', { class: 'toolbar' }, catSearch, show,
      h('span', { class: 'row' },
        h('button', { class: 'btn small', onclick: bulk('include') }, 'Include shown'),
        h('button', { class: 'btn small', onclick: bulk('exclude') }, 'Exclude shown'),
        h('button', { class: 'btn small', onclick: bulk(null) }, 'Reset shown to Auto'))),
    catBox);

  // --- urls
  const urlsCard = h('section', { class: 'card' });
  const drawUrls = () => {
    fill(urlsCard, 
      h('div', { class: 'card-head' }, h('h2', null, 'Connect your apps'), h('span', { class: 'meta' }, `${o.channel_count} channels live`)),
      copyField('M3U playlist', o.urls.m3u),
      copyField('XMLTV guide', o.urls.epg),
      copyField('XMLTV guide (gzip)', o.urls.epg_gz),
      o.xc_enabled ? h('div', { class: 'xc-box' },
        h('h3', null, 'Xtream Codes login'),
        copyField('Server', o.urls.xc_server), h('div', { class: 'two' }, copyField('Username', o.xc_username), copyField('Password', o.xc_password))) : null,
      h('div', { class: 'row' },
        h('a', { class: 'btn small', href: o.urls.m3u, target: '_blank', rel: 'noopener' }, 'Open playlist'),
        h('button', {
          class: 'btn small danger-text',
          onclick: async () => {
            if (!(await confirmBox('Make new URLs for this output? Apps using the current URLs will stop working until you update them.', 'Regenerate'))) return;
            o = await attempt(() => api('POST', `/api/outputs/${id}/token`), 'New URLs created');
            drawUrls();
          },
        }, 'Regenerate URLs'),
        h('button', {
          class: 'btn small danger-text',
          onclick: async () => {
            if (!(await confirmBox(`Delete the output "${o.name}"? Its URLs will stop working.`))) return;
            await attempt(() => api('DELETE', `/api/outputs/${id}`), 'Output deleted');
            dirty = false;
            location.hash = '#/outputs';
          },
        }, 'Delete output')));
  };
  const refreshCounts = async () => {
    o = { ...o, ...(await api('GET', `/api/outputs/${id}`)) };
    drawUrls();
  };
  drawUrls();

  const save = async () => {
    const payload = {
      name: draft.name,
      stream_mode: draft.stream_mode,
      number_start: draft.number_start === '' ? null : Number(draft.number_start),
      epg_days: Number(draft.epg_days) || 7,
      include_all: draft.include_all,
      xc_enabled: draft.xc_enabled,
      xc_username: draft.xc_username,
      xc_password: draft.xc_password,
      source_ids: attachedIds(),
      rules: draft.rules.filter((r) => r.value !== ''),
    };
    o = await attempt(() => api('PUT', `/api/outputs/${id}`, payload), 'Output saved');
    cats = await api('GET', `/api/outputs/${id}/categories`);
    draft.rules = o.rules.map((r) => ({ ...r }));
    dirty = false;
    saveBar.hidden = true;
    title.textContent = o.name;
    drawRules();
    drawCats();
    drawUrls();
  };

  const title = h('h1', null, o.name);
  fill(main, 
    h('div', { class: 'page-head' }, h('div', null, h('a', { href: '#/outputs', class: 'crumb' }, '‹ Outputs'), title)),
    h('div', { class: 'editor' },
      h('div', { class: 'editor-main' }, rulesCard, catsCard),
      h('div', { class: 'editor-side' }, urlsCard, settingsCard, sourcesCard)),
    saveBar);
  drawCats();
}

// --------------------------------------------------------------- settings --

async function settingsView(main) {
  const s = await api('GET', '/api/settings');
  const baseInput = h('input', { value: s.base_url, placeholder: s.detected_base_url });
  const cur = h('input', { type: 'password', autocomplete: 'current-password' });
  const next = h('input', { type: 'password', autocomplete: 'new-password' });
  fill(main, 
    h('div', { class: 'page-head' }, h('h1', null, 'Settings')),
    h('section', { class: 'card narrow' },
      h('h2', null, 'Public address'),
      h('form', { class: 'form', onsubmit: async (e) => { e.preventDefault(); await attempt(() => api('PUT', '/api/settings', { base_url: baseInput.value }), 'Saved'); } },
        field('Base URL for published links', baseInput,
          `Used in playlist and stream URLs. Leave empty to use the address you browse with (currently ${s.detected_base_url}). Set it if apps reach this server by another name, or through a reverse proxy.`),
        h('button', { class: 'btn primary' }, 'Save'))),
    h('section', { class: 'card narrow' },
      h('h2', null, 'Admin password'),
      h('form', {
        class: 'form',
        onsubmit: async (e) => {
          e.preventDefault();
          await attempt(() => api('POST', '/api/password', { current: cur.value, next: next.value }), 'Password changed; other sessions were signed out');
          cur.value = next.value = '';
        },
      }, field('Current password', cur), field('New password', next, 'At least 8 characters.'), h('button', { class: 'btn primary' }, 'Change password'))),
    updatesCard(await api('GET', '/api/updates')),
    emptyEventCard(s),
    guidePatternsCard(s),
    backupCard(),
    advancedCard(s));
}

/**
 * "Show advanced options" keeps rarely needed features out of the way. When it is on, this card
 * holds the advanced global switches, and outputs show their name cleanup section.
 */
function advancedCard(s) {
  const card = h('section', { class: 'card narrow' });
  const draw = () => {
    fill(card,
      h('label', { class: 'check' },
        h('input', {
          type: 'checkbox',
          checked: s.advanced,
          onchange: async (e) => {
            await attempt(() => api('PUT', '/api/settings', { advanced: e.target.checked }));
            s.advanced = e.target.checked;
            draw();
          },
        }),
        h('b', null, ' Show advanced options')),
      h('span', { class: 'hint' }, 'Extra features most setups don\'t need. Turning this off hides them again; anything already set up keeps working.'),
      s.advanced ? h('div', { class: 'advanced-box' },
        h('label', { class: 'check' },
          h('input', {
            type: 'checkbox',
            checked: s.guide_logo_fallback,
            onchange: (e) => attempt(() => api('PUT', '/api/settings', { guide_logo_fallback: e.target.checked }),
              e.target.checked ? 'Guide logos on' : 'Guide logos off').then(() => { s.guide_logo_fallback = e.target.checked; }),
          }),
          ' Use guide logos for channels without one'),
        h('span', { class: 'hint' }, 'When the provider gives a channel no logo, use the logo its guide lists (if any). Provider logos and your own always win.')) : null);
  };
  draw();
  return card;
}

// Functions, so each render gets its own nodes.
const HOW_TO_UPDATE = {
  docker: () => ['In Portainer, open the stack and click ', h('b', null, 'Pull and redeploy'),
    ' (or turn on GitOps updates). With Docker Compose: ', h('code', null, 'git pull && docker compose up -d --build'), '.'],
  proxmox: () => ['On the Proxmox host run ', h('code', null, 'pct exec <container id> -- iptv-manager-update'),
    ', or turn on nightly updates with ', h('code', null, 'iptv-manager-update --enable-auto'), '.'],
  other: () => ['Run ', h('code', null, 'git pull'), ' in the app folder, then restart the app.'],
};

const UPDATE_RESULTS = {
  updated: ['ok', 'Updated'],
  current: ['ok', 'Already up to date'],
  skipped: ['warn', 'Skipped'],
  rolled_back: ['warn', 'Rolled back'],
  failed: ['error', 'Failed'],
};

function updatesCard(initial) {
  const card = h('section', { class: 'card narrow' });
  let watching = null; // { since, timer } while following an update

  // Follow an update through the app restart; reload into the new version when it is done.
  const follow = (since) => {
    if (watching) return;
    const started = Date.now();
    watching = { since, timer: setInterval(async () => {
      let u;
      try {
        u = await api('GET', '/api/updates');
      } catch {
        return; // the app is restarting
      }
      const wu = u.web_update;
      const done = !wu.busy && wu.status && wu.status.state !== 'running' && (wu.status.started_at || 0) >= since - 5;
      if (done || Date.now() - started > 10 * 60_000) {
        clearInterval(watching.timer);
        watching = null;
        if (wu.status?.state === 'updated') {
          toast('Updated; reloading');
          setTimeout(() => location.reload(), 800);
          return;
        }
      }
      draw(u);
    }, 2000) };
  };

  const webUpdate = (u) => {
    const wu = u.web_update || {};
    if (!wu.available) {
      return u.install_type === 'proxmox'
        ? h('p', { class: 'hint' }, 'To update from here, run this once on the Proxmox host: ',
          h('code', null, 'pct exec <container id> -- iptv-manager-update --setup'))
        : null;
    }
    const st = wu.status;
    if (wu.busy) {
      return h('div', { class: 'update-progress' },
        h('p', null, h('span', { class: 'spinner' }), ' ', h('b', null, wu.pending ? 'Update requested, starting…' : st?.message || 'Updating…')),
        wu.log?.length ? h('pre', { class: 'update-log' }, wu.log.join('\n')) : null,
        h('p', { class: 'hint' }, 'The app restarts during the update; this page reconnects and reloads by itself.'));
    }
    const recent = st && st.finished_at && Date.now() / 1000 - st.finished_at < 86400;
    const [kind, label] = UPDATE_RESULTS[st?.state] || [];
    return recent && label ? h('p', null, badge(label, kind), ' ', h('span', { class: 'meta' }, `${st.message} (${ago(st.finished_at)})`)) : null;
  };

  // "Update automatically every night at HH:MM": carried out by the root updater, which confirms
  // through auto.json; the switch waits for that confirmation.
  const nightly = (u) => {
    const wu = u.web_update || {};
    if (!wu.available) return null;
    const a = wu.auto;
    const time = h('input', { type: 'time', class: 'time-input', value: a?.at || '04:00' });
    const box = h('input', { type: 'checkbox', checked: !!a?.enabled });
    const apply = async (enabled) => {
      box.disabled = time.disabled = true;
      try {
        await attempt(() => api('POST', '/api/updates/auto', { enabled, at: time.value }));
        for (let i = 0; i < 15; i++) {
          await new Promise((r) => setTimeout(r, 1000));
          const r = await api('GET', '/api/updates');
          const now = r.web_update.auto;
          if (now && now.enabled === enabled && (!enabled || now.at === time.value)) {
            toast(enabled ? `Nightly updates at ${time.value}` : 'Nightly updates off');
            draw(r);
            return;
          }
        }
        toast('The updater has not confirmed the change yet; check again in a minute', 'error');
      } catch {
        box.checked = !enabled;
      } finally {
        box.disabled = time.disabled = false;
      }
    };
    box.addEventListener('change', () => apply(box.checked));
    time.addEventListener('change', () => { if (box.checked) apply(true); });
    return h('div', { class: 'check nightly' }, box, h('span', null, ' Update automatically every night at '), time,
      h('span', { class: 'meta' }, ' (plus up to 30 min random delay)'));
  };

  // Sits in the action row next to "Check now".
  const updateButton = (u) => {
    const wu = u.web_update || {};
    if (!wu.available || wu.busy || !(u.behind > 0)) return null;
    return h('button', {
      class: 'btn primary',
      onclick: async (e) => {
        if (!(await confirmBox('Install the update now? The app restarts, which takes up to about a minute; streams playing through it drop briefly. If the new version fails to start, the current one is restored automatically.', 'Update now'))) return;
        e.target.disabled = true;
        const since = Math.floor(Date.now() / 1000);
        try {
          draw(await attempt(() => api('POST', '/api/updates/apply')));
          follow(since);
        } catch {
          e.target.disabled = false;
        }
      },
    }, 'Update now');
  };

  const draw = (u) => {
    const gh = (sha) => `https://github.com/${u.repo}/commit/${sha}`;
    const short = (sha) => (sha ? sha.slice(0, 7) : 'unknown');
    const date = (d) => (d ? new Date(d).toLocaleDateString() : '');
    const canApply = u.web_update?.available;
    let status;
    if (!u.checked_at) status = h('p', { class: 'meta' }, 'Not checked yet.');
    else if (u.behind > 0) {
      status = h('div', null,
        h('p', { class: 'update-available' }, `Update available: ${u.behind} new change${u.behind === 1 ? '' : 's'}.`),
        h('ul', { class: 'commit-list' }, u.commits.map((c) => h('li', null,
          h('a', { href: gh(c.sha), target: '_blank', rel: 'noopener' }, c.message), ' ', h('span', { class: 'meta' }, date(c.date))))),
        canApply ? null : h('p', { class: 'hint' }, (HOW_TO_UPDATE[u.install_type] || HOW_TO_UPDATE.other)()));
    } else if (u.behind === 0) status = h('p', null, badge('Up to date', 'ok'), ' ', h('span', { class: 'meta' }, u.note || ''));
    else status = h('p', { class: 'meta' }, u.note || 'Could not compare versions.');
    if (u.web_update?.busy && !watching) follow(u.web_update.status?.started_at || Math.floor(Date.now() / 1000));
    // Just updated: the server re-checks against the new version within seconds; pick that up.
    if (u.checking && !watching && (card._recheck || 0) < 5) {
      card._recheck = (card._recheck || 0) + 1;
      setTimeout(async () => {
        if (!card.isConnected) return;
        try {
          const r = await api('GET', '/api/updates');
          draw(r);
          updateBadge(r);
        } catch {}
      }, 4000);
    }
    fill(card,
      h('h2', null, 'Version & updates'),
      h('p', null, `IPTV Manager ${u.version} · `,
        u.commit ? h('a', { href: gh(u.commit), target: '_blank', rel: 'noopener', class: 'mono' }, short(u.commit)) : h('span', { class: 'meta' }, 'commit unknown')),
      status,
      webUpdate(u),
      u.error ? h('p', { class: 'form-error' }, `Last check failed: ${u.error}`) : null,
      h('div', { class: 'row update-actions' },
        updateButton(u),
        h('button', {
          class: 'btn',
          onclick: async (e) => {
            e.target.disabled = true;
            try {
              const r = await attempt(() => api('POST', '/api/updates/check'));
              draw(r);
              updateBadge(r);
            } finally {
              e.target.disabled = false;
            }
          },
        }, 'Check now'),
        u.checked_at ? h('span', { class: 'meta' }, `Last checked ${ago(u.checked_at)}`) : null),
      h('label', { class: 'check' },
        h('input', {
          type: 'checkbox',
          checked: u.enabled,
          onchange: (e) => attempt(() => api('PUT', '/api/settings', { update_check: e.target.checked }), e.target.checked ? 'Daily check on' : 'Daily check off'),
        }),
        ` Check GitHub (${u.repo}) for updates once a day`),
      nightly(u),
      h('p', { class: 'hint' }, u.web_update?.available
        ? 'Update now runs the same updater as iptv-manager-update in the container, including its automatic rollback.'
        : 'The check only reports new versions; updating is done the way this copy was installed.'));
  };
  draw(initial);
  return card;
}

// Top-bar "Update available" link, refreshed from the cached check at most every few minutes.
let badgeFetchedAt = 0;
function updateBadge(u) {
  const el = shell?.header.querySelector('.update-badge');
  if (!el) return;
  el.hidden = !(u && u.behind > 0);
  el.title = u && u.behind > 0 ? `${u.behind} new change${u.behind === 1 ? '' : 's'} on GitHub` : '';
}
async function refreshUpdateBadge() {
  if (Date.now() - badgeFetchedAt < 5 * 60_000) return;
  badgeFetchedAt = Date.now();
  try {
    updateBadge(await api('GET', '/api/updates'));
  } catch {}
}

/**
 * Plain-English reading of a simple pattern: an anchor (^ … / … $, with optional \s*)
 * around a literal or a digit class. Anything more elaborate is called a custom pattern.
 */
function describePattern(p) {
  let s = String(p || '').trim();
  if (!s) return 'type a pattern';
  try {
    new RegExp(s, 'i');
  } catch {
    return 'not a valid pattern';
  }
  const start = s.startsWith('^');
  if (start) s = s.slice(1).replace(/^\\s\*/, '');
  const endRe = /(?:\\s\*)?\$$/;
  const end = endRe.test(s);
  if (end) s = s.replace(endRe, '');
  const where = start && end ? 'is' : start ? 'starts with' : end ? 'ends with' : 'contains';
  if (/^(?:\\d|\[0-9\])(?:\+|\{1,\})?$/.test(s)) return `${where} a number`;
  if (s && /^(?:\\[^\w\s]|[^\\^$.*+?()[\]{}|])+$/.test(s)) {
    return `${where === 'is' ? 'is exactly' : where} "${s.replace(/\\(.)/g, '$1')}"`;
  }
  return 'custom pattern';
}

/** Settings card for the name patterns behind "Hide empty event channels". */
function emptyEventCard(s) {
  return patternsCard({
    title: 'Empty event channels',
    key: 'empty_event_patterns',
    patterns: s.empty_event_patterns,
    defaults: s.empty_event_defaults,
    tryPlaceholder: 'Try a channel name, e.g. ESPN+ 03:',
    intro: ['Event providers keep placeholder channels, such as "ESPN+ 03:" or "PPV 12 NO EVENT", that only carry something when an event is scheduled. ',
      'Turn on "Hide empty event channels" in an expanded category of an output to hide the placeholders. ',
      'A channel counts as empty when its name matches any pattern below (regular expressions, case-insensitive).'],
    note: ['Note: "ends with a number" also hides a live event whose title ends in a number, e.g. "PPV 01: UFC 300". ',
      'Replacing it with ^[^:]*\\d\\s*$ only counts names without a ":" as empty.'],
  });
}

/** Settings card for the guide-title patterns behind "Hide channels by guide". */
function guidePatternsCard(s) {
  return patternsCard({
    title: 'Guide placeholders',
    key: 'guide_patterns',
    patterns: s.guide_patterns,
    defaults: s.guide_defaults,
    tryPlaceholder: 'Try a programme title, e.g. No Game Today',
    intro: ['Some event channels always have a name, but their guide says "No Game Today" or "Off Air" while nothing is on. ',
      'Turn on "Hide channels by guide" in an expanded category of an output to hide them until a real listing starts. ',
      'A channel counts as empty while the title of the programme on now matches any pattern below (case-insensitive).'],
    note: null,
  });
}

/** Editable list of case-insensitive regular expressions stored in one setting. */
function patternsCard({ title, key, patterns: initial, defaults, tryPlaceholder, intro, note }) {
  let patterns = [...initial];
  const list = h('div', { class: 'form' });
  const testInput = h('input', { placeholder: tryPlaceholder });
  const testResult = h('span', { class: 'pattern-result' });
  const runTest = () => {
    const name = testInput.value;
    if (!name) return (testResult.textContent = '');
    const hit = patterns.find((p) => {
      try {
        return new RegExp(p, 'i').test(name);
      } catch {
        return false;
      }
    });
    testResult.className = `pattern-result ${hit ? 'empty' : 'kept'}`;
    testResult.textContent = hit ? `Empty: ${describePattern(hit)}` : 'Not empty: kept';
  };
  const draw = () => {
    fill(list,
      patterns.map((p, i) => {
        const desc = h('span', { class: 'pattern-desc', title: describePattern(p) }, describePattern(p));
        return h('div', { class: 'pattern-row' },
          h('input', {
            value: p,
            spellcheck: 'false',
            oninput: (e) => {
              patterns[i] = e.target.value;
              desc.textContent = desc.title = describePattern(e.target.value);
              runTest();
            },
          }),
          desc,
          h('button', { class: 'icon-btn', title: 'Remove pattern', onclick: () => { patterns.splice(i, 1); draw(); runTest(); } }, '✕'));
      }),
      patterns.length ? null : h('p', { class: 'meta' }, 'No patterns: the toggle hides nothing until you add one.'),
      h('div', { class: 'row' },
        h('button', { class: 'btn small', onclick: () => { patterns.push(''); draw(); [...list.querySelectorAll('input')].pop()?.focus(); } }, '+ Add pattern'),
        h('button', { class: 'btn small', onclick: () => { patterns = [...defaults]; draw(); runTest(); } }, 'Restore defaults'),
        h('button', {
          class: 'btn small primary',
          onclick: async () => {
            // Saving exactly the defaults stores "defaults", so later default changes still apply.
            const isDefault = JSON.stringify(patterns) === JSON.stringify(defaults);
            const r = await attempt(() => api('PUT', '/api/settings', { [key]: isDefault ? null : patterns.filter((p) => p.trim()) }), 'Patterns saved');
            patterns = [...r[key]];
            draw();
          },
        }, 'Save patterns')));
  };
  testInput.addEventListener('input', runTest);
  draw();
  return h('section', { class: 'card narrow' },
    h('h2', null, title),
    h('p', { class: 'hint' }, intro),
    list,
    h('div', { class: 'pattern-test' }, testInput, testResult),
    note ? h('p', { class: 'hint' }, note) : null);
}

function backupCard() {
  const secrets = h('input', { type: 'checkbox', checked: true });
  const file = h('input', { type: 'file', accept: '.json,application/json' });

  const exportNow = async () => {
    const res = await fetch(`/api/export?secrets=${secrets.checked ? 1 : 0}`);
    if (!res.ok) return toast(`Export failed (${res.status})`, 'error');
    const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') || '')?.[1] || 'iptv-manager-settings.json';
    const url = URL.createObjectURL(await res.blob());
    const a = h('a', { href: url, download: name });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const importNow = async () => {
    const f = file.files[0];
    if (!f) return toast('Choose a settings file first', 'error');
    let data;
    try {
      data = JSON.parse(await f.text());
    } catch {
      return toast('That file is not valid JSON', 'error');
    }
    const counts = `${data.sources?.length ?? 0} sources and ${data.outputs?.length ?? 0} outputs`;
    const warn = data.includes_secrets === false ? ' This file has no provider passwords, so you will need to re-enter them.' : '';
    if (!(await confirmBox(`Replace ALL current sources and outputs with the ${counts} in "${f.name}"? This cannot be undone. Export first if you want a copy of the current setup.${warn}`, 'Replace and import'))) return;
    const r = await attempt(() => api('POST', '/api/import', data));
    toast(`Imported ${r.sources} sources and ${r.outputs} outputs; refreshing sources now`);
    location.hash = '#/sources';
  };

  return h('section', { class: 'card narrow' },
    h('h2', null, 'Backup & restore'),
    h('div', { class: 'form' },
      h('p', { class: 'hint' },
        'The export holds your sources, outputs, filter rules, category and channel picks, channel edits, Jellyfin tags and output URLs. ',
        'It does not hold the downloaded playlists and guides, which are fetched again after an import, or uploaded playlist files. ',
        'Your admin password is never included.'),
      h('label', { class: 'check' }, secrets, ' Include provider passwords and output logins'),
      h('span', { class: 'hint' }, 'The file then contains credentials, so store it somewhere safe.'),
      h('div', null, h('button', { class: 'btn primary', onclick: exportNow }, 'Export settings')),
      h('hr', { class: 'sep' }),
      field('Import a settings file', file, 'Importing replaces every source and output here with the ones in the file. Output URLs and logins stay the same, so your apps keep working.'),
      h('div', null, h('button', { class: 'btn danger', onclick: importNow }, 'Import and replace…'))));
}

window.addEventListener('hashchange', route);
route();
