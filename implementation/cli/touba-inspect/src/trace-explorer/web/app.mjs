import { label, categories, shortRef, observedInterval, graphLayout } from './view.mjs';
const $ = id => document.getElementById(id), ns = 'http://www.w3.org/2000/svg';
const element = (tag, text, cls) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (cls) node.className = cls; return node; };
function svgNode(tag, attributes = {}, text) { const node = document.createElementNS(ns, tag); for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value)); if (text !== undefined) node.textContent = text; return node; }
const uiIcons = {
  timeline:'M4 6h3 M4 12h3 M4 18h3 M5.5 4v16 M10 6h10 M10 12h7 M10 18h9', flow:'M5 3h6v5H5z M13 16h6v5h-6z M8 8v4h8v4', table:'M4 5h16v14H4z M4 10h16 M4 15h16 M10 10v9',
  lock:'M6 11h12v9H6z M9 11V8a3 3 0 0 1 6 0v3', moon:'M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z', sun:'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z M12 2v2 M12 20v2 M4.9 4.9l1.4 1.4 M17.7 17.7l1.4 1.4 M2 12h2 M20 12h2 M4.9 19.1l1.4-1.4 M17.7 6.3l1.4-1.4',
  globe:'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z M3 12h18 M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9s1.3-6.4 3.8-9z', caret:'m8 10 4 4 4-4',
  search:'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14z M20 20l-4-4', filter:'M4 5h16l-6 7v6l-4 2v-8z', reset:'M4 12a8 8 0 1 0 2.4-5.7 M4 4v5h5', refresh:'M20 12a8 8 0 1 1-2.4-5.7 M20 4v5h-5',
  collapseLeft:'M11 17l-5-5 5-5 M18 17l-5-5 5-5', collapseRight:'M13 17l5-5-5-5 M6 17l5-5-5-5', panelLeft:'M4 4h16v16H4z M9 4v16', panelRight:'M4 4h16v16H4z M15 4v16',
  expand:'M4 9V4h5 M20 9V4h-5 M4 15v5h5 M20 15v5h-5', collapse:'M9 4v5H4 M15 4v5h5 M9 20v-5H4 M15 20v-5h5', minus:'M5 12h14', plus:'M5 12h14 M12 5v14',
  fit:'M4 8V4h4 M16 4h4v4 M20 16v4h-4 M8 20H4v-4 M9 9h6v6H9z', download:'M12 4v11 M7 10l5 5 5-5 M5 20h14', code:'M8 8l-4 4 4 4 M16 8l4 4-4 4 M14 4l-4 16',
  close:'M6 6l12 12 M18 6 6 18', sliders:'M4 6h9 M17 6h3 M4 12h3 M11 12h9 M4 18h11 M19 18h1 M15 4v4 M9 10v4 M17 16v4', arrowRight:'M5 12h14 M13 6l6 6-6 6', chevronLeft:'m15 6-6 6 6 6', chevronRight:'m9 6 6 6-6 6',
  strategy:'M4 4h6v5H4z M14 15h6v5h-6z M4 15h6v5H4z M7 9v3h10v3 M7 12v3',
  copy:'M9 9h11v11H9z M5 15H4V4h11v1', check:'m5 12 5 5 9-10', chevronUp:'m6 15 6-6 6 6', chevronDown:'m6 9 6 6 6-6', pointer:'M6 3l13 7-5.5 1.5L11 17z M14 13l5 5',
};
const categoryIcons = {
  agent:'M5 9h14v12H5z M9 14h.1 M15 14h.1 M9 18h6 M12 3v6 M9 3h6', call:'M3 12h17 M14 5l7 7-7 7', flow:uiIcons.flow,
  memory:'M3 6c0-5 18-5 18 0s-18 5-18 0v12c0 5 18 5 18 0V6 M3 12c0 5 18 5 18 0', human:'m4 12 5 5 11-12 M21 12v8H3V4h10',
  budget:'M4 17a8 8 0 1 1 16 0 M12 17l4-6 M4 21h16', effect:'m13 2-9 12h7l-1 8 10-13h-7z',
  refusal:'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z M5.7 5.7l12.6 12.6', error:'M12 3 2 20h20z M12 10v4 M12 17h.01',
};
function icon(name, cls, target = svgNode('svg', { class:cls, 'aria-hidden':'true' })) {
  target.setAttribute('viewBox', '0 0 24 24'); target.replaceChildren(svgNode('path', { d:uiIcons[name] ?? categoryIcons[name] ?? categoryIcons.flow })); return target;
}
function button(text, action, iconName) { const node = element('button'); node.type = 'button'; if (iconName) node.append(icon(iconName, 'ui-icon')); node.append(element('span', text)); node.addEventListener('click', action); return node; }
const embeddedHost = window.toubaTraceHost ?? null;
const vscode = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : embeddedHost;
const stored = vscode?.getState() ?? {};
const prefKey = 'touba-trace-explorer-preferences';
// Keep the fragment for browser reloads. Fragments are never sent in HTTP URLs;
// the local server also sends Referrer-Policy: no-referrer.
const token = location.hash.slice(1);
const pending = new Map(); let requestId = 0;
if (vscode) addEventListener('message', event => {
  if (embeddedHost && (event.source !== parent || event.origin !== location.origin)) return;
  const data = event.data;
  if (embeddedHost && data?.type === 'preferences') {
    if (['en','fr'].includes(data.lang)) { language = data.lang; translate(); }
    if (['light','dark'].includes(data.theme)) applyTheme(data.theme);
    return;
  }
  const item = pending.get(data?.id); if (!item) return;
  pending.delete(data.id); clearTimeout(item.timer);
  data.error ? item.reject(new Error(data.error)) : item.resolve(data.result);
});
async function rpc(method, args = {}) {
  if (vscode) return new Promise((resolve, reject) => {
    const id = ++requestId, timer = setTimeout(() => { pending.delete(id); reject(new Error('TraceRequestTimeout')); }, 125000);
    pending.set(id, { resolve, reject, timer }); vscode.postMessage({ id, method, args });
  });
  const response = await fetch(`/api/${method}?q=${encodeURIComponent(JSON.stringify(args))}`, { headers: { Authorization: `Bearer ${token}` }, credentials: 'omit', cache: 'no-store' });
  if (!response.ok) { const error = await response.json().catch(() => ({})); throw new Error(error.error ?? `HTTP ${response.status}`); }
  return response.json();
}
let language = ['en', 'fr'].includes(stored.language) ? stored.language : (navigator.language ?? '').startsWith('fr') ? 'fr' : 'en';
let prefs = loadPrefs();
let view = 'timeline', runs = [], cursor = null, selected = null, state = null, page = null, query = {}, offset = 0, revision = 0, busy = false;
let detailResult = null, status = { kind:'loading', key:'loading', detail:'' }, graph = null, box = null, autoFit = true, cancelTimer, searchTimer;
const t = key => label(key, language);
const shortName = ref => shortRef(ref).split('/').at(-1);
const essential = () => prefs.level === 'essential';
const clip = (text, max) => text.length > max ? `${text.slice(0, max - 1)}…` : text;
function loadPrefs() {
  const base = { runs:true, detail:true, level:'complete', theme:null };
  let saved = stored.prefs;
  if (!saved && !vscode) { try { saved = JSON.parse(localStorage.getItem(prefKey) ?? 'null'); } catch { saved = null; } }
  for (const [key, value] of Object.entries(saved && typeof saved === 'object' ? saved : {})) {
    if (key === 'theme' ? ['light', 'dark', null].includes(value) : key === 'level' ? ['complete', 'essential'].includes(value) : typeof base[key] === 'boolean' && typeof value === 'boolean') base[key] = value;
  }
  return base;
}
function savePrefs() {
  if (vscode) vscode.setState({ language, prefs });
  else { try { localStorage.setItem(prefKey, JSON.stringify(prefs)); } catch { /* storage may be unavailable */ } }
}
function labelNode(node) {
  const text = t(node.dataset.label);
  node.setAttribute('aria-label', text.replace(/\s{2}.*$/u, '')); if (node.tagName === 'BUTTON') node.title = text;
}
function renderStatus() {
  const node = $('status'), text = status.detail ? `${t(status.key)}${language === 'fr' ? ' : ' : ': '}${status.detail}` : t(status.key);
  node.dataset.status = status.kind; node.textContent = text; node.title = text;
}
function setStatus(kind, key, detail = '') { status = { kind, key, detail }; renderStatus(); }
function notify(key) { setStatus('ready', key); }
function fail(error) { setStatus('error', 'errorPrefix', String(error.message).slice(0, 500)); }
function showReady() {
  if (!state) setStatus(runs.length ? 'ready' : 'idle', runs.length ? 'ready' : 'noRuns');
  else setStatus(state.closed ? 'ready' : 'stale', state.closed ? 'ready' : 'frozen');
}
function time(value) { return value ? new Date(value).toLocaleString(language, { hour12: false }) : t('noTime'); }
function clock(value) {
  const date = new Date(value);
  const precision = essential() ? {} : { fractionalSecondDigits:3 };
  return value && Number.isFinite(date.getTime()) ? date.toLocaleTimeString(language, { hour12:false, hour:'2-digit', minute:'2-digit', second:'2-digit', ...precision }) : '—';
}
function translate() {
  document.documentElement.lang = language; $('language').value = language;
  for (const node of document.querySelectorAll('[data-text]')) node.textContent = t(node.dataset.text);
  for (const node of document.querySelectorAll('[data-label]')) labelNode(node);
  for (const node of document.querySelectorAll('[data-placeholder]')) node.placeholder = t(node.dataset.placeholder);
  $('graph-legend').title = t('graphNote');
  const category = $('category').value;
  $('category').replaceChildren(...['', ...categories].map(key => { const option = element('option', t(key || 'all')); option.value = key; return option; }));
  $('category').value = category;
  applyPanels(); applyTheme(document.documentElement.dataset.theme); renderStatus();
  renderRuns(); if (state) renderState(); if (page) renderPage(); renderDetail(detailResult);
}
function setBusy(value) {
  busy = value; $('events').setAttribute('aria-busy', String(value));
  $('export').disabled = value || !state; $('refresh').disabled = value;
  for (const item of $('runs').querySelectorAll('button')) item.disabled = value;
  clearTimeout(cancelTimer);
  // Short reads finish before the cancel action would only flicker into view.
  if (value) { setStatus('loading', 'loading'); cancelTimer = setTimeout(() => { $('cancel').hidden = false; }, 600); }
  else $('cancel').hidden = true;
}
function clearSelection() {
  state = null; page = null; selected = null; detailResult = null; graph = null;
  $('events').replaceChildren(); renderDetail(null);
  $('stats').replaceChildren(); $('title').textContent = t('choose'); $('title').removeAttribute('title'); $('coverage').textContent = '';
  $('run-status').hidden = true; $('run-name').textContent = 'Traces';
  $('result-count').textContent = ''; $('page').textContent = ''; $('previous').closest('.pagination').hidden = true;
  $('graph-controls').hidden = true; $('graph-legend').hidden = true;
  $('previous').disabled = true; $('next').disabled = true; $('export').disabled = true;
}
async function list(append = false) {
  const generation = ++revision; setBusy(true);
  try {
    const runId = $('run-filter').value.trim();
    const result = await rpc('list', { after: append ? cursor : '', ...(runId ? { runId } : {}) });
    if (generation !== revision) return;
    runs = append ? [...runs, ...result.segments] : result.segments; cursor = result.next; renderRuns();
    if (!append && runs.length) await select(runs.find(run => run.id === state?.id)?.id ?? runs[0].id);
    else { if (!runs.length) clearSelection(); showReady(); }
  } catch (error) { if (generation === revision) fail(error); }
  finally { if (generation === revision) setBusy(false); }
}
function renderRuns() {
  $('runs').replaceChildren(...runs.map(run => {
    const li = element('li'), item = element('button', undefined, 'run'); item.type = 'button';
    item.disabled = busy;
    item.dataset.category = 'flow'; item.setAttribute('aria-current', String(state?.id === run.id));
    const meta = element('small'), count = `${run.eventCount} ${t('count').toLowerCase()}`;
    if (essential()) meta.append(count); else meta.append(element('span', run.runId, 'mono'), ` · ${count}`);
    item.append(icon('strategy', 'icon-small'), element('strong', shortName(run.entry || run.module || run.runId)), meta);
    if (!run.closed) item.append(element('span', t('openFlag'), 'open-flag'));
    item.title = `${shortRef(run.entry || run.module || run.runId)}\n${run.runId}\n${run.eventCount} ${t('count').toLowerCase()} · #${run.start} · ${t(run.closed ? 'complete' : 'incomplete')}`;
    item.addEventListener('click', () => { if (!busy) void select(run.id); }); li.append(item); return li;
  }));
  $('more').hidden = !cursor;
  $('run-count').textContent = runs.length ? `${runs.length}${cursor ? '+' : ''} ${t(runs.length === 1 && !cursor ? 'runsCountOne' : 'runsCount')}` : '';
}
async function select(id) {
  const generation = ++revision; setBusy(true); selected = null; detailResult = null;
  try {
    const result = await rpc('select', { id }); if (generation !== revision) return;
    state = result; offset = 0; renderDetail(null); renderState(); renderRuns(); await load();
  } catch (error) { if (generation === revision) { clearSelection(); fail(error); } }
  finally { if (generation === revision) setBusy(false); }
}
function renderState() {
  const run = state.header.run, ref = run.entry_ref || run.module_ref || run.run_id;
  $('title').textContent = shortName(ref); $('title').title = shortRef(ref);
  $('run-name').textContent = `Traces · ${shortRef(run.module_ref) || run.run_id}`;
  const outcome = state.status === 'stopped' && /pending/u.test(state.reason ?? '') ? 'paused' : state.status;
  Object.assign($('run-status'), { hidden:false, textContent:t(`status_${outcome}`) }); $('run-status').dataset.state = outcome;
  $('coverage').textContent = `${run.run_id} · ${t('segment')} ${state.start}–${state.end} · ${t(state.closed ? 'complete' : 'incomplete')}`;
  $('coverage').title = `${state.id}\n${state.digest}\n${state.frozenAt}`;
  const items = [['count', state.total], ['refusal', state.counts.refusal ?? 0, true], ['error', state.counts.error ?? 0, true], ['duration', observedInterval(state) ?? '—']];
  $('stats').replaceChildren(...items.map(([name, value, alert]) => {
    const stat = element('div', undefined, 'stat'); stat.append(element('small', t(name)), element('strong', String(value)));
    if (alert && value > 0) stat.dataset.alert = 'true'; return stat;
  }));
}
function collectQuery() {
  const result = { search: $('search').value.trim(), category: $('category').value, level: $('level').querySelector('[aria-pressed=true]').dataset.value };
  for (const input of $('filters').querySelectorAll('input[name]')) if (input.value) result[input.name] = ['start', 'end'].includes(input.name) ? Number(input.value) : ['from','to'].includes(input.name) ? new Date(input.value).toISOString() : input.value.trim();
  return result;
}
function filterCount() {
  const active = [...$('filters').querySelectorAll('input[name]')].filter(input => input.value).length;
  $('filter-count').hidden = !active; $('filter-count').textContent = String(active);
}
function applyFilters() { try { query = collectQuery(); offset = 0; filterCount(); void load(); } catch (error) { fail(error); } }
async function load() {
  if (!state) return;
  const generation = ++revision; setBusy(true);
  try {
    const result = await rpc(view === 'graph' ? 'graph' : 'query', { ...query, offset, limit: 100 });
    if (generation !== revision) return; page = result; box = null; autoFit = true; renderPage(); showReady();
    vscode?.postMessage({ method: 'rendered', count: page.events.length, total: page.total });
  } catch (error) { if (generation === revision) fail(error); }
  finally { if (generation === revision) setBusy(false); }
}
function renderPage() {
  const pages = Math.max(1, Math.ceil(page.total / page.limit));
  $('result-count').textContent = `${page.total} ${t(page.total === 1 ? 'matchedOne' : 'matched')}`;
  $('page').textContent = `${Math.floor(page.offset / page.limit) + 1} / ${pages}`; $('previous').closest('.pagination').hidden = pages < 2;
  $('previous').disabled = page.offset === 0; $('next').disabled = page.offset + page.limit >= page.total;
  $('events').dataset.mode = view; $('events').replaceChildren(); graph = null;
  $('graph-controls').hidden = $('graph-legend').hidden = view !== 'graph' || !page.events.length;
  if (!page.events.length) { $('events').append(element('p', t('empty'), 'empty')); return; }
  if (view === 'table') renderTable(); else if (view === 'graph') renderGraph(); else renderTimeline();
}
function eventButton(event) {
  const item = element('button', undefined, 'event'); item.type = 'button'; item.dataset.sequence = event.sequence; item.dataset.category = event.category;
  item.setAttribute('aria-pressed', String(selected === event.sequence));
  const body = element('span', undefined, 'body'); body.append(element('strong', t(event.kind)), element('small', shortName(event.resource) || t(event.category)));
  const when = element('time', clock(event.time)); if (event.time) when.dateTime = event.time;
  item.append(element('span', `#${event.sequence}`, 'sequence'), element('span', undefined, 'marker'), body, when);
  item.title = `${t(event.kind)} · ${t(event.category)}\n${time(event.time)}\n${event.id}`; item.addEventListener('click', () => void inspect(event.sequence)); return item;
}
function renderTimeline() {
  // Contiguous groups retain global event order, including interleaved branches.
  let events, count, groupKey;
  for (const event of page.events) {
    const key = [event.invocation || event.span, event.branch].join('/');
    if (groupKey !== key) {
      groupKey = key;
      const group = element('details', undefined, 'lane'), summary = element('summary'); group.open = true;
      summary.title = event.invocation || event.span || ''; summary.dataset.category = event.agent ? 'agent' : 'flow';
      summary.append(icon(summary.dataset.category, 'icon-small'), element('span', shortName(event.agent || event.scope) || t('noCorrelation'), 'lane-name'));
      if (event.branch) summary.append(element('span', event.branch, 'chip'));
      count = element('span', undefined, 'count-pill'); summary.append(count);
      events = element('ol', undefined, 'lane-events'); group.append(summary, events); $('events').append(group);
    }
    const li = element('li'); li.append(eventButton(event)); events.append(li); count.textContent = String(events.children.length);
  }
}
function renderTable() {
  const table = element('table', undefined, 'trace-table'), head = element('tr'), body = element('tbody');
  for (const name of ['sequence','kind','agent','resource','date']) { const th = element('th', t(name)); th.scope = 'col'; head.append(th); }
  const thead = element('thead'); thead.append(head); table.append(thead, body);
  for (const event of page.events) {
    const row = element('tr'); row.dataset.sequence = event.sequence; row.dataset.category = event.category; row.classList.toggle('selected', selected === event.sequence);
    const action = element('td'), kind = button(t(event.kind), () => void inspect(event.sequence)); kind.prepend(element('span', undefined, 'marker')); action.append(kind);
    const cell = (value, title, cls) => { const td = element('td', value || '—', cls); if (title) td.title = title; return td; };
    row.append(cell(`#${event.sequence}`, '', 'mono'), action, cell(shortName(event.agent), shortRef(event.agent)), cell(shortName(event.resource), shortRef(event.resource)), cell(clock(event.time), time(event.time), 'mono'));
    body.append(row);
  }
  $('events').append(table);
}
const NODE = { width:232, height:64, tile:36, pad:12, rowGap:40, lineGap:24, rankGap:64 };
// graphLayout ranks nodes by explicit edges. Ranks flow downward as in the project graph,
// and a long rank wraps so the drawing roughly matches the canvas shape.
function placeNodes(nodes) {
  const { width:W, height:H, rowGap, lineGap, rankGap } = NODE, ranks = new Map();
  for (const node of nodes) { const rank = Math.round((node.x - 32) / 280); if (!ranks.has(rank)) ranks.set(rank, []); ranks.get(rank).push(node); }
  const rect = $('events').getBoundingClientRect(), ratio = rect.width && rect.height ? rect.width / rect.height : 1.4;
  const widest = Math.max(...[...ranks.values()].map(rank => rank.length));
  const wrap = Math.min(8, Math.max(3, Math.round(Math.sqrt(ratio * widest * (H + rankGap) / (W + rowGap)))));
  const span = Math.min(wrap, widest) * (W + rowGap) - rowGap, placed = [];
  let y = 32;
  for (const rank of [...ranks.keys()].sort((a, b) => a - b)) {
    const members = ranks.get(rank);
    members.forEach((node, index) => {
      const line = Math.floor(index / wrap), count = Math.min(wrap, members.length - line * wrap), width = count * (W + rowGap) - rowGap;
      placed.push({ ...node, x:32 + (span - width) / 2 + (index % wrap) * (W + rowGap), y:y + line * (H + lineGap) });
    });
    y += Math.ceil(members.length / wrap) * (H + lineGap) - lineGap + rankGap;
  }
  return placed;
}
function renderGraph() {
  const { width:W, height:H, tile, pad } = NODE, nodes = placeNodes(graphLayout(page.nodes ?? [], page.edges ?? [])), byId = new Map(nodes.map(node => [node.id, node]));
  graph = { width:Math.max(...nodes.map(n => n.x + W)) + 32, height:Math.max(...nodes.map(n => n.y + H)) + 32 };
  const root = svgNode('svg', { id:'graph', role:'group', 'aria-label':t('graph') }), defs = svgNode('defs');
  const marker = svgNode('marker', { id:'arrow', viewBox:'0 0 10 10', refX:9, refY:5, markerWidth:7, markerHeight:7, orient:'auto-start-reverse' });
  marker.append(svgNode('path', { d:'M0 0 10 5 0 10z', class:'arrow' })); defs.append(marker);
  const edges = svgNode('g'), cards = svgNode('g'); root.append(defs, edges, cards);
  for (const edge of page.edges ?? []) {
    const a = byId.get(edge.from), b = byId.get(edge.to); if (!a || !b) continue;
    const p0 = [a.x + W / 2, a.y + H], p3 = [b.x + W / 2, b.y], bend = p3[1] > p0[1] ? (p3[1] - p0[1]) / 2 : 70;
    edges.append(svgNode('path', { class:'graph-edge', d:`M${p0} C${p0[0]},${p0[1] + bend} ${p3[0]},${p3[1] - bend} ${p3}`, 'marker-end':'url(#arrow)' }));
  }
  const maxChars = Math.floor((W - pad - tile - 22) / 7.4);
  for (const node of nodes) {
    const name = node.label.includes(':') ? shortName(node.label) : t(node.label);
    const category = node.type === 'call' ? 'call' : node.label.startsWith('agent:') ? 'agent' : node.category;
    const subtitle = `${t(node.type === 'invocation' ? 'group' : node.category)}${essential() ? '' : ` · #${node.sequence}`}`;
    const g = svgNode('g', { class:`graph-node${node.outside ? ' outside' : ''}${node.sequence === selected ? ' selected' : ''}`, transform:`translate(${node.x} ${node.y})`, tabindex:0, role:'button', 'aria-label':`${name}, #${node.sequence}`, 'data-category':category, 'data-sequence':node.sequence });
    const tileY = (H - tile) / 2, mark = svgNode('g', { class:'icon', transform:`translate(${pad + 6} ${tileY + 6})` });
    mark.append(svgNode('path', { d:categoryIcons[category] ?? categoryIcons.flow }));
    g.append(svgNode('rect', { class:'card', width:W, height:H, rx:8 }), svgNode('title', {}, node.label), svgNode('rect', { class:'tile', x:pad, y:tileY, width:tile, height:tile, rx:8 }), mark,
      svgNode('text', { x:pad + tile + 12, y:H / 2 - 3, class:'title' }, clip(name, maxChars)), svgNode('text', { x:pad + tile + 12, y:H / 2 + 15, class:'kind' }, clip(subtitle, maxChars + 8)));
    const activate = () => void inspect(node.sequence); g.addEventListener('click', activate);
    g.addEventListener('keydown', e => { if (['Enter',' '].includes(e.key)) { e.preventDefault(); activate(); } }); cards.append(g);
  }
  let drag;
  root.addEventListener('pointerdown', e => { if (e.target.closest('.graph-node') || !box) return; drag = { x:e.clientX, y:e.clientY, box:{ ...box } }; root.setPointerCapture(e.pointerId); });
  root.addEventListener('pointermove', e => { if (!drag) return; const r = root.getBoundingClientRect(); box = { ...drag.box, x:drag.box.x - (e.clientX - drag.x) * drag.box.w / r.width, y:drag.box.y - (e.clientY - drag.y) * drag.box.h / r.height }; autoFit = false; applyBox(); });
  root.addEventListener('pointerup', () => { drag = null; }); root.addEventListener('pointercancel', () => { drag = null; });
  root.addEventListener('dblclick', e => { if (!e.target.closest('.graph-node')) fitGraph(); });
  root.addEventListener('wheel', e => { e.preventDefault(); if (box) zoomGraph(e.deltaY > 0 ? 1.1 : .9, graphPoint(e)); }, { passive:false });
  $('events').append(root);
  if (box && !autoFit) applyBox(); else fitGraph();
}
function applyBox() { if (box) $('graph')?.setAttribute('viewBox', `${box.x} ${box.y} ${box.w} ${box.h}`); }
function fitGraph() {
  const rect = $('graph')?.getBoundingClientRect(); if (!graph || !rect?.width || !rect.height) return;
  const ratio = rect.width / rect.height, margin = 24;
  // Never enlarge beyond 1:1, otherwise a single invocation fills the whole canvas.
  const width = Math.max(graph.width + margin * 2, (graph.height + margin * 2) * ratio, rect.width), height = width / ratio;
  box = { x:(graph.width - width) / 2, y:(graph.height - height) / 2, w:width, h:height }; autoFit = true; applyBox();
}
function zoomGraph(factor, anchor) {
  if (!box) return;
  const w = Math.min(30000, Math.max(160, box.w * factor)), h = box.h * w / box.w;
  const ax = anchor?.x ?? box.x + box.w / 2, ay = anchor?.y ?? box.y + box.h / 2;
  box = { x:ax - (ax - box.x) * w / box.w, y:ay - (ay - box.y) * h / box.h, w, h }; autoFit = false; applyBox();
}
function graphPoint(event) { const r = $('graph').getBoundingClientRect(); return { x:box.x + (event.clientX - r.left) * box.w / r.width, y:box.y + (event.clientY - r.top) * box.h / r.height }; }
function markSelection() {
  for (const node of $('events').querySelectorAll('[data-sequence]')) {
    const on = Number(node.dataset.sequence) === selected;
    if (node.classList.contains('event')) node.setAttribute('aria-pressed', String(on)); else node.classList.toggle('selected', on);
  }
  $('events').querySelector('.event[aria-pressed=true], tr.selected')?.scrollIntoView({ block:'nearest' });
}
async function inspect(sequence) {
  const generation = revision; selected = sequence; markSelection();
  try { const result = await rpc('detail', { sequence }); if (generation !== revision || selected !== sequence) return; detailResult = result; renderDetail(result); }
  catch (error) { fail(error); }
}
function clearEventSelection() { if (selected === null) return; selected = null; detailResult = null; markSelection(); renderDetail(null); }
function step(delta) {
  if (!page?.events.length) return;
  const index = page.events.findIndex(item => item.sequence === selected);
  const next = page.events[Math.max(0, Math.min(page.events.length - 1, index < 0 ? 0 : index + delta))];
  if (next.sequence !== selected) void inspect(next.sequence);
}
const REF = /^(agent|tool|skill|strategy|function|memory|module|type|trigger|constant):/u;
const READABLE = new Set(['target_ref','caller_ref','selected_ref','tool_ref','memory_ref','owner_ref','reason','status','access','action','operation','mode','budget_name','used','limit','remaining','requested','maximum','consumed','count','timeout_ms',
  'capability_refs','allowed_refs','required_capabilities','granted_capabilities','missing_capabilities','required_secrets','missing_secrets','secret_handle','secret_handles_required','secret_handles_granted','secret_handles_used','secret_handles_refused',
  'memory_accesses_required','memory_accesses_granted','required_memory_accesses']);
const shorten = value => value.length > 22 ? `${value.slice(0, 10)}…${value.slice(-8)}` : value;
// Long codes such as budget_limit_exceeded wrap at their separators, never inside a word.
function breakable(text) { const node = element('span'); for (const part of String(text).split(/(?<=[_/.:])/u)) node.append(part, element('wbr')); return node; }
function stack(main, sub, title) { const node = element('span', undefined, 'ref'); node.append(element('strong', main)); if (sub) node.append(element('small', sub)); if (title) node.title = title; return node; }
function refNode(value) { const path = shortRef(value), cut = path.lastIndexOf('/'); return cut < 0 ? stack(path, '', value) : stack(path.slice(cut + 1), path.slice(0, cut), value); }
function valueNode(key, value) {
  if (Array.isArray(value)) {
    const pills = element('span', undefined, 'pills');
    for (const item of value) {
      const raw = item && typeof item === 'object' ? JSON.stringify(item) : String(item);
      const pill = element('span', item?.memory_ref ? `${shortName(item.memory_ref)} · ${item.access}` : REF.test(raw) ? shortName(raw) : raw, 'pill'); pill.title = raw; pills.append(pill);
    }
    return pills;
  }
  if (typeof value === 'string' && REF.test(value)) return refNode(value);
  if (typeof value === 'string' && /^[\w.-]+:\S+$/u.test(value)) {
    // The prefix names the identifier family; the rest is shortened from the middle, the copy action keeps it whole.
    const cut = value.indexOf(':'), node = element('span', undefined, 'identifier'); node.title = value;
    node.append(element('code', shorten(value.slice(cut + 1))), element('small', value.slice(0, cut))); return node;
  }
  if (typeof value === 'boolean') return element('span', t(value ? 'yes' : 'no'));
  if (typeof value === 'number') return element('span', /_ms$/u.test(key) ? `${value} ms` : String(value), 'number');
  if (value && typeof value === 'object') { const node = element('code', JSON.stringify(value), 'json'); node.title = JSON.stringify(value); return node; }
  return breakable(value);
}
function toolButton(iconName, key, action, cls = '') {
  const node = element('button', undefined, `tool ${cls}`.trim()); node.type = 'button'; node.dataset.label = key;
  node.append(icon(iconName, 'ui-icon')); labelNode(node); node.addEventListener('click', () => action(node)); return node;
}
async function copyText(text, node) {
  try { await navigator.clipboard.writeText(text); }
  catch { setStatus('error', 'copyFailed'); return; }
  const restore = (iconName, key) => { icon(iconName, 'ui-icon', node.querySelector('svg')); node.dataset.label = key; labelNode(node); node.classList.toggle('done', key === 'copied'); };
  restore('check', 'copied'); setTimeout(() => restore('copy', 'copy'), 1400);
}
function properties(rows) {
  const list = element('dl', undefined, 'props');
  for (const row of rows) {
    if (row.value === undefined || row.value === null || row.value === '' || (Array.isArray(row.value) && !row.value.length)) continue;
    const item = element('div', undefined, 'prop'), detail = element('dd'), tools = element('span', undefined, 'prop-tools');
    detail.append(row.node ?? valueNode(row.key, row.value));
    if (row.filter) tools.append(toolButton('filter', row.filter.label, () => { $('filters').elements.namedItem(row.filter.field).value = row.value; applyFilters(); }));
    if (typeof row.value === 'string' && row.copy !== false) tools.append(toolButton('copy', 'copy', node => void copyText(row.value, node), 'copy'));
    item.append(element('dt', t(row.key)), detail, tools); list.append(item);
  }
  return list;
}
function meter(used, limit, category) {
  const gauge = element('div', undefined, 'meter'), labels = element('div', undefined, 'meter-labels'), track = element('span', undefined, 'meter-track'), fill = element('span', undefined, 'meter-fill');
  gauge.dataset.category = used > limit ? 'error' : category;
  // CSSOM assignment is allowed by the page CSP, unlike an inline style attribute.
  fill.style.width = `${Math.min(100, used / limit * 100)}%`; track.append(fill);
  labels.append(element('span', `${t('used')} ${used}`), element('span', `${t('limit')} ${limit}`)); gauge.append(labels, track); return gauge;
}
function emptyDetail() {
  const node = element('div', undefined, 'detail-empty'), mark = element('span', undefined, 'empty-mark'), keys = element('ul', undefined, 'shortcuts');
  mark.append(icon('pointer', 'ui-icon'));
  for (const [caps, key] of [[['↑', '↓'], 'shortcutNavigate'], [['['], 'shortcutRuns'], [[']'], 'shortcutDetails'], [['\\'], 'shortcutFocus'], [['0', '+', '−'], 'shortcutGraph'], [[t('escape')], 'shortcutClear']]) {
    const li = element('li'), group = element('span', undefined, 'keys'); for (const cap of caps) group.append(element('kbd', cap));
    li.append(element('span', t(key)), group); keys.append(li);
  }
  node.append(mark, element('h2', t('eventDetails')), element('p', t('selectEvent'), 'muted'), element('p', t('shortcuts'), 'shortcuts-title'), keys);
  return node;
}
function renderDetail(result) {
  const container = $('detail'); container.replaceChildren();
  if (!result) { container.append(emptyDetail()); return; }
  const event = result.event, p = event.payload, c = p.trace_context ?? {};
  const summary = page?.events.find(item => item.sequence === event.sequence_index), category = summary?.category ?? 'flow', index = summary ? page.events.indexOf(summary) : -1;
  const head = element('div', undefined, 'detail-head'), top = element('div', undefined, 'head-top'), meta = element('div', undefined, 'detail-meta');
  head.dataset.category = category; top.append(icon(category, 'detail-icon'));
  if (index >= 0) {
    const nav = element('div', undefined, 'event-nav'), previous = toolButton('chevronUp', 'previousEvent', () => step(-1)), next = toolButton('chevronDown', 'nextEvent', () => step(1));
    previous.disabled = index === 0; next.disabled = index === page.events.length - 1;
    nav.append(previous, element('span', `${index + 1} / ${page.events.length}`), next); top.append(nav);
  }
  const when = element('time', clock(event.observed_at)); if (event.observed_at) { when.dateTime = event.observed_at; when.title = time(event.observed_at); }
  meta.append(element('span', t(category), 'category-badge')); if (!essential()) meta.append(element('span', `#${event.sequence_index}`, 'mono')); meta.append(when);
  head.append(top, element('h2', t(event.kind)), meta); container.append(head);
  const code = p.code ?? p.runtime_error_code, reason = p.reason ?? p.failure_family;
  if (['refusal', 'error'].includes(category) && (code || reason)) {
    const callout = element('div', undefined, 'callout'), text = element('div'); callout.dataset.category = category;
    if (code) text.append(element('strong', code)); if (reason && reason !== code) text.append(element('p', reason));
    callout.append(icon(category, 'ui-icon'), text); container.append(callout);
  }
  if (typeof p.used === 'number' && typeof p.limit === 'number' && p.limit > 0) container.append(meter(p.used, p.limit, category));
  const actions = element('div', undefined, 'detail-actions'), source = button(t('source'), () => void openSource(event.sequence_index), 'code');
  source.dataset.action = 'source'; source.disabled = !state.sourceAvailable || !event.air_ref; source.title = source.disabled ? t('sourceMissing') : t('source');
  actions.append(source); container.append(actions);
  if (!state.sourceAvailable) container.append(element('p', t('sourceMissing'), 'action-hint'));
  const section = (key, content) => { const block = element('section', undefined, 'detail-section'); block.append(element('h3', t(key)), content); container.append(block); };
  // Essential reading keeps what a reviewer reads without knowing the trace format;
  // identifiers, digests and raw fields move to the folded technical details.
  const folded = [], keep = (rows, readable) => rows.filter(row => (essential() && !readable(row)) ? !folded.push(row) : true);
  const plain = row => typeof row.value !== 'string' || REF.test(row.value) || !/^[\w.-]+:\S+$/u.test(row.value);
  // The resource filter uses the indexed value, so it matches exactly what the reader stores.
  const context = keep([
    { key:'date', value:event.observed_at ?? t('noTime'), copy:Boolean(event.observed_at), node:event.observed_at ? stack(clock(event.observed_at), new Date(event.observed_at).toLocaleDateString(language), time(event.observed_at)) : undefined },
    { key:'agent', value:p.agent_ref ?? c.agent_ref, filter:{ field:'agent', label:'filterAgent' } },
    { key:'resource', value:summary?.resource, filter:{ field:'resource', label:'filterResource' } },
    { key:'scope', value:c.target_ref }, { key:'invocation', value:c.agent_invocation_id }, { key:'parent', value:c.parent_span_id },
  ], row => !['invocation', 'parent'].includes(row.key));
  section('context', properties(context));
  const recorded = keep(Object.entries(p).filter(([key]) => !['trace_context', 'agent_ref'].includes(key)).map(([key, value]) => ({ key, value })), row => (READABLE.has(row.key) || ['provider_kind', 'provider_name', 'model_id', 'decision_interface', 'history_storage', 'history_max_messages', 'history_max_bytes', 'history_retained_max_bytes', 'history_summary'].includes(row.key)) && plain(row));
  if (recorded.length) section('fields', properties(recorded));
  const integrity = keep([{ key:'eventId', value:event.event_id }, { key:'digest', value:result.originalEventDigest }], () => false);
  if (integrity.length) section('integrity', properties(integrity));
  const technical = element('details', undefined, 'technical'), title = element('summary'), body = element('div', undefined, 'technical-body'), json = JSON.stringify(event, null, 2);
  title.append(icon('code', 'ui-icon'), element('span', t('technicalData')));
  if (folded.length) body.append(properties(folded));
  body.append(element('p', t('output'), 'hint'), toolButton('copy', 'copyJson', node => void copyText(json, node)), element('pre', json));
  technical.append(title, body); container.append(technical);
}
async function openSource(sequence) {
  try {
    const data = await rpc('source', { sequence });
    if (data.openedInEditor) { notify('sourceNotice'); return; }
    $('source-title').textContent = `${data.path}:${data.source_ref.start_line + 1}`;
    const code = $('source-content'); code.replaceChildren();
    data.text.split('\n').forEach((line, index) => {
      const row = element('span', undefined, `source-line${index >= data.source_ref.start_line && index <= data.source_ref.end_line ? ' highlight' : ''}`);
      row.append(element('span', String(index + 1), 'line-number'), document.createTextNode(line)); code.append(row);
    });
    $('source-dialog').showModal(); code.querySelector('.highlight')?.scrollIntoView({ block:'center' });
  } catch (error) { fail(error); }
}
function applyPanels() {
  const main = $('layout'), focus = $('focus-mode'), focused = !prefs.runs && !prefs.detail;
  main.dataset.runs = prefs.runs ? 'open' : 'closed'; main.dataset.detail = prefs.detail ? 'open' : 'closed';
  $('show-runs').hidden = prefs.runs; $('show-detail').hidden = prefs.detail;
  focus.setAttribute('aria-pressed', String(focused)); focus.dataset.label = focused ? 'exitFocus' : 'focusMode'; labelNode(focus);
  icon(focused ? 'collapse' : 'expand', 'ui-icon', focus.querySelector('svg'));
  document.documentElement.dataset.level = prefs.level;
  for (const group of document.querySelectorAll('[data-pref]')) for (const node of group.querySelectorAll('button')) {
    node.setAttribute('aria-pressed', String(group.dataset.pref === 'panels' ? prefs[node.dataset.value] : prefs[group.dataset.pref] === node.dataset.value));
  }
}
function setPanel(name, open) { prefs[name] = open; applyPanels(); savePrefs(); }
function applyTheme(theme) {
  const node = $('theme'); document.documentElement.dataset.theme = theme;
  node.setAttribute('aria-pressed', String(theme === 'dark')); node.dataset.label = theme === 'dark' ? 'themeLight' : 'themeDark'; labelNode(node);
}
function toggleDisplay(open = $('display-panel').hidden) { $('display-panel').hidden = !open; $('display-toggle').setAttribute('aria-expanded', String(open)); }
function toggleAdvanced(open = $('advanced').hidden) {
  $('advanced').hidden = !open; $('advanced-toggle').setAttribute('aria-expanded', String(open));
  if (open) $('advanced').querySelector('input')?.focus();
}
for (const target of document.querySelectorAll('svg[data-icon]')) icon(target.dataset.icon, target.getAttribute('class'), target);
$('filters').addEventListener('submit', event => { event.preventDefault(); toggleAdvanced(false); applyFilters(); });
$('search').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(applyFilters, 300); });
$('search').addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); clearTimeout(searchTimer); applyFilters(); } });
$('category').addEventListener('change', applyFilters);
const setLevel = value => { for (const node of $('level').querySelectorAll('button')) node.setAttribute('aria-pressed', String(node.dataset.value === value)); };
for (const node of $('level').querySelectorAll('button')) node.addEventListener('click', () => { setLevel(node.dataset.value); applyFilters(); });
$('reset').addEventListener('click', () => { clearTimeout(searchTimer); HTMLFormElement.prototype.reset.call($('filters')); setLevel('technical'); query = {}; offset = 0; filterCount(); void load(); });
$('advanced-toggle').addEventListener('click', event => { event.stopPropagation(); toggleDisplay(false); toggleAdvanced(); });
$('display-toggle').addEventListener('click', event => { event.stopPropagation(); toggleAdvanced(false); toggleDisplay(); });
document.addEventListener('click', event => {
  if (!$('advanced').hidden && !event.target.closest('#advanced, #advanced-toggle')) toggleAdvanced(false);
  if (!$('display-panel').hidden && !event.target.closest('#display-panel, #display-toggle')) toggleDisplay(false);
});
for (const group of document.querySelectorAll('[data-pref]')) for (const node of group.querySelectorAll('button')) node.addEventListener('click', () => {
  if (group.dataset.pref === 'panels') { setPanel(node.dataset.value, !prefs[node.dataset.value]); return; }
  prefs.level = node.dataset.value; applyPanels(); savePrefs(); renderRuns(); if (page) renderPage(); renderDetail(detailResult);
});
for (const node of document.querySelectorAll('.views [data-view]')) node.addEventListener('click', () => {
  view = node.dataset.view; for (const other of document.querySelectorAll('.views [data-view]')) other.setAttribute('aria-pressed', String(other === node)); void load();
});
$('language').addEventListener('change', () => { language = $('language').value; savePrefs(); translate(); });
$('theme').addEventListener('click', () => { prefs.theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'; applyTheme(prefs.theme); savePrefs(); });
const vscodeDark = document.body.classList.contains('vscode-dark') || (document.body.classList.contains('vscode-high-contrast') && !document.body.classList.contains('vscode-high-contrast-light'));
applyTheme(prefs.theme ?? (vscodeDark || matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
$('previous').addEventListener('click', () => { offset = Math.max(0, offset - 100); void load(); });
$('next').addEventListener('click', () => { offset += 100; void load(); });
$('refresh').addEventListener('click', () => void list());
$('run-search').addEventListener('submit', event => { event.preventDefault(); void list(); });
$('more').addEventListener('click', () => void list(true));
$('cancel').addEventListener('click', async () => { ++revision; try { await rpc('cancel'); clearSelection(); notify('readingCancelled'); } catch (error) { fail(error); } finally { setBusy(false); } });
$('close-source').addEventListener('click', () => $('source-dialog').close());
$('zoom-in').addEventListener('click', () => zoomGraph(.8)); $('zoom-out').addEventListener('click', () => zoomGraph(1.25)); $('fit').addEventListener('click', fitGraph);
$('hide-runs').addEventListener('click', () => setPanel('runs', false)); $('show-runs').addEventListener('click', () => setPanel('runs', true));
$('hide-detail').addEventListener('click', () => setPanel('detail', false)); $('show-detail').addEventListener('click', () => setPanel('detail', true));
$('focus-mode').addEventListener('click', () => { const open = !prefs.runs && !prefs.detail; prefs.runs = open; prefs.detail = open; applyPanels(); savePrefs(); });
$('events').addEventListener('keydown', event => {
  if (!page?.events.length || !['ArrowDown','ArrowUp'].includes(event.key) || event.target.closest('summary')) return;
  event.preventDefault(); step(event.key === 'ArrowDown' ? 1 : -1);
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && !$('advanced').hidden) { toggleAdvanced(false); $('advanced-toggle').focus(); return; }
  if (event.key === 'Escape' && !$('display-panel').hidden) { toggleDisplay(false); $('display-toggle').focus(); return; }
  if (event.metaKey || (event.ctrlKey && !event.altKey) || $('source-dialog').open || event.target.closest('input,select,textarea')) return;
  const onGraph = action => () => { if (view === 'graph') action(); };
  const actions = { '[':() => setPanel('runs', !prefs.runs), ']':() => setPanel('detail', !prefs.detail), '\\':() => $('focus-mode').click(),
    '0':onGraph(fitGraph), '+':onGraph(() => zoomGraph(.8)), '=':onGraph(() => zoomGraph(.8)), '-':onGraph(() => zoomGraph(1.25)), Escape:clearEventSelection };
  if (actions[event.key]) { event.preventDefault(); actions[event.key](); }
});
$('export').addEventListener('click', async () => {
  if (busy || !state) return;
  const generation = revision, segment = state.id;
  setBusy(true);
  try {
    const report = await rpc('export', query);
    if (generation !== revision || state?.id !== segment) return;
    if (vscode && report.saved === false) { notify('cancelled'); return; }
    if ((!vscode || embeddedHost) && report.segment?.id !== segment) throw new Error('TraceExportSelectionChanged');
    if (!vscode || embeddedHost) { const url = URL.createObjectURL(new Blob([JSON.stringify(report,null,2)],{type:'application/json'})), a = element('a'); a.href = url; a.download = 'touba-trace-selection.json'; a.click(); setTimeout(()=>URL.revokeObjectURL(url),1000); }
    notify('exported');
  } catch(error) { if (generation === revision) fail(error); }
  finally { if (generation === revision) setBusy(false); }
});
let resizeFrame;
new ResizeObserver(() => {
  const rect = $('graph')?.getBoundingClientRect(); if (!rect?.width || !rect.height || !box) return;
  if (autoFit) { cancelAnimationFrame(resizeFrame); resizeFrame = requestAnimationFrame(fitGraph); return; }
  const w = box.h * rect.width / rect.height; if (Math.abs(w - box.w) < 0.5) return;
  box = { ...box, x:box.x + (box.w - w) / 2, w }; applyBox();
}).observe($('canvas-wrap'));
translate(); embeddedHost?.postMessage({ method: 'ready' }); void list();
