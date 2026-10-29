// The preload script's bridge to the main process (electron/preload.cjs).
const hr = window.headroom;
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];

// ---------- Formatting ----------

function parts(b) {
  if (b == null || Number.isNaN(b)) return ['?', ''];
  const units = ['bytes', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (b >= 1000 && i < units.length - 1) { b /= 1000; i++; }
  return [b.toFixed(i < 2 || b >= 100 ? 0 : 1), units[i]];
}
const fmt = (b) => parts(b).join(' ');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function ago(iso) {
  if (!iso) return 'Never opened';
  const days = Math.floor((Date.now() - Date.parse(iso)) / 86_400_000);
  if (days < 1) return 'Used today';
  if (days < 2) return 'Used yesterday';
  if (days < 14) return `Used ${days} days ago`;
  if (days < 60) return `Used ${Math.round(days / 7)} weeks ago`;
  return `Used ${Math.round(days / 30)} months ago`;
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

const icon = {
  chevron: '<svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M3.5 5.5 7 9l3.5-3.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  finder: '<svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="m10.5 10.5 3 3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
  folder: '<svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true"><path d="M2 5.2c0-.9.7-1.7 1.7-1.7h3.2l1.6 1.8h5.8c.9 0 1.7.7 1.7 1.6v6.4c0 .9-.8 1.7-1.7 1.7H3.7c-1 0-1.7-.8-1.7-1.7Z" fill="currentColor" opacity=".9"/></svg>',
  file: '<svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true"><path d="M5 2.5h5l3.5 3.5v9a.5.5 0 0 1-.5.5H5a.5.5 0 0 1-.5-.5V3a.5.5 0 0 1 .5-.5Z M10 2.5V6h3.5" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>',
  package: '<svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true"><rect x="3" y="3" width="12" height="12" rx="3.2" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M6.5 9h5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
  link: '<svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true"><path d="M7.5 10.5 10.5 7.5M8 5.5l1-1a2.8 2.8 0 0 1 4 4l-1 1M10 12.5l-1 1a2.8 2.8 0 0 1-4-4l1-1" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
};

// ---------- State ----------

const S = {
  disk: null,
  groups: [],
  order: [],
  items: new Map(),
  sel: new Map(),
  expanded: new Set(),
  showAll: new Set(),
  scanning: false,
  measured: 0,
  cleaning: null,
  tab: 'clean',
  ex: { path: null, items: [], loading: false, error: null, showSmall: false },
  sims: null,
  simBusy: null,
};

const ready = (it) => it && !it.pending;
const selBytesOf = (it) => {
  const set = S.sel.get(it.id);
  return set ? it.entries.reduce((s, e) => s + (set.has(e.id) ? e.bytes || 0 : 0), 0) : 0;
};
const selectedBytes = () => [...S.items.values()].filter(ready).reduce((s, it) => s + selBytesOf(it), 0);
const reclaimBytes = () => [...S.items.values()].filter(ready).reduce((s, it) => s + (it.bytes || 0), 0);
const defaults = (it) => new Set(it.entries.filter((e) => e.checked).map((e) => e.id));

// ---------- Rendering ----------

let raf = 0;
function scheduleRender() {
  if (!raf) raf = requestAnimationFrame(() => { raf = 0; renderAll(); });
}

function renderAll() {
  renderHeader();
  const key = document.activeElement?.dataset?.key;
  if (S.tab === 'clean') renderClean();
  else if (S.tab === 'explore') renderExplore();
  else renderSims();
  if (key) document.querySelector(`[data-key="${CSS.escape(key)}"]`)?.focus();
}

const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');

function drawFigure(el, bytes) {
  const [n, u] = parts(bytes);
  el.innerHTML = `<span class="figure__num">${n}</span><span class="figure__unit">${u}</span>`;
}

function tweenFigure(el, to) {
  const from = el._value ?? to;
  el._value = to;
  cancelAnimationFrame(el._raf);
  if (from === to || reduceMotion.matches) return drawFigure(el, to);
  const start = performance.now();
  const step = (now) => {
    const t = Math.min(1, (now - start) / 450);
    drawFigure(el, from + (to - from) * (1 - (1 - t) ** 3));
    if (t < 1) el._raf = requestAnimationFrame(step);
  };
  el._raf = requestAnimationFrame(step);
}

function renderHeader() {
  const d = S.disk;
  if (!d) return;
  $('#volume').textContent = `${d.name}, ${fmt(d.total)}`;
  tweenFigure($('#free-now'), d.free);
  const sel = selectedBytes();
  $('#after').dataset.empty = sel > 0 ? 'false' : 'true';
  tweenFigure($('#free-after'), d.free + sel);

  const used = Math.max(0, d.total - d.free);
  const reclaim = Math.min(reclaimBytes(), used);
  const selected = Math.min(sel, reclaim);
  const files = used - reclaim;
  const pct = (v) => `${(v / d.total) * 100}%`;
  $('#seg-files').style.flexBasis = pct(files);
  $('#seg-reclaim').style.flexBasis = pct(reclaim - selected);
  $('#seg-selected').style.flexBasis = pct(selected);
  $('#seg-free').style.flexBasis = pct(d.free);
  $('#strip').setAttribute('aria-label', `${fmt(used)} used, ${fmt(reclaim)} of it can be cleaned, ${fmt(d.free)} free`);

  const rows = [
    ['files', 'Everything else', files],
    ['reclaim', S.scanning ? 'Can be cleaned, still counting' : 'Can be cleaned', reclaim - selected],
    ['selected', 'Selected', selected],
    ['free', 'Free', d.free],
  ];
  $('#legend').innerHTML = rows.map(([k, label, v]) =>
    `<li class="legend__item"><span class="swatch swatch--${k}"></span>${label} <b>${fmt(v)}</b></li>`).join('');
}

// ---------- Clean up ----------

function statusHTML(st) {
  switch (st.state) {
    case 'queued': return '<span class="status size--muted">Waiting</span>';
    case 'running': return `<span class="status status--busy"><span class="spinner"></span>Cleaning${st.total > 1 ? ` ${st.done} of ${st.total}` : ''}</span>`;
    case 'done': return '<span class="status status--ok">Cleaned</span>';
    case 'partial': return `<span class="status status--warn" title="Some files were in use or protected">Cleaned, ${st.skipped} skipped</span>`;
    default: return `<span class="status status--err">Not cleaned</span>`;
  }
}

function entriesHTML(it, set) {
  const all = S.showAll.has(it.id);
  const shown = all ? it.entries : it.entries.slice(0, 8);
  const locked = !!S.cleaning;
  const rows = shown.map((e) => {
    const id = `c-${it.id}-${e.id}`;
    return `<li class="entry">
      <input type="checkbox" class="check" id="${id}" data-key="${id}" data-entry-of="${it.id}" data-entry="${e.id}" ${set.has(e.id) ? 'checked' : ''} ${locked ? 'disabled' : ''}>
      <label class="entry__label" for="${id}" title="${esc(e.path || e.label)}">${esc(e.label)}${e.detail ? `<span class="entry__detail">${esc(e.detail)}</span>` : ''}</label>
      <span class="size">${e.bytes == null ? 'Unknown' : fmt(e.bytes)}</span>
      ${e.path ? `<button class="reveal" type="button" data-reveal="${esc(e.path)}" title="Show in Finder" aria-label="Show ${esc(e.label)} in Finder">${icon.finder}</button>` : '<span class="reveal reveal--blank"></span>'}
    </li>`;
  }).join('');
  const more = !all && it.entries.length > shown.length
    ? `<div class="entries__more"><button class="link" type="button" data-more="${it.id}">Show ${it.entries.length - shown.length} more</button></div>` : '';
  return `<ul class="entries">${rows}</ul>${more}`;
}

function itemHTML(it) {
  const set = S.sel.get(it.id) || new Set();
  const n = it.entries?.length || 0;
  const all = n > 0 && set.size === n;
  const some = set.size > 0 && !all;
  const status = S.cleaning?.get(it.id);
  const unknown = n > 0 && it.entries.every((e) => e.bytes == null);
  let right;
  if (status) right = statusHTML(status);
  else if (it.pending) right = '<span class="size"><span class="measuring" role="img" aria-label="Measuring"></span></span>';
  else if (unknown) right = '<span class="size size--muted">Unknown</span>';
  else right = `<span class="size">${it.upTo ? '<span class="size--muted">up to </span>' : ''}${fmt(it.bytes)}</span>`;
  const expanded = S.expanded.has(it.id) && n > 0;
  const cid = `c-${it.id}`;
  return `<div class="item">
    <div class="item__row">
      <input type="checkbox" class="check" id="${cid}" data-key="${cid}" data-item="${it.id}" ${all ? 'checked' : ''} ${some ? 'data-indeterminate' : ''} ${it.pending || !n || S.cleaning ? 'disabled' : ''}>
      <label for="${cid}">
        <span class="item__title">${esc(it.title)}${it.suggested ? '' : '<span class="item__note">Review first</span>'}</span>
        <span class="item__desc" style="display:block">${esc(it.desc)}</span>
        ${it.error ? `<span class="item__error" style="display:block">${esc(it.error)}</span>` : ''}
        ${status?.error ? `<span class="item__error" style="display:block">${esc(status.error)}</span>` : ''}
      </label>
      ${right}
      ${n ? `<button class="expand" type="button" data-key="x-${it.id}" data-expand="${it.id}" aria-expanded="${expanded}" aria-label="${expanded ? 'Hide' : 'Show'} what’s inside ${esc(it.title)}">${icon.chevron}</button>` : '<span></span>'}
    </div>
    ${expanded ? entriesHTML(it, set) : ''}
  </div>`;
}

function renderClean() {
  const panel = $('#panel-clean');
  if (!S.groups.length) {
    panel.innerHTML = '<div class="empty"><strong>Looking around your Mac</strong>Measuring caches, simulators and old projects.</div>';
    return;
  }
  const items = S.order.map((id) => S.items.get(id));
  const sel = selectedBytes();
  const count = items.filter((it) => ready(it) && S.sel.get(it.id)?.size).length;
  const cleaning = !!S.cleaning;

  let html = `<div class="actionbar">
    <div class="actionbar__text">
      <span class="actionbar__sum">${cleaning ? 'Cleaning…' : sel ? `${fmt(sel)} selected in ${plural(count, 'item')}` : 'Nothing selected'}</span>
      <span class="actionbar__links">
        ${S.scanning ? `<span>Measured ${S.measured} of ${S.order.length}</span>` : ''}
        <button class="link" type="button" data-act="suggested" ${cleaning ? 'disabled' : ''}>Select suggested</button>
        <button class="link" type="button" data-act="none" ${cleaning ? 'disabled' : ''}>Select none</button>
      </span>
    </div>
    <button class="btn btn--primary" type="button" data-act="clean" data-key="clean" ${!sel || cleaning ? 'disabled' : ''}>${sel ? `Clean ${fmt(sel)}` : 'Clean'}</button>
  </div>`;

  const clean = [];
  for (const g of S.groups) {
    const visible = items.filter((it) => it.group === g.id && (it.pending || it.error || it.entries.length));
    items.filter((it) => it.group === g.id && ready(it) && !it.error && !it.entries.length).forEach((it) => clean.push(it.title));
    if (!visible.length) continue;
    const total = visible.filter(ready).reduce((s, it) => s + it.bytes, 0);
    html += `<section class="group">
      <div class="group__head"><h2 class="group__title">${esc(g.title)}</h2><span class="group__total">${total ? fmt(total) : ''}</span></div>
      ${visible.map(itemHTML).join('')}
    </section>`;
  }
  if (!S.scanning && clean.length) {
    html += `<p class="footnote">Nothing to clean in ${esc(clean.join(', '))}.</p>`;
  }
  panel.innerHTML = html;
  $$('[data-indeterminate]', panel).forEach((el) => { el.indeterminate = true; });
}

function onCleanChange(e) {
  const t = e.target;
  if (t.dataset.item) {
    const it = S.items.get(t.dataset.item);
    S.sel.set(it.id, t.checked ? new Set(it.entries.map((x) => x.id)) : new Set());
  } else if (t.dataset.entryOf) {
    const set = S.sel.get(t.dataset.entryOf) || new Set();
    t.checked ? set.add(t.dataset.entry) : set.delete(t.dataset.entry);
    S.sel.set(t.dataset.entryOf, set);
  }
  renderAll();
}

function onCleanClick(e) {
  const t = e.target.closest('button');
  if (!t) return;
  if (t.dataset.expand) {
    const id = t.dataset.expand;
    S.expanded.has(id) ? S.expanded.delete(id) : S.expanded.add(id);
    renderAll();
  } else if (t.dataset.more) {
    S.showAll.add(t.dataset.more);
    renderAll();
  } else if (t.dataset.reveal) {
    hr.reveal(t.dataset.reveal).catch((err) => toast(err.message));
  } else if (t.dataset.act === 'suggested') {
    for (const it of S.items.values()) if (ready(it)) S.sel.set(it.id, defaults(it));
    renderAll();
  } else if (t.dataset.act === 'none') {
    for (const it of S.items.values()) S.sel.set(it.id, new Set());
    renderAll();
  } else if (t.dataset.act === 'clean') {
    confirmClean();
  }
}

async function confirmClean() {
  const chosen = S.order.map((id) => S.items.get(id)).filter((it) => ready(it) && S.sel.get(it.id)?.size);
  const total = selectedBytes();
  const review = chosen.some((it) => !it.suggested);
  const list = chosen.map((it) => `<li><span>${esc(it.title)}${it.suggested ? '' : '<span class="item__note">Review first</span>'}</span><span>${fmt(selBytesOf(it))}</span></li>`).join('');
  const ok = await confirmModal({
    title: `Clean ${fmt(total)}?`,
    body: `<p>Caches rebuild themselves as you use your apps. Project dependencies and simulator runtimes can be reinstalled when you need them.${review ? ' Items marked review first are gone for good.' : ''}</p>
      <ul class="modal__list">${list}</ul>
      <p>For the best result, quit Xcode, Android Studio and chat apps like Slack first.</p>`,
    ok: `Clean ${fmt(total)}`,
    danger: review,
  });
  if (ok) runClean(chosen);
}

async function runClean(chosen) {
  S.cleaning = new Map(chosen.map((it) => [it.id, { state: 'queued', done: 0, total: S.sel.get(it.id).size }]));
  renderAll();
  let summary = null;
  const selections = chosen.map((it) => ({ id: it.id, entries: [...S.sel.get(it.id)] }));
  await new Promise((resolve) => hr.clean(selections, (event, msg) => {
    const st = S.cleaning.get(msg.id);
    if (event === 'start') Object.assign(st, { state: 'running' });
    else if (event === 'entry') st.done++;
    else if (event === 'item') Object.assign(st || {}, { state: msg.ok ? (msg.skipped ? 'partial' : 'done') : 'error', skipped: msg.skipped, error: msg.error });
    else if (event === 'done') { summary = msg; S.disk = { ...S.disk, ...msg.disk }; }
    else if (event === 'error') toast(msg.error);
    else if (event === 'end') resolve();
    renderAll();
  }));
  if (summary) {
    if (summary.dryRun) toast('Dry run finished. Nothing was deleted.');
    else if (summary.freed > 50e6) toast(`Freed ${fmt(summary.freed)}. You now have ${fmt(summary.disk.free)} free.`);
    else toast('Cleaned. macOS can take a minute to show the freed space.');
  }
  setTimeout(() => { S.cleaning = null; startScan(); }, 2200);
}

// ---------- Scanning ----------

let stopScan = null;

function startScan() {
  stopScan?.();
  S.scanning = true;
  S.measured = 0;
  S.groups = [];
  S.order = [];
  S.items.clear();
  S.sel.clear();
  loadDisk();
  renderAll();
  stopScan = hr.scan(null, (event, d) => {
    if (event === 'start') {
      S.groups = d.groups;
      S.order = d.items.map((it) => it.id);
      d.items.forEach((it) => S.items.set(it.id, { ...it, pending: true, entries: [] }));
      renderAll();
    } else if (event === 'item') {
      S.items.set(d.id, d);
      S.sel.set(d.id, defaults(d));
      S.measured++;
      scheduleRender();
    } else if (event === 'error') {
      toast(`The scan stopped: ${d.error}`);
    } else if (event === 'end') {
      S.scanning = false;
      scheduleRender();
    }
  });
}

/** Re-measures a few items in place, e.g. the Trash after moving something into it. */
function rescanItems(ids) {
  hr.scan(ids, (event, it) => {
    if (event !== 'item' || !S.items.has(it.id)) return;
    S.items.set(it.id, it);
    S.sel.set(it.id, defaults(it));
    scheduleRender();
  });
}

async function loadDisk() {
  try {
    S.disk = await hr.disk();
    $('#dry').hidden = !S.disk.dryRun;
    if (!S.ex.path) S.ex.path = S.disk.home;
    scheduleRender();
  } catch (err) {
    toast(err.message);
  }
}

// ---------- Explore ----------

let stopExplore = null;

function openFolder(p) {
  stopExplore?.();
  S.ex = { path: p, items: [], loading: true, error: null, showSmall: false };
  renderAll();
  stopExplore = hr.explore(p || '', (event, d) => {
    if (event === 'list') {
      S.ex.path = d.path;
      S.ex.items = d.items;
      S.ex.byPath = new Map(d.items.map((x) => [x.path, x]));
    } else if (event === 'size') {
      const x = S.ex.byPath?.get(d.path);
      if (x) x.bytes = d.bytes;
    } else if (event === 'failed' || event === 'error') {
      S.ex.error = d.error;
      S.ex.needsFullDiskAccess = !!d.needsFullDiskAccess;
    } else if (event === 'end') {
      S.ex.loading = false;
    }
    scheduleRender();
  });
}

function crumbsFor(p) {
  const home = S.disk?.home || '';
  const base = p === home || p.startsWith(home + '/') ? { label: 'Home', path: home } : { label: S.disk?.name || 'Macintosh HD', path: '/' };
  const rest = p.slice(base.path.length).split('/').filter(Boolean);
  const out = [base];
  let acc = base.path;
  for (const seg of rest) {
    acc = acc === '/' ? `/${seg}` : `${acc}/${seg}`;
    out.push({ label: seg, path: acc });
  }
  return out;
}

function renderExplore() {
  const panel = $('#panel-explore');
  const ex = S.ex;
  if (!ex.path) { panel.innerHTML = ''; return; }
  const home = S.disk?.home || '';
  const roots = [['Home', home], ['Applications', '/Applications'], ['Library', `${home}/Library`]];
  const crumbs = crumbsFor(ex.path);

  // Folders still being measured stay on top so they don't hide behind tiny files.
  const pending = ex.items.filter((x) => x.bytes == null).sort((a, b) => a.name.localeCompare(b.name));
  const known = ex.items.filter((x) => x.bytes != null).sort((a, b) => b.bytes - a.bytes || a.name.localeCompare(b.name));
  const total = known.reduce((s, x) => s + x.bytes, 0);
  const max = known.length ? known[0].bytes : 0;
  const shownKnown = ex.showSmall ? known : known.filter((x, i) => i < 12 || (i < 60 && x.bytes >= total * 0.002));
  const main = [...pending, ...shownKnown];
  const small = known.length - shownKnown.length;
  const smallBytes = known.slice(shownKnown.length).reduce((s, x) => s + x.bytes, 0);
  const folders = ex.items.filter((x) => x.kind === 'folder' || x.kind === 'package');

  const summary = ex.loading
    ? `Measured ${folders.length - pending.length} of ${plural(folders.length, 'folder')}`
    : ex.error ? '' : `${plural(ex.items.length, 'item')}, ${fmt(total)}`;

  const rows = main.map((x) => {
    const isFolder = x.kind === 'folder';
    const w = max > 10e6 && x.bytes != null ? Math.max(0.5, (x.bytes / max) * 100) : 0;
    const big = total && x.bytes >= total * 0.1;
    const nameInner = `${icon[x.kind] || icon.file}<span>${esc(x.name)}</span>`;
    return `<li class="file ${isFolder ? 'file--folder' : ''} ${big ? 'file--big' : ''}">
      ${isFolder
        ? `<button class="file__name" type="button" data-open="${esc(x.path)}" data-key="o-${esc(x.path)}">${nameInner}</button>`
        : `<div class="file__name">${nameInner}</div>`}
      <div class="bar"><div class="bar__fill" style="width:${w}%"></div></div>
      <span class="size">${x.bytes == null ? '<span class="measuring" role="img" aria-label="Measuring"></span>' : fmt(x.bytes)}</span>
      <div class="file__actions">
        <button class="btn btn--ghost btn--small" type="button" data-reveal="${esc(x.path)}">Show in Finder</button>
        <button class="btn btn--ghost btn--small btn--danger" type="button" data-trash="${esc(x.path)}">Move to Trash</button>
      </div>
    </li>`;
  }).join('');

  panel.innerHTML = `
    <div class="explore__bar">
      <div class="roots" role="group" aria-label="Start from">
        ${roots.map(([label, p]) => `<button class="root" type="button" data-open="${esc(p)}" aria-pressed="${ex.path === p}">${label}</button>`).join('')}
      </div>
      <nav class="crumbs" aria-label="Folder path">
        ${crumbs.map((c, i) => (i ? '<span class="crumbs__sep">/</span>' : '') +
          `<button class="crumb" type="button" data-open="${esc(c.path)}" ${i === crumbs.length - 1 ? 'aria-current="true"' : ''}>${esc(c.label)}</button>`).join('')}
      </nav>
      <span class="explore__summary">${summary}</span>
    </div>
    ${ex.error ? `<p class="notice">${esc(ex.error)}${ex.needsFullDiskAccess ? ` Give Headroom Full Disk Access to look inside. <button class="link" type="button" data-fda>Open Settings</button>` : ''}</p>` : ''}
    ${!ex.error && !ex.loading && !ex.items.length ? '<p class="notice">This folder is empty.</p>' : ''}
    <ul class="files">${rows}</ul>
    ${small > 0 ? `<div class="files__more"><button class="link" type="button" data-small>Show ${plural(small, 'smaller item')} (${fmt(smallBytes)})</button></div>` : ''}
    ${!ex.error && ex.items.length ? '<p class="footnote">Moving something to the Trash frees its space once you empty the Trash. You can do that from Clean up.</p>' : ''}`;
}

async function onExploreClick(e) {
  const t = e.target.closest('button');
  if (!t) return;
  if (t.dataset.open) openFolder(t.dataset.open);
  else if (t.hasAttribute('data-small')) { S.ex.showSmall = true; renderAll(); }
  else if (t.dataset.reveal) hr.reveal(t.dataset.reveal).catch((err) => toast(err.message));
  else if (t.dataset.trash) trashItem(t.dataset.trash);
}

async function trashItem(p) {
  const x = S.ex.byPath?.get(p);
  const name = x?.name || p.split('/').pop();
  try {
    const check = await hr.checkTrash(p);
    if (!check.ok) return toast(`Headroom leaves “${name}” alone. It’s a system or protected folder.`);
    const ok = await confirmModal({
      title: `Move “${name}” to the Trash?`,
      body: `<p>${x?.bytes != null ? `It takes up ${fmt(x.bytes)}. ` : ''}You get the space back when you empty the Trash.</p>`,
      ok: 'Move to Trash',
      danger: true,
    });
    if (!ok) return;
    const r = await hr.trash(p);
    if (!r.dryRun) {
      S.ex.items = S.ex.items.filter((i) => i.path !== p);
      S.ex.byPath.delete(p);
    }
    toast(r.dryRun ? `Dry run: “${name}” stays where it is.` : `Moved “${name}” to the Trash.`);
    renderAll();
    rescanItems(['trash']);
  } catch (err) {
    toast(err.message);
  }
}

// ---------- Simulators ----------

async function loadSims() {
  try {
    S.sims = await hr.sims();
  } catch (err) {
    S.sims = { error: err.message };
  }
  renderAll();
}

function simButtons(op, id, label, disabled) {
  const busy = S.simBusy === `${op}:${id}`;
  const text = { erase: busy ? 'Erasing…' : 'Erase', delete: busy ? 'Deleting…' : 'Delete', deleteRuntime: busy ? 'Deleting…' : 'Delete' }[op];
  return `<button class="btn btn--ghost btn--small ${op === 'erase' ? '' : 'btn--danger'}" type="button" data-sim="${op}" data-id="${esc(id)}" data-label="${esc(label)}" ${disabled || S.simBusy ? 'disabled' : ''}>${text}</button>`;
}

function renderSims() {
  const panel = $('#panel-sims');
  const s = S.sims;
  if (!s) { panel.innerHTML = '<p class="notice">Loading simulators…</p>'; return; }
  if (s.error) { panel.innerHTML = `<p class="notice">${esc(s.error)}</p>`; return; }
  if (!s.available) { panel.innerHTML = '<p class="notice">Xcode isn’t installed, so there are no simulators to manage.</p>'; return; }

  const runtimes = [...s.runtimes].sort((a, b) => b.bytes - a.bytes);
  const runtimeRows = runtimes.map((rt) => {
    const label = `${rt.platform} ${rt.version}`;
    const meta = rt.deviceCount
      ? `${plural(rt.deviceCount, 'simulator')}, ${ago(rt.lastUsedAt).toLowerCase()}`
      : 'No simulators use it';
    return `<div class="sim">
      <div><div class="sim__name">${esc(label)}${rt.newest ? '' : ''}</div><div class="sim__meta">Build ${esc(rt.build)}${rt.newest ? ', newest installed' : ''}</div></div>
      <span class="sim__meta">${rt.running ? '<span class="sim__running">In use</span>' : esc(meta)}</span>
      <span class="size">${fmt(rt.bytes)}</span>
      <div class="sim__actions">${simButtons('deleteRuntime', rt.id, label, rt.running || !rt.deletable)}</div>
    </div>`;
  }).join('');

  const byRuntime = new Map();
  for (const d of s.devices) {
    if (!byRuntime.has(d.runtime)) byRuntime.set(d.runtime, []);
    byRuntime.get(d.runtime).push(d);
  }
  const runtimeOrder = [...byRuntime.keys()].sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  const deviceRows = runtimeOrder.map((rt) => {
    const list = byRuntime.get(rt).sort((a, b) => b.bytes - a.bytes);
    return `<div class="sims__runtime-head">${esc(rt)}</div>` + list.map((d) => `<div class="sim">
      <div class="sim__name">${esc(d.name)}${d.available ? '' : ' <span class="item__note">Broken</span>'}</div>
      <span class="sim__meta">${d.state === 'Booted' ? '<span class="sim__running">Running</span>' : esc(ago(d.lastUsedAt))}</span>
      <span class="size">${fmt(d.bytes)}</span>
      <div class="sim__actions">${d.state === 'Booted' ? '' : simButtons('erase', d.udid, d.name, !d.available) + simButtons('delete', d.udid, d.name)}</div>
    </div>`).join('');
  }).join('');

  const total = s.runtimes.reduce((a, r) => a + r.bytes, 0) + s.devices.reduce((a, d) => a + d.bytes, 0);
  panel.innerHTML = `
    <div class="sims__section">
      <h2>Runtimes</h2>
      <p class="sims__intro">Each iOS version you install for simulators takes several gigabytes. Deleting one also removes the simulators that run it. You can download it again from Xcode settings.</p>
      ${runtimeRows || '<p class="notice">No simulator runtimes installed.</p>'}
    </div>
    <div class="sims__section">
      <h2>Simulators</h2>
      <p class="sims__intro">Erase resets a simulator: apps and data go, the simulator stays. Delete removes it from Xcode entirely.</p>
      ${deviceRows || '<p class="notice">No simulators.</p>'}
    </div>
    <p class="footnote">Simulators and runtimes use ${fmt(total)} in total.</p>`;
}

const SIM_COPY = {
  erase: (l) => [`Erase ${l}?`, 'Its apps and data are removed. The simulator stays in Xcode.', 'Erase', 'Erased'],
  delete: (l) => [`Delete ${l}?`, 'The simulator and everything in it are removed from Xcode.', 'Delete', 'Deleted'],
  deleteRuntime: (l) => [`Delete ${l}?`, 'Simulators that run it are removed too. You can download it again from Xcode settings.', 'Delete', 'Deleted'],
};

async function onSimsClick(e) {
  const t = e.target.closest('button[data-sim]');
  if (!t) return;
  const { sim: op, id, label } = t.dataset;
  const [title, body, verb, done] = SIM_COPY[op](label);
  if (!(await confirmModal({ title, body: `<p>${body}</p>`, ok: verb, danger: op !== 'erase' }))) return;
  S.simBusy = `${op}:${id}`;
  renderAll();
  try {
    const r = await hr.sim(op, id);
    toast(r.dryRun ? `Dry run: ${label} is unchanged.` : `${done} ${label}.`);
  } catch (err) {
    toast(err.message);
  }
  S.simBusy = null;
  await loadSims();
  loadDisk();
  rescanItems(['idle-sims', 'old-runtimes', 'unavailable-sims']);
}

// ---------- Modal and toast ----------

function confirmModal({ title, body, ok, danger = false }) {
  const m = $('#modal');
  $('#modal-title').textContent = title;
  $('#modal-body').innerHTML = body;
  const btn = $('#modal-ok');
  btn.textContent = ok;
  btn.classList.toggle('btn--danger', danger);
  m.returnValue = '';
  m.showModal();
  btn.focus();
  return new Promise((resolve) => m.addEventListener('close', () => resolve(m.returnValue === 'ok'), { once: true }));
}

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 6500);
}

// ---------- Wiring ----------

function setTab(tab) {
  S.tab = tab;
  $$('.tab').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
  $('#panel-clean').hidden = tab !== 'clean';
  $('#panel-explore').hidden = tab !== 'explore';
  $('#panel-sims').hidden = tab !== 'sims';
  if (tab === 'explore' && !S.ex.items.length && !S.ex.loading) openFolder(S.ex.path || S.disk?.home);
  if (tab === 'sims' && !S.sims) loadSims();
  renderAll();
}

$$('.tab').forEach((b) => b.addEventListener('click', () => setTab(b.dataset.tab)));
$('#panel-clean').addEventListener('change', onCleanChange);
$('#panel-clean').addEventListener('click', onCleanClick);
$('#panel-explore').addEventListener('click', onExploreClick);
$('#panel-sims').addEventListener('click', onSimsClick);
document.addEventListener('click', (e) => {
  if (e.target.closest('button[data-fda]')) hr.openFullDiskAccess().catch((err) => toast(err.message));
});

function rescan() {
  if (S.cleaning) return;
  startScan();
  if (S.tab === 'explore') openFolder(S.ex.path);
  if (S.tab === 'sims') { S.sims = null; loadSims(); }
}
$('#rescan').addEventListener('click', rescan);

hr.onMenu((cmd) => {
  if (cmd === 'rescan') rescan();
  else if (cmd.startsWith('tab:')) setTab(cmd.slice(4));
});

startScan();
