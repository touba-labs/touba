import { visibleGraph, layoutGraph, viewForNode } from './view.mjs';

const strings = {
  en: { readonly:'Read-only',theme:'Theme',diagnostics:'Diagnostics',resources:'Project resources',search:'Search resources',kind:'Kind',module:'Module',package:'Package',architecture:'Architecture',flow:'Flow',governance:'Governance',group:'Group modules and packages',focus:'Focus',all:'All',both:'Both directions',incoming:'Incoming',outgoing:'Outgoing',depth:'Depth',reset:'Reset',empty:'No resources in this view. Adjust the filters.',fit:'Fit',fullscreen:'Full screen',export:'Export SVG',details:'Resource details',select:'Select a resource or a relationship to explore its contract and source.',close:'Close',loading:'Reading project sources…',ready:'Up to date · compiled sources',stale:'Source errors · showing the last valid graph',error:'The project could not be compiled',source:'Open source',expand:'Explore contents',signature:'Signature',relations:'Relationships',origin:'Origin',description:'Description',responsibility:'Responsibility',count:'resources',limited:'Graph limited to 200 nodes. Refine the filters; the list includes all matches.',sourceError:'Source unavailable. Refresh the project and try again.',connection:'Connection lost. Reconnecting…',legend:'Solid: structure / flow · Dashed: declared authority',aggregate:'Grouped relationships',boundary:'External handler',budgets:'Run budgets',noFlows:'Choose a strategy, skill or function to inspect its source-defined flow.' },
  fr: { readonly:'Lecture seule',theme:'Thème',diagnostics:'Diagnostics',resources:'Ressources du projet',search:'Rechercher une ressource',kind:'Type',module:'Module',package:'Package',architecture:'Architecture',flow:'Parcours',governance:'Gouvernance',group:'Regrouper modules et packages',focus:'Voisinage',all:'Tous',both:'Les deux sens',incoming:'Entrant',outgoing:'Sortant',depth:'Profondeur',reset:'Réinitialiser',empty:'Aucune ressource dans cette vue. Ajustez les filtres.',fit:'Cadrer',fullscreen:'Plein écran',export:'Exporter SVG',details:'Détails de la ressource',select:'Sélectionnez une ressource ou une relation pour consulter son contrat et sa source.',close:'Fermer',loading:'Lecture des sources du projet…',ready:'À jour · sources compilées',stale:'Erreurs dans les sources · dernier graphe valide affiché',error:'Le projet ne peut pas être compilé',source:'Ouvrir la source',expand:'Explorer le contenu',signature:'Signature',relations:'Relations',origin:'Origine',description:'Description',responsibility:'Responsabilité',count:'ressources',limited:'Graphe limité à 200 nœuds. Affinez les filtres ; la liste contient tous les résultats.',sourceError:'Source indisponible. Actualisez le projet puis réessayez.',connection:'Connexion interrompue. Reconnexion…',legend:'Continu : structure / parcours · Pointillé : autorité déclarée',aggregate:'Relations regroupées',boundary:'Handler externe',budgets:'Budgets du run',noFlows:'Choisissez une stratégie, une compétence ou une fonction pour examiner son parcours.' },
};
const kinds = { en:{}, fr:{ module:'Module',package:'Package',agent:'Agent',skill:'Compétence',tool:'Outil',strategy:'Stratégie',function:'Fonction',type:'Type',constant:'Constante',memory:'Mémoire',trigger:'Déclencheur',secret_handle:'Nom de secret',capability:'Capacité',call_agent:'Appel agent',call_tool:'Appel outil',call_skill:'Appel compétence',call_function:'Appel fonction',call_strategy:'Appel stratégie',parallel_call:'Appel parallèle',human_approval:'Approbation humaine',user_interaction:'Interaction',branch:'Condition',loop:'Boucle',give:'Retour',bind:'Liaison',stop:'Arrêt',fallback:'Repli' } };
const relations = {
  en:{contains:'contains',imports:'imports',invokes:'calls in source',dispatches:'dispatches',uses:'may use',callable_by:'may invoke agent',memory_scope:'memory scope',memory_access:'memory access',requires:'requires',entry:'entry',calls:'target',flow:'flow',recovery:'recovery'},
  fr:{contains:'contient',imports:'importe',invokes:'appelle dans le code',dispatches:'déclenche',uses:'peut utiliser',callable_by:'peut appeler l’agent',memory_scope:'périmètre mémoire',memory_access:'accès mémoire',requires:'requiert',entry:'entrée',calls:'cible',flow:'parcours',recovery:'reprise'},
};
strings.en.diagnosticOnly='Files with diagnostics'; strings.fr.diagnosticOnly='Fichiers avec diagnostics';
relations.en.approval_site = 'approval step'; relations.fr.approval_site = 'étape d’approbation';
relations.en.context_link = 'context execution link'; relations.fr.context_link = 'lien de procédure';
kinds.en.context = 'Context procedure'; kinds.fr.context = 'Procédure contextuelle';
const icons = {
  module:'M3 7h7l2 2h9v11H3z M3 7V4h7l2 3', package:'m3 7 9-4 9 4v10l-9 4-9-4z M3 7l9 4 9-4 M12 11v10',
  agent:'M5 9h14v12H5z M9 14h.1 M15 14h.1 M9 18h6 M12 3v6 M9 3h6', skill:'m13 2-9 12h7l-1 8 10-13h-7z',
  tool:'M14 3a6 6 0 0 0-7 8l-5 6 5 5 6-6a6 6 0 0 0 8-7l-5 4-5-5z', strategy:'M4 4h6v5H4z M14 15h6v5h-6z M4 15h6v5H4z M7 9v3h10v3 M7 12v3',
  function:'M16 3h-4l-3 18H5 M5 10h12', memory:'M3 6c0-5 18-5 18 0s-18 5-18 0v12c0 5 18 5 18 0V6 M3 12c0 5 18 5 18 0',
  human_approval:'m4 12 5 5 11-12 M21 12v8H3V4h10', branch:'m12 2 10 10-10 10L2 12z', parallel_call:'M12 2v5 M4 12V7h16v5 M4 16v4h16v-4 M12 20v3 M12 7v9',
  secret_handle:'M5 10h14v11H5z M8 10V6a4 4 0 0 1 8 0v4', loop:'M4 7a9 9 0 1 1-1 9 M4 2v6h6', trigger:'m13 2-9 12h7l-1 8 10-13h-7z', type:'M4 5h16 M12 5v15 M8 20h8', constant:'M4 9h16 M4 15h16', capability:'M12 2 3 6v7c0 5 9 9 9 9s9-4 9-9V6z',
};
const $ = id => document.getElementById(id), ns = 'http://www.w3.org/2000/svg';
const vscode = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : null;
const stored = vscode?.getState() ?? {};
let lang = stored.lang ?? (navigator.language.startsWith('fr') ? 'fr' : 'en');
let state = { status:'loading',graph:null,diagnostics:[] }, selected = stored.selected ?? null, selectedEdge = null;
let view = stored.view ?? 'architecture', box = stored.box ?? null, layout, rendered, revision;
const token = vscode ? '' : location.hash.slice(1) || sessionStorage.getItem('touba-explorer-token') || '';
if (!vscode && token) { sessionStorage.setItem('touba-explorer-token', token); history.replaceState(null, '', location.pathname); }
const text = key => strings[lang][key] ?? key;
const kindText = kind => kinds[lang][kind] ?? kind.replaceAll('_', ' ');
const nodeLabel = node => node.graph ? kindText(node.kind) : node.name;
const edgeText = e => `${relations[lang][e.kind] ?? e.kind}${e.role ? ` · ${e.role}` : ''}${e.count > 1 ? ` ×${e.count}` : ''}`;
function el(tag, content, className) { const node = document.createElement(tag); if (content !== undefined) node.textContent = content; if (className) node.className = className; return node; }
function svg(tag, attrs = {}, content) { const node = document.createElementNS(ns, tag); for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value); if (content !== undefined) node.textContent = content; return node; }
function icon(kind) { return icons[kind] ?? (kind.startsWith('call_') ? 'M3 12h17 M14 5l7 7-7 7' : 'M4 4h16v16H4z M8 8h8 M8 12h8 M8 16h5'); }
function button(label, fn) { const b = el('button', label); b.addEventListener('click', fn); return b; }
function save() { vscode?.setState({ lang, selected, view, box }); }
function options() { return { view, selected, search:$('search').value, kind:$('kind').value, module:$('module').value, package:$('package').value, group:$('group').checked, direction:$('direction').value, depth:Number($('depth').value), diagnosticOnly:$('diagnostic-only').checked, diagnosticFiles:state.diagnostics.map(d=>d.source_ref?.source_id).filter(Boolean) }; }
function setOptions(id, values) { const select = $(id), previous = select.value; select.replaceChildren(new Option(text('all'), ''), ...values.map(([value, label]) => new Option(label, value))); if (values.some(([v]) => v === previous)) select.value = previous; }
function translate() {
  document.documentElement.lang = lang; $('language').value = lang;
  for (const node of document.querySelectorAll('[data-i18n]')) node.textContent = text(node.dataset.i18n);
  $('search').placeholder = text('search'); $('resource-list').ariaLabel = text('resources');
  if (state.graph) {
    setOptions('kind', [...new Set(state.graph.nodes.map(n => n.kind))].sort().map(k => [k, kindText(k)]));
    setOptions('module', state.graph.nodes.filter(n => n.kind === 'module').map(n => [n.id, n.name]));
    setOptions('package', state.graph.nodes.filter(n => n.kind === 'package').map(n => [n.name, n.name]));
  } else for (const id of ['kind','module','package']) setOptions(id, []);
  renderStatus(); render(); save();
}
function renderStatus() {
  $('status').textContent = text(state.status); $('status').dataset.status = state.status;
  $('diagnostics').hidden = !state.diagnostics.length;
  const list = $('diagnostics').querySelector('ul'); list.replaceChildren();
  for (const d of state.diagnostics) list.append(el('li', `${d.code ?? ''}: ${d.message}${d.source_ref?.source_id ? ` (${d.source_ref.source_id}:${d.source_ref.start_line + 1})` : ''}`));
  $('project-name').textContent = state.graph?.name ?? '';
}
function selectNode(id, center = false) { selected = id; selectedEdge = null; render(); if (center) centerSelection(); save(); }
function revealNode(id) {
  const node=state.graph?.nodes.find(n=>n.id===id); if (!node) return;
  for (const field of ['search','kind','module','package']) $(field).value='';
  $('direction').value='all'; $('group').checked=false; $('diagnostic-only').checked=false;
  view=viewForNode(node); box=null; selectNode(id,true);
}
function centerSelection() {
  const p = layout?.positions.get(selected); if (!p) return;
  const r = $('graph').getBoundingClientRect(); box = { x:p.x + 120 - r.width / 2, y:p.y + 35 - r.height / 2, w:r.width, h:r.height }; applyBox();
}
function render() {
  const graph = state.graph;
  const focusId = document.activeElement?.dataset.resourceId;
  for (const b of document.querySelectorAll('[data-view]')) b.setAttribute('aria-pressed', String(b.dataset.view === view));
  $('group').disabled = view !== 'architecture';
  rendered = visibleGraph(graph, options());
  const list = $('resource-list'); list.replaceChildren();
  for (const n of rendered.nodes) {
    const b = button('', () => selectNode(n.id, true)); b.dataset.resourceId=n.id; b.setAttribute('aria-pressed', String(selected === n.id)); b.title = `${kindText(n.kind)} · ${n.name}`;
    const mark = svg('svg', { viewBox:'0 0 24 24',class:'icon-small','aria-hidden':'true' }); mark.append(svg('path', { d:icon(n.kind) })); b.append(mark, el('span', nodeLabel(n))); const li = el('li'); li.append(b); list.append(li);
  }
  $('count').textContent = `${rendered.total} ${text('count')}`;
  $('legend').textContent = rendered.total > 200 ? text('limited') : text('legend');
  const visible = rendered.nodes.slice(0, 200);
  if (selected && !visible.some(n=>n.id===selected)) { const chosen=rendered.nodes.find(n=>n.id===selected); if(chosen)visible.splice(199,1,chosen); }
  const ids = new Set(visible.map(n => n.id));
  const edges = rendered.edges.filter(e => ids.has(e.from) && ids.has(e.to));
  layout = layoutGraph(visible, edges);
  const drawing = $('drawing'); drawing.replaceChildren();
  const defs = svg('defs'), marker = svg('marker', { id:'arrow',viewBox:'0 0 10 10',refX:9,refY:5,markerWidth:7,markerHeight:7,orient:'auto-start-reverse' }); marker.append(svg('path', { d:'M0 0 10 5 0 10z',class:'arrow' })); defs.append(marker); drawing.append(defs);
  const lanes = new Map();
  for (const e of edges) {
    const a = layout.positions.get(e.from), b = layout.positions.get(e.to);
    const laneKey = `${e.from}:${e.to}`, lane = lanes.get(laneKey) ?? 0; lanes.set(laneKey, lane + 1);
    const x1 = a.x + 120 + lane * 20, y1 = a.y + 72, x2 = b.x + 120 + lane * 20, y2 = b.y;
    const bend = y2 > y1 ? (y2 - y1) / 2 : 65 + lane * 18;
    const path = `M${x1} ${y1} C${x1} ${y1+bend},${x2} ${y2-bend},${x2} ${y2}`;
    const g = svg('g', { class:`edge${selectedEdge?.id === e.id ? ' selected' : ''}`,'data-kind':e.kind,tabindex:0,role:'button','aria-label':`${e.from} ${edgeText(e)} ${e.to}` });
    g.append(svg('path', { d:path,'marker-end':'url(#arrow)' }), svg('text', { x:x1*.25+x2*.75+(lane%2?65:-60),y:y1*.25+y2*.75-5+lane*12 }, edgeText(e)));
    const pick = () => { selectedEdge = e; selected = null; renderDetails(); };
    g.addEventListener('click', pick); g.addEventListener('keydown', event => { if (['Enter',' '].includes(event.key)) { event.preventDefault(); pick(); } }); drawing.append(g);
  }
  for (const n of visible) {
    const p = layout.positions.get(n.id), g = svg('g', { class:`node${selected === n.id ? ' selected' : ''}`,transform:`translate(${p.x} ${p.y})`,tabindex:0,role:'button','aria-label':`${kindText(n.kind)} ${n.name}`,'data-id':n.id });
    g.setAttribute('data-kind',n.kind);
    g.append(svg('rect', { width:240,height:72,rx:9 }), svg('title', {}, `${n.name}\n${n.id}`));
    const mark = svg('g', { transform:'translate(15 23)',class:'icon' }); mark.append(svg('path', { d:icon(n.kind) }));
    const label=nodeLabel(n);
    g.append(mark, svg('text', { x:50,y:29 }, label.length > 24 ? `${label.slice(0,23)}…` : label), svg('text', { x:50,y:50,class:'kind' }, `${kindText(n.kind)}${n.count ? ` · ${n.count}` : ''}`));
    g.addEventListener('click', () => selectNode(n.id)); g.addEventListener('dblclick', () => expand(n));
    g.addEventListener('keydown', event => { if (['Enter',' '].includes(event.key)) { event.preventDefault(); selectNode(n.id); } }); drawing.append(g);
  }
  $('empty').hidden = Boolean(visible.length); $('export').disabled = !visible.length;
  if (!box) fit(); else applyBox(); renderDetails();
  if (focusId) [...list.querySelectorAll('button')].find(b=>b.dataset.resourceId===focusId)?.focus({preventScroll:true});
}
function expand(n) {
  if (n.kind === 'module') { $('module').value = n.id; $('group').checked = false; }
  else if (n.kind === 'package') $('package').value = n.name;
  else { selected = n.id; view = 'flow'; $('direction').value = 'outgoing'; }
  box = null; render(); save();
}
function renderDetails() {
  const panel = $('detail'); panel.replaceChildren();
  const node = state.graph?.nodes.find(n => n.id === selected);
  if (selectedEdge) {
    panel.append(el('h2', edgeText(selectedEdge)), el('p', `${selectedEdge.from} → ${selectedEdge.to}`));
    if (selectedEdge.aggregated) panel.append(el('p', text('aggregate')));
    for (const id of [selectedEdge.from, selectedEdge.to]) panel.append(button(state.graph.nodes.find(n => n.id === id)?.name ?? id, () => revealNode(id)));
    return;
  }
  if (!node) { panel.append(el('h2', text('details')), el('p', text('select'), 'muted')); return; }
  panel.append(el('h2', nodeLabel(node)), el('span', kindText(node.kind), 'badge'));
  if (['module','package'].includes(node.kind) || state.graph.edges.some(e => e.kind === 'entry' && e.from === node.id)) panel.append(button(text('expand'), () => expand(node)));
  if (node.source_ref) panel.append(button(text('source'), () => openSource(node.id)));
  const section = (title, value, code = false) => { panel.append(el('h3', title), el(code ? 'pre' : 'p', value)); };
  for (const [key, value] of Object.entries(node.details ?? {})) {
    if (key === 'signature') {
      const type = name => name?.replaceAll('builtin:', '').replaceAll('list:', 'List of ') ?? '';
      section(text(key), `${(value.inputs ?? []).map(i => `${i.name}: ${type(i.type_ref)}`).join('\n')}\n→ ${type(value.output_type)}`, true);
    } else if (value !== undefined) section(text(key), typeof value === 'string' ? value : JSON.stringify(value, null, 2), typeof value !== 'string');
  }
  if (node.source_ref) section(text('origin'), `${node.source_ref.source_id}:${node.source_ref.start_line + 1}`);
  section(text('relations'), '');
  const list = el('ul');
  for (const e of state.graph.edges.filter(e => e.from === node.id || e.to === node.id)) {
    const target = state.graph.nodes.find(n => n.id === (e.from === node.id ? e.to : e.from));
    const li = el('li'); li.append(el('small', `${e.from === node.id ? '→' : '←'} ${edgeText(e)}`), button(target?.name ?? '?', () => revealNode(target.id))); list.append(li);
  }
  panel.append(list);
}
function applyBox() { if (box) $('graph').setAttribute('viewBox', `${box.x} ${box.y} ${box.w} ${box.h}`); save(); }
function fit() {
  if (!layout) return;
  const rect = $('graph').getBoundingClientRect(), ratio = rect.width / Math.max(1,rect.height);
  const width = Math.max(layout.width, layout.height * ratio), height = width / ratio;
  box = { x:(layout.width-width)/2,y:(layout.height-height)/2,w:width,h:height }; applyBox();
}
function zoom(factor) { if (!box) return; const w = Math.min(30000,Math.max(200,box.w*factor)), h=box.h*w/box.w; box = { x:box.x+(box.w-w)/2,y:box.y+(box.h-h)/2,w,h }; applyBox(); }
async function api(path) { const response = await fetch(path, { headers:{ Authorization:`Bearer ${token}` },cache:'no-store' }); if (!response.ok) throw new Error(`HTTP ${response.status}`); return response.json(); }
async function openSource(id) {
  if (vscode) { vscode.postMessage({ type:'source',id }); return; }
  try { showSource(await api(`/api/source?id=${encodeURIComponent(id)}`)); } catch { $('status').textContent = text('sourceError'); }
}
function showSource(source) {
  if (!source) return;
  $('source-title').textContent = source.path; const code = $('source-code'); code.replaceChildren();
  source.text.split('\n').forEach((line, index) => { const node = el('span', undefined, `source-line${index >= source.source_ref.start_line && index <= source.source_ref.end_line ? ' highlight' : ''}`); node.append(el('span',String(index+1),'line-number'),document.createTextNode(line)); code.append(node); });
  $('source-dialog').showModal(); code.querySelector('.highlight')?.scrollIntoView({ block:'center' });
}
function receive(next) {
  const diagnosticsChanged=JSON.stringify(state.diagnostics)!==JSON.stringify(next.diagnostics);
  state = next;
  if (revision !== next.graph?.revision) { revision = next.graph?.revision; translate(); }
  else { renderStatus(); if (diagnosticsChanged) render(); }
  vscode?.postMessage({type:'rendered', revision:state.graph?.revision, count:rendered?.nodes.length ?? 0});
}
async function poll() {
  try { receive(await api('/api/state')); } catch { $('status').textContent = text('connection'); }
  setTimeout(poll, 1200);
}
$('language').addEventListener('change', () => { lang=$('language').value; translate(); });
$('theme').addEventListener('click', () => { document.documentElement.dataset.theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'; });
document.documentElement.dataset.theme = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
for (const id of ['search','kind','module','package','group','direction','depth','diagnostic-only']) $(id).addEventListener(id === 'search' ? 'input' : 'change', () => { box=null; render(); });
for (const b of document.querySelectorAll('[data-view]')) b.addEventListener('click', () => { view=b.dataset.view; selectedEdge=null; box=null; render(); save(); });
$('reset').addEventListener('click', () => { for (const id of ['search','kind','module','package']) $(id).value=''; $('direction').value='all'; $('group').checked=true; $('diagnostic-only').checked=false; box=null; render(); });
$('fit').addEventListener('click', fit); $('zoom-in').addEventListener('click', () => zoom(.8)); $('zoom-out').addEventListener('click', () => zoom(1.25));
$('fullscreen').addEventListener('click', async () => { try { if (document.fullscreenElement) await document.exitFullscreen(); else await document.querySelector('.workspace').requestFullscreen(); fit(); } catch { $('fullscreen').disabled=true; } });
$('close-source').addEventListener('click', () => $('source-dialog').close());
$('export').addEventListener('click', () => {
  const clone=$('graph').cloneNode(true); clone.setAttribute('width',String(layout.width)); clone.setAttribute('height',String(layout.height)); clone.setAttribute('viewBox',`0 0 ${layout.width} ${layout.height}`);
  const sourceNodes=$('graph').querySelectorAll('*'), cloneNodes=clone.querySelectorAll('*');
  sourceNodes.forEach((node,i) => { const style=getComputedStyle(node); for (const key of ['fill','stroke','stroke-width','stroke-dasharray','font-family','font-size','font-weight','paint-order']) cloneNodes[i].setAttribute(key,style.getPropertyValue(key)); });
  clone.prepend(svg('rect',{width:layout.width,height:layout.height,fill:getComputedStyle(document.documentElement).getPropertyValue('--touba-background').trim()}));
  const content=new XMLSerializer().serializeToString(clone);
  if (vscode) { vscode.postMessage({ type:'export',content }); return; }
  const url=URL.createObjectURL(new Blob([content],{type:'image/svg+xml'})), a=el('a'); a.href=url; a.download='touba-project.svg'; a.click(); setTimeout(() => URL.revokeObjectURL(url),1000);
});
let drag;
$('graph').addEventListener('pointerdown', event => { if (event.target.closest('.node,.edge') || !box) return; drag={x:event.clientX,y:event.clientY,box:{...box}}; $('graph').setPointerCapture(event.pointerId); });
$('graph').addEventListener('pointermove', event => { if (!drag) return; const r=$('graph').getBoundingClientRect(); box={...drag.box,x:drag.box.x-(event.clientX-drag.x)*drag.box.w/r.width,y:drag.box.y-(event.clientY-drag.y)*drag.box.h/r.height}; applyBox(); });
$('graph').addEventListener('pointerup', () => { drag=null; }); $('graph').addEventListener('pointercancel', () => { drag=null; });
$('graph').addEventListener('wheel', event => { event.preventDefault(); zoom(event.deltaY>0?1.1:.9); }, {passive:false});
new ResizeObserver(() => { if (!box) fit(); }).observe($('canvas-wrap'));
translate();
if (vscode) {
  window.addEventListener('message', event => {
    const message=event.data;
    if (message?.type==='state') receive(message.state);
    if (message?.type==='select') revealNode(message.id);
    if (message?.type==='source') showSource(message.source);
  });
  vscode.postMessage({type:'ready'});
} else poll();
