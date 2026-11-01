import { visibleGraph, layoutGraph, viewForNode, LAYOUT_SIZES } from './view.mjs';

const strings = {
  en: { readonly:'Read-only',language:'Language',diagnostics:'Diagnostics',resources:'Project resources',search:'Search resources',kind:'Kind',module:'Module',package:'Package',architecture:'Architecture',flow:'Flow',governance:'Governance',group:'Group',groupTitle:'Group modules and packages',focus:'Focus',all:'All',both:'Both directions',incoming:'Incoming',outgoing:'Outgoing',depth:'Depth',reset:'Reset',empty:'No resources in this view. Adjust the filters.',errorEmpty:'No graph yet: the project could not be compiled. Open the diagnostics above to fix it.',fit:'Fit',fullscreen:'Full screen',exportSvg:'Export as SVG (vector)',exportPng:'Export as PNG (image)',exportError:'The image could not be exported. Try SVG.',themeDark:'Switch to dark theme',themeLight:'Switch to light theme',details:'Resource details',select:'Select a resource or a relationship to explore its contract and source.',hint:'Double-click a module or a package to explore its contents.',close:'Close',loading:'Reading project sources…',ready:'Up to date · compiled sources',stale:'Source errors · showing the last valid graph',error:'The project could not be compiled',source:'Open source',expand:'Explore contents',relations:'Relationships',outgoingRelations:'Outgoing',incomingRelations:'Incoming',origin:'Origin',count:'resources',limited:'Graph limited to 200 nodes. Refine the filters; the list includes all matches.',sourceError:'Source unavailable. Refresh the project and try again.',connection:'Connection lost. Reconnecting…',legendStructure:'Structure and flow',legendAuthority:'Declared authority',aggregate:'Grouped relationships',boundaryValue:'Implemented in JavaScript or Python, outside the Touba program.',noFlows:'Choose a strategy, skill or function to inspect its source-defined flow.',filters:'Filters',inspector:'Details',display:'Display',edgeLabels:'Relationship labels',labelsAll:'Always',labelsAuto:'Selection',labelsNone:'Hidden',orientation:'Orientation',vertical:'Vertical',horizontal:'Horizontal',density:'Density',comfortable:'Comfortable',compact:'Compact',panels:'Panels',resourcesShort:'Resources',hideResources:'Hide resources  [',showResources:'Show resources  [',hideDetails:'Hide details  ]',showDetails:'Show details  ]',focusMode:'Graph only  \\',exitFocus:'Show panels  \\',zoomIn:'Zoom in  +',zoomOut:'Zoom out  −',shortcuts:'Shortcuts: [ resources · ] details · \\ graph only · 0 fit · + and − zoom · Esc or a second click clear the selection',diagnosticOnly:'Files with diagnostics' },
  fr: { readonly:'Lecture seule',language:'Langue',diagnostics:'Diagnostics',resources:'Ressources du projet',search:'Rechercher une ressource',kind:'Type',module:'Module',package:'Package',architecture:'Architecture',flow:'Parcours',governance:'Gouvernance',group:'Regrouper',groupTitle:'Regrouper modules et packages',focus:'Voisinage',all:'Tous',both:'Les deux sens',incoming:'Entrant',outgoing:'Sortant',depth:'Profondeur',reset:'Réinitialiser',empty:'Aucune ressource dans cette vue. Ajustez les filtres.',errorEmpty:'Aucun graphe pour l’instant : le projet ne peut pas être compilé. Ouvrez les diagnostics ci-dessus pour le corriger.',fit:'Cadrer',fullscreen:'Plein écran',exportSvg:'Exporter en SVG (vectoriel)',exportPng:'Exporter en PNG (image)',exportError:'L’image n’a pas pu être exportée. Essayez le SVG.',themeDark:'Passer au thème sombre',themeLight:'Passer au thème clair',details:'Détails de la ressource',select:'Sélectionnez une ressource ou une relation pour consulter son contrat et sa source.',hint:'Double-cliquez sur un module ou un package pour explorer son contenu.',close:'Fermer',loading:'Lecture des sources du projet…',ready:'À jour · sources compilées',stale:'Erreurs dans les sources · dernier graphe valide affiché',error:'Le projet ne peut pas être compilé',source:'Ouvrir la source',expand:'Explorer le contenu',relations:'Relations',outgoingRelations:'Sortantes',incomingRelations:'Entrantes',origin:'Origine',count:'ressources',limited:'Graphe limité à 200 nœuds. Affinez les filtres ; la liste contient tous les résultats.',sourceError:'Source indisponible. Actualisez le projet puis réessayez.',connection:'Connexion interrompue. Reconnexion…',legendStructure:'Structure et parcours',legendAuthority:'Autorité déclarée',aggregate:'Relations regroupées',boundaryValue:'Implémenté en JavaScript ou en Python, hors du programme Touba.',noFlows:'Choisissez une stratégie, une compétence ou une fonction pour examiner son parcours.',filters:'Filtres',inspector:'Détails',display:'Affichage',edgeLabels:'Étiquettes des relations',labelsAll:'Toujours',labelsAuto:'Sélection',labelsNone:'Masquées',orientation:'Orientation',vertical:'Verticale',horizontal:'Horizontale',density:'Densité',comfortable:'Confortable',compact:'Compacte',panels:'Panneaux',resourcesShort:'Ressources',hideResources:'Masquer les ressources  [',showResources:'Afficher les ressources  [',hideDetails:'Masquer les détails  ]',showDetails:'Afficher les détails  ]',focusMode:'Graphe seul  \\',exitFocus:'Afficher les panneaux  \\',zoomIn:'Zoom avant  +',zoomOut:'Zoom arrière  −',shortcuts:'Raccourcis : [ ressources · ] détails · \\ graphe seul · 0 cadrer · + et − zoom · Échap ou second clic désélectionnent',diagnosticOnly:'Fichiers avec diagnostics' },
};
Object.assign(strings.en, { level:'Detail level', essential:'Essential', complete:'Complete', properties:'Properties', technicalData:'Technical details', copy:'Copy', copied:'Copied', copyFailed:'Unable to copy', file:'File', shortcutsTitle:'Shortcuts', shortcutResources:'Resources panel', shortcutDetails:'Details panel', shortcutFocus:'Graph only', shortcutGraph:'Fit and zoom the graph', shortcutClear:'Clear the selection', escape:'Esc' });
Object.assign(strings.fr, { level:'Niveau de détail', essential:'Essentiel', complete:'Complet', properties:'Propriétés', technicalData:'Détails techniques', copy:'Copier', copied:'Copié', copyFailed:'Copie impossible', file:'Fichier', shortcutsTitle:'Raccourcis', shortcutResources:'Panneau des ressources', shortcutDetails:'Panneau des détails', shortcutFocus:'Graphe seul', shortcutGraph:'Cadrer et zoomer le graphe', shortcutClear:'Désélectionner', escape:'Échap' });
const kinds = {
  en:{ module:'Module',package:'Package',agent:'Agent',skill:'Skill',tool:'Tool',strategy:'Strategy',function:'Function',type:'Type',constant:'Constant',memory:'Memory',trigger:'Trigger',secret_handle:'Secret name',capability:'Capability',call_agent:'Agent call',call_tool:'Tool call',call_skill:'Skill call',call_function:'Function call',call_strategy:'Strategy call',parallel_call:'Parallel call',human_approval:'Human approval',user_interaction:'Interaction',branch:'Condition',loop:'Loop',give:'Return',bind:'Binding',stop:'Stop',fallback:'Fallback',context:'Context procedure' },
  fr:{ module:'Module',package:'Package',agent:'Agent',skill:'Compétence',tool:'Outil',strategy:'Stratégie',function:'Fonction',type:'Type',constant:'Constante',memory:'Mémoire',trigger:'Déclencheur',secret_handle:'Nom de secret',capability:'Capacité',call_agent:'Appel agent',call_tool:'Appel outil',call_skill:'Appel compétence',call_function:'Appel fonction',call_strategy:'Appel stratégie',parallel_call:'Appel parallèle',human_approval:'Approbation humaine',user_interaction:'Interaction',branch:'Condition',loop:'Boucle',give:'Retour',bind:'Liaison',stop:'Arrêt',fallback:'Repli',context:'Procédure contextuelle' },
};
const relations = {
  en:{contains:'contains',imports:'imports',invokes:'calls in source',dispatches:'dispatches',uses:'may use',callable_by:'may invoke agent',memory_scope:'memory scope',memory_access:'memory access',requires:'requires',entry:'entry',calls:'target',flow:'flow',recovery:'recovery',approval_site:'approval step',context_link:'context execution link'},
  fr:{contains:'contient',imports:'importe',invokes:'appelle dans le code',dispatches:'déclenche',uses:'peut utiliser',callable_by:'peut appeler l’agent',memory_scope:'périmètre mémoire',memory_access:'accès mémoire',requires:'requiert',entry:'entrée',calls:'cible',flow:'parcours',recovery:'reprise',approval_site:'étape d’approbation',context_link:'lien de procédure'},
};
const roles = {
  en:{ next:'next',true:'if true',false:'if false',loop_next:'next iteration',loop_exit:'loop exit',failure:'on failure',fallback:'fallback',expired:'on expiry',stop:'stop',read:'read',write:'write',read_write:'read and write',append:'append' },
  fr:{ next:'suite',true:'si vrai',false:'si faux',loop_next:'itération suivante',loop_exit:'sortie de boucle',failure:'en cas d’échec',fallback:'repli',expired:'à l’expiration',stop:'arrêt',read:'lecture',write:'écriture',read_write:'lecture et écriture',append:'ajout' },
};
const fields = {
  en:{ signature:'Signature',description:'Description',responsibility:'Responsibility',fields:'Fields',variants:'Variants',type_ref:'Type',limits:'Limits',memory_scopes:'Memory scopes',memory_accesses:'Memory access',event:'Event',required_capabilities:'Required capabilities',required_secrets:'Required secrets',boundary:'External handler',budgets:'Run budgets',version:'Version',activation:'Activation',target_ref:'Target',result_binding:'Result',condition_ref:'Condition',collection_ref:'Collection',item_binding:'Item',max_concurrency:'Maximum concurrency',max_items:'Maximum items',approval_policy:'Approval policy',interaction_mode:'Interaction mode',role:'Role',timeout_ms:'Timeout',access:'Access',memory_ref:'Memory',name:'Name',max_agent_invocations:'Maximum agent invocations',max_provider_calls:'Maximum provider calls',max_tool_calls:'Maximum tool calls',max_steps:'Maximum steps',max_run_ms:'Maximum run duration' },
  fr:{ signature:'Signature',description:'Description',responsibility:'Responsabilité',fields:'Champs',variants:'Variantes',type_ref:'Type',limits:'Limites',memory_scopes:'Périmètres mémoire',memory_accesses:'Accès mémoire',event:'Événement',required_capabilities:'Capacités requises',required_secrets:'Secrets requis',boundary:'Handler externe',budgets:'Budgets du run',version:'Version',activation:'Activation',target_ref:'Cible',result_binding:'Résultat',condition_ref:'Condition',collection_ref:'Collection',item_binding:'Élément',max_concurrency:'Concurrence maximale',max_items:'Éléments maximum',approval_policy:'Politique d’approbation',interaction_mode:'Mode d’interaction',role:'Rôle',timeout_ms:'Délai',access:'Accès',memory_ref:'Mémoire',name:'Nom',max_agent_invocations:'Invocations d’agents maximum',max_provider_calls:'Appels fournisseur maximum',max_tool_calls:'Appels d’outils maximum',max_steps:'Étapes maximum',max_run_ms:'Durée maximale du run' },
};
Object.assign(fields.en, { value:'Declared value', arguments:'Declared arguments', context:'Context', payload:'Input mapping', constraints:'Constraints', default:'Default value', min_length:'Minimum length', max_length:'Maximum length', format:'Format', min:'Minimum', max:'Maximum', entrypoint:'Project entrypoint', entrypoints:'Project entrypoints', exports:'Exports', dependencies:'Dependencies', engines:'Host requirements', hosts:'Declared host modules', publisher:'Publisher', license:'License', touba:'Touba compatibility', runtime_compatibility:'Runtime version', air_profile:'AIR profile', content_types:'Content types', max_bytes:'Maximum bytes', map:'Mapping', path:'Path', language:'Language', distinct_from:'Different signer', exclude_signers:'Excluded signers rule' });
Object.assign(fields.fr, { value:'Valeur déclarée', arguments:'Arguments déclarés', context:'Contexte', payload:'Correspondance des entrées', constraints:'Contraintes', default:'Valeur par défaut', min_length:'Longueur minimale', max_length:'Longueur maximale', format:'Format', min:'Minimum', max:'Maximum', entrypoint:'Entrée du projet', entrypoints:'Entrées du projet', exports:'Exports', dependencies:'Dépendances', engines:'Prérequis hôtes', hosts:'Modules hôtes déclarés', publisher:'Éditeur', license:'Licence', touba:'Compatibilité Touba', runtime_compatibility:'Version du runtime', air_profile:'Profil AIR', content_types:'Types de contenu', max_bytes:'Octets maximum', map:'Correspondance', path:'Chemin', language:'Langage', distinct_from:'Signataire différent', exclude_signers:'Règle de signataires exclus' });
const icons = {
  module:'M3 7h7l2 2h9v11H3z M3 7V4h7l2 3', package:'m3 7 9-4 9 4v10l-9 4-9-4z M3 7l9 4 9-4 M12 11v10',
  agent:'M5 9h14v12H5z M9 14h.1 M15 14h.1 M9 18h6 M12 3v6 M9 3h6', skill:'m13 2-9 12h7l-1 8 10-13h-7z',
  tool:'M14 3a6 6 0 0 0-7 8l-5 6 5 5 6-6a6 6 0 0 0 8-7l-5 4-5-5z', strategy:'M4 4h6v5H4z M14 15h6v5h-6z M4 15h6v5H4z M7 9v3h10v3 M7 12v3',
  function:'M16 3h-4l-3 18H5 M5 10h12', memory:'M3 6c0-5 18-5 18 0s-18 5-18 0v12c0 5 18 5 18 0V6 M3 12c0 5 18 5 18 0',
  human_approval:'m4 12 5 5 11-12 M21 12v8H3V4h10', branch:'m12 2 10 10-10 10L2 12z', parallel_call:'M12 2v5 M4 12V7h16v5 M4 16v4h16v-4 M12 20v3 M12 7v9',
  secret_handle:'M5 10h14v11H5z M8 10V6a4 4 0 0 1 8 0v4', loop:'M4 7a9 9 0 1 1-1 9 M4 2v6h6', trigger:'m13 2-9 12h7l-1 8 10-13h-7z', type:'M4 5h16 M12 5v15 M8 20h8', constant:'M4 9h16 M4 15h16', capability:'M12 2 3 6v7c0 5 9 9 9 9s9-4 9-9V6z',
};
const uiIcons = {
  architecture:'M4 4h7v7H4z M13 4h7v7h-7z M4 13h7v7H4z M13 13h7v7h-7z', flow:'M5 3h6v5H5z M13 16h6v5h-6z M8 8v4h8v4', governance:'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z M9 12l2 2 4-4',
  lock:'M6 11h12v9H6z M9 11V8a3 3 0 0 1 6 0v3', moon:'M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z', sun:'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z M12 2v2 M12 20v2 M4.9 4.9l1.4 1.4 M17.7 17.7l1.4 1.4 M2 12h2 M20 12h2 M4.9 19.1l1.4-1.4 M17.7 6.3l1.4-1.4',
  alert:'M12 3 2 20h20z M12 10v4 M12 17h.01', search:'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14z M20 20l-4-4', filter:'M4 5h16l-6 7v6l-4 2v-8z',
  collapseLeft:'M11 17l-5-5 5-5 M18 17l-5-5 5-5', collapseRight:'M13 17l5-5-5-5 M6 17l5-5-5-5', panelLeft:'M4 4h16v16H4z M9 4v16', panelRight:'M4 4h16v16H4z M15 4v16',
  reset:'M4 12a8 8 0 1 0 2.4-5.7 M4 4v5h5', sliders:'M4 6h9 M17 6h3 M4 12h3 M11 12h9 M4 18h11 M19 18h1 M15 4v4 M9 10v4 M17 16v4',
  expand:'M4 9V4h5 M20 9V4h-5 M4 15v5h5 M20 15v5h-5', collapse:'M9 4v5H4 M15 4v5h5 M9 20v-5H4 M15 20v-5h5',
  minus:'M5 12h14', plus:'M5 12h14 M12 5v14', fit:'M4 8V4h4 M16 4h4v4 M20 16v4h-4 M8 20H4v-4 M9 9h6v6H9z', fullscreen:'M15 3h6v6 M9 21H3v-6 M21 3l-7 7 M3 21l7-7', download:'M12 4v11 M7 10l5 5 5-5 M5 20h14',
  code:'M8 8l-4 4 4 4 M16 8l4 4-4 4 M14 4l-4 16', copy:'M9 9h11v11H9z M5 15H4V4h11v1', check:'m5 12 5 5 9-10', pointer:'M6 3l13 7-5.5 1.5L11 17z M14 13l5 5', globe:'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z M3 12h18 M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9s1.3-6.4 3.8-9z', caret:'m8 10 4 4 4-4', open:'M3 7h7l2 2h9v11H3z M12 12v5 M9.5 14.5h5',
};
const $ = id => document.getElementById(id), ns = 'http://www.w3.org/2000/svg';
const embeddedHost = window.toubaExplorerHost ?? null;
const vscode = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : embeddedHost;
const stored = vscode?.getState() ?? {};
const prefKey = 'touba-explorer-preferences';
const prefChoices = { labels:['all','auto','none'], orientation:['vertical','horizontal'], density:['comfortable','compact'], level:['complete','essential'], theme:['light','dark',null] };
let prefs = loadPrefs();
let lang = stored.lang ?? (navigator.language.startsWith('fr') ? 'fr' : 'en');
let state = { status:'loading',graph:null,diagnostics:[] }, selected = stored.selected ?? null, selectedEdge = null;
let view = stored.view ?? 'architecture', box = stored.box ?? null, autoFit = !stored.box, layout, rendered, revision;
const token = vscode ? '' : location.hash.slice(1) || sessionStorage.getItem('touba-explorer-token') || '';
if (!vscode && token) { sessionStorage.setItem('touba-explorer-token', token); history.replaceState(null, '', location.pathname); }
const text = key => strings[lang][key] ?? key;
const kindText = kind => kinds[lang][kind] ?? kind.replaceAll('_', ' ');
const roleText = role => roles[lang][role] ?? String(role).replaceAll('_', ' ');
const fieldText = key => fields[lang][key] ?? (key.replace(/_ref$/u, '').replaceAll('_', ' ').replace(/^./u, c => c.toUpperCase()));
const nodeLabel = node => node.graph ? kindText(node.kind) : node.name;
const nodeById = id => state.graph?.nodes.find(n => n.id === id);
const labelOf = id => { const node = nodeById(id); return node ? nodeLabel(node) : id; };
const edgeText = e => `${e.kind === 'flow' && e.role ? roleText(e.role) : `${relations[lang][e.kind] ?? e.kind}${e.role ? ` · ${roleText(e.role)}` : ''}`}${e.count > 1 ? ` ×${e.count}` : ''}`;
const family = kind => ['human_approval','user_interaction'].includes(kind) ? 'human' : ['module','package','context'].includes(kind) ? 'container' : ['give','stop','fallback','bind'].includes(kind) ? 'terminal' : 'default';
function loadPrefs() {
  const base = { resources:true, detail:true, filters:true, labels:'all', orientation:'vertical', density:'comfortable', level:'complete', theme:null };
  let saved = stored.prefs;
  if (!saved && !vscode) { try { saved = JSON.parse(localStorage.getItem(prefKey) ?? 'null'); } catch { saved = null; } }
  for (const [key, value] of Object.entries(saved && typeof saved === 'object' ? saved : {})) {
    if (key in prefChoices ? prefChoices[key].includes(value) : typeof base[key] === 'boolean' && typeof value === 'boolean') base[key] = value;
  }
  return base;
}
function savePrefs() { if (!vscode) { try { localStorage.setItem(prefKey, JSON.stringify(prefs)); } catch { /* storage may be unavailable */ } } save(); }
function el(tag, content, className) { const node = document.createElement(tag); if (content !== undefined) node.textContent = content; if (className) node.className = className; return node; }
function svg(tag, attrs = {}, content) { const node = document.createElementNS(ns, tag); for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value); if (content !== undefined) node.textContent = content; return node; }
function icon(kind) { return icons[kind] ?? (kind.startsWith('call_') ? 'M3 12h17 M14 5l7 7-7 7' : 'M4 4h16v16H4z M8 8h8 M8 12h8 M8 16h5'); }
function uiIcon(name, target = svg('svg', { class:'ui-icon','aria-hidden':'true' })) { target.setAttribute('viewBox', '0 0 24 24'); target.replaceChildren(svg('path', { d:uiIcons[name] ?? '' })); return target; }
function button(label, fn, iconName) { const b = el('button'); b.type = 'button'; if (iconName) b.append(uiIcon(iconName)); b.append(el('span', label)); b.addEventListener('click', fn); return b; }
function save() { vscode?.setState({ lang, selected, view, box, prefs }); }
function options() { return { view, selected, search:$('search').value, kind:$('kind').value, module:$('module').value, package:$('package').value, group:$('group').checked, direction:$('direction').value, depth:Number($('depth').value), diagnosticOnly:$('diagnostic-only').checked, diagnosticFiles:state.diagnostics.map(d=>d.source_ref?.source_id).filter(Boolean) }; }
function setOptions(id, values) { const select = $(id), previous = select.value; select.replaceChildren(new Option(text('all'), ''), ...values.map(([value, label]) => new Option(label, value))); if (values.some(([v]) => v === previous)) select.value = previous; }
function duration(ms) { if (typeof ms !== 'number') return null; if (ms >= 60000 && ms % 60000 === 0) return `${ms / 60000} min`; return ms >= 1000 ? `${Number((ms / 1000).toFixed(1))} s` : `${ms} ms`; }
function refName(value) { const node = nodeById(value); return node ? nodeLabel(node) : String(value).replace(/^value:/u, '').replace(/^[a-z_]+:(?:[\w.-]+\/)?/u, ''); }
function typeName(ref) { return typeof ref === 'string' ? ref.replaceAll('builtin:', '').replaceAll('list:', 'List of ').replace(/\btype:(?:[\w.-]+\/)?/gu, '') : ''; }
function nodeSubtitle(n) {
  const d = n.details ?? {};
  if (n.kind === 'human_approval' && d.approval_policy) { const parts = [d.approval_policy.role, duration(d.approval_policy.timeout_ms)].filter(Boolean); if (parts.length) return parts.join(' · '); }
  if (n.kind === 'parallel_call' && d.max_concurrency) return `${lang === 'fr' ? `${d.max_concurrency} en parallèle` : `${d.max_concurrency} concurrent`}${d.max_items ? ` · max ${d.max_items}` : ''}`;
  if (n.graph && d.target_ref) return `→ ${refName(d.target_ref)}`;
  if (n.graph && n.owner && nodeById(n.owner)) return nodeById(n.owner).name;
  return `${kindText(n.kind)}${n.count > 1 ? ` · ${n.count} ${text('count')}` : ''}`;
}
function translate() {
  document.documentElement.lang = lang; $('language').value = lang;
  for (const node of document.querySelectorAll('[data-i18n]')) node.textContent = text(node.dataset.i18n);
  for (const node of document.querySelectorAll('[data-i18n-label]')) { node.setAttribute('aria-label', text(node.dataset.i18nLabel).replace(/\s{2}.*$/u, '')); node.title = text(node.dataset.i18nLabel); }
  $('search').placeholder = text('search'); $('resource-list').ariaLabel = text('resources'); $('group').closest('label').title = text('groupTitle');
  if (state.graph) {
    setOptions('kind', [...new Set(state.graph.nodes.map(n => n.kind))].sort().map(k => [k, kindText(k)]));
    setOptions('module', state.graph.nodes.filter(n => n.kind === 'module').map(n => [n.id, n.name]));
    setOptions('package', state.graph.nodes.filter(n => n.kind === 'package').map(n => [n.name, n.name]));
  } else for (const id of ['kind','module','package']) setOptions(id, []);
  applyTheme(document.documentElement.dataset.theme); applyPanels(); renderStatus(); render(); save();
}
function renderStatus() {
  const status = $('status'); status.textContent = text(state.status); status.title = text(state.status); status.dataset.status = state.status;
  const diagnostics = $('diagnostics'); diagnostics.hidden = !state.diagnostics.length; $('diagnostic-count').textContent = String(state.diagnostics.length);
  if (state.status === 'error' && !state.graph && state.diagnostics.length) diagnostics.open = true;
  const list = diagnostics.querySelector('ul'); list.replaceChildren();
  for (const d of state.diagnostics) {
    const message = d.code && d.message?.startsWith(`${d.code}:`) ? d.message.slice(d.code.length + 1).trim() : d.message;
    const item = el('li'); if (d.code) item.append(el('strong', d.code)); item.append(el('span', message));
    if (d.source_ref?.source_id) item.append(el('small', `${d.source_ref.source_id}:${d.source_ref.start_line + 1}`));
    list.append(item);
  }
  $('project-name').textContent = state.graph?.name ?? '';
}
function applyPanels() {
  const main = $('layout'); main.dataset.resources = prefs.resources ? 'open' : 'closed'; main.dataset.detail = prefs.detail ? 'open' : 'closed';
  document.documentElement.dataset.level = prefs.level;
  $('show-resources').hidden = prefs.resources; $('show-detail').hidden = prefs.detail;
  const focused = !prefs.resources && !prefs.detail, focus = $('focus-mode');
  focus.setAttribute('aria-pressed', String(focused)); focus.dataset.i18nLabel = focused ? 'exitFocus' : 'focusMode';
  focus.setAttribute('aria-label', text(focus.dataset.i18nLabel).replace(/\s{2}.*$/u, '')); focus.title = text(focus.dataset.i18nLabel);
  uiIcon(focused ? 'collapse' : 'expand', focus.querySelector('svg'));
  $('filters').open = prefs.filters;
  for (const group of document.querySelectorAll('[data-pref]')) for (const b of group.querySelectorAll('button')) {
    const pressed = group.dataset.pref === 'panels' ? prefs[b.dataset.value] : prefs[group.dataset.pref] === b.dataset.value;
    b.setAttribute('aria-pressed', String(pressed));
  }
}
function setPanel(name, open) { prefs[name] = open; applyPanels(); savePrefs(); }
function applyTheme(theme) {
  const button = $('theme'), label = text(theme === 'dark' ? 'themeLight' : 'themeDark');
  document.documentElement.dataset.theme = theme; button.setAttribute('aria-pressed', String(theme === 'dark')); button.setAttribute('aria-label', label); button.title = label;
}
function selectNode(id, center = false) { selected = id; selectedEdge = null; render(); if (center) centerSelection(); save(); }
function clearSelection() { if (!selected && !selectedEdge) return; selected = null; selectedEdge = null; box = null; render(); save(); }
function toggleNode(id, center = false) { if (selected === id && !selectedEdge) clearSelection(); else selectNode(id, center); }
function revealNode(id) {
  const node=nodeById(id); if (!node) return;
  for (const field of ['search','kind','module','package']) $(field).value='';
  $('direction').value='all'; $('group').checked=false; $('diagnostic-only').checked=false;
  view=viewForNode(node); box=null; selectNode(id,true);
}
function centerSelection() {
  const p = layout?.positions.get(selected); if (!p) return;
  const r = $('graph').getBoundingClientRect(); if (!r.width || !r.height) return;
  box = { x:p.x + layout.nodeWidth / 2 - r.width / 2, y:p.y + layout.nodeHeight / 2 - r.height / 2, w:r.width, h:r.height }; autoFit = false; applyBox();
}
function renderList(focusId) {
  const list = $('resource-list'); list.replaceChildren();
  for (const n of rendered.nodes) {
    const b = el('button'); b.type = 'button'; b.addEventListener('click', () => toggleNode(n.id, true));
    b.dataset.resourceId = n.id; b.dataset.kind = n.kind; b.dataset.family = family(n.kind); b.dataset.kindLabel = kindText(n.kind);
    b.setAttribute('aria-pressed', String(selected === n.id)); b.title = `${kindText(n.kind)} · ${n.name}`;
    const mark = svg('svg', { viewBox:'0 0 24 24',class:'icon-small','aria-hidden':'true' }); mark.append(svg('path', { d:icon(n.kind) }));
    b.append(mark, el('span', nodeLabel(n))); const li = el('li'); li.append(b); list.append(li);
  }
  if (focusId) [...list.querySelectorAll('button')].find(b => b.dataset.resourceId === focusId)?.focus({ preventScroll:true });
}
function renderLegend() {
  const legend = $('legend'); legend.replaceChildren();
  if (rendered.total > 200) { legend.dataset.state = 'limited'; legend.append(el('span', text('limited'))); return; }
  delete legend.dataset.state;
  for (const [kind, key] of [['structure','legendStructure'],['authority','legendAuthority']]) {
    const sample = svg('svg', { viewBox:'0 0 28 8',class:`legend-line ${kind}`,'aria-hidden':'true' }); sample.append(svg('path', { d:'M1 4h26' }));
    const item = el('span', undefined, 'legend-item'); item.append(sample, el('span', text(key))); legend.append(item);
  }
}
function filterCount() {
  const active = ['kind','module','package'].filter(id => $(id).value).length + ($('diagnostic-only').checked ? 1 : 0);
  $('filter-count').hidden = !active; $('filter-count').textContent = String(active);
}
function render() {
  const graph = state.graph;
  const focusId = document.activeElement?.dataset.resourceId;
  for (const b of document.querySelectorAll('[data-view]')) b.setAttribute('aria-pressed', String(b.dataset.view === view));
  $('group').disabled = view !== 'architecture';
  rendered = visibleGraph(graph, options());
  renderList(focusId); filterCount(); renderLegend();
  $('count').textContent = `${rendered.total} ${text('count')}`;
  const visible = rendered.nodes.slice(0, 200);
  if (selected && !visible.some(n=>n.id===selected)) { const chosen=rendered.nodes.find(n=>n.id===selected); if(chosen)visible.splice(199,1,chosen); }
  const ids = new Set(visible.map(n => n.id));
  const edges = rendered.edges.filter(e => ids.has(e.from) && ids.has(e.to));
  layout = layoutGraph(visible, edges, { direction:prefs.orientation, density:prefs.density, wrap:columnsFor(visible.length) });
  drawGraph(visible, edges);
  $('empty').hidden = Boolean(visible.length); $('empty').textContent = !graph && state.status === 'error' ? text('errorEmpty') : text('empty');
  $('export').disabled = $('export-png').disabled = !visible.length;
  if (!box || autoFit) fit(); else applyBox(); renderDetails();
}
// Choose how many nodes share a line so the layout roughly matches the canvas shape.
function columnsFor(count) {
  const rect = $('graph').getBoundingClientRect(), ratio = rect.width && rect.height ? rect.width / rect.height : 1.4;
  const size = LAYOUT_SIZES[prefs.density], vertical = prefs.orientation !== 'horizontal';
  const cross = vertical ? size.width + size.rowGap : size.height + size.sideRowGap, along = vertical ? size.height + size.lineGap : size.width + size.lineGap;
  return Math.min(12, Math.max(3, Math.round(Math.sqrt((vertical ? ratio : 1 / ratio) * count * along / cross))));
}
function drawGraph(visible, edges) {
  const W = layout.nodeWidth, H = layout.nodeHeight, vertical = layout.direction === 'vertical', compact = prefs.density === 'compact';
  const graphEl = $('graph'), drawing = $('drawing'); drawing.replaceChildren();
  const hasSelection = Boolean(selected && visible.some(n => n.id === selected));
  const related = new Set(hasSelection ? [selected, ...edges.flatMap(e => e.from === selected ? [e.to] : e.to === selected ? [e.from] : [])] : []);
  graphEl.dataset.labels = prefs.labels; graphEl.dataset.density = prefs.density; graphEl.classList.toggle('has-selection', hasSelection);
  const defs = svg('defs');
  for (const [id, className] of [['arrow','arrow'],['arrow-authority','arrow authority']]) {
    const marker = svg('marker', { id,viewBox:'0 0 10 10',refX:9,refY:5,markerWidth:7,markerHeight:7,orient:'auto-start-reverse' }); marker.append(svg('path', { d:'M0 0 10 5 0 10z',class:className })); defs.append(marker);
  }
  const edgeLayer = svg('g', { class:'edges' }), labelLayer = svg('g', { class:'edge-labels' }), nodeLayer = svg('g', { class:'nodes' });
  drawing.append(defs, edgeLayer, labelLayer, nodeLayer);
  const placed = visible.map(n => { const p = layout.positions.get(n.id); return { x:p.x - 4, y:p.y - 4, w:W + 8, h:H + 8 }; });
  const overlaps = r => placed.some(o => r.x < o.x + o.w && r.x + r.w > o.x && r.y < o.y + o.h && r.y + r.h > o.y);
  const pairs = new Map(); for (const e of edges) { const key = [e.from, e.to].sort().join('\u0000'); pairs.set(key, (pairs.get(key) ?? 0) + 1); }
  const lanes = new Map();
  for (const e of edges) {
    const a = layout.positions.get(e.from), b = layout.positions.get(e.to);
    const key = [e.from, e.to].sort().join('\u0000'), lane = lanes.get(key) ?? 0; lanes.set(key, lane + 1);
    const shift = (lane - (pairs.get(key) - 1) / 2) * 18;
    let p0, c1, c2, p3;
    if (vertical) {
      p0 = [a.x + W / 2 + shift, a.y + H]; p3 = [b.x + W / 2 + shift, b.y];
      const bend = p3[1] > p0[1] ? (p3[1] - p0[1]) / 2 : 70 + lane * 18; c1 = [p0[0], p0[1] + bend]; c2 = [p3[0], p3[1] - bend];
    } else {
      p0 = [a.x + W, a.y + H / 2 + shift]; p3 = [b.x, b.y + H / 2 + shift];
      const bend = p3[0] > p0[0] ? (p3[0] - p0[0]) / 2 : 80 + lane * 18; c1 = [p0[0] + bend, p0[1]]; c2 = [p3[0] - bend, p3[1]];
    }
    const authority = ['uses','callable_by','requires','memory_scope','memory_access'].includes(e.kind);
    const touches = related.has(e.from) && related.has(e.to) && (e.from === selected || e.to === selected);
    const classes = `edge${selectedEdge?.id === e.id ? ' selected' : ''}${touches ? ' related' : ''}${hasSelection && !touches ? ' muted' : ''}`;
    const g = svg('g', { class:classes,'data-kind':e.kind,tabindex:0,role:'button','aria-label':`${labelOf(e.from)} ${edgeText(e)} ${labelOf(e.to)}` });
    g.append(svg('path', { class:'hit',d:`M${p0} C${c1} ${c2} ${p3}` }), svg('path', { class:'line',d:`M${p0} C${c1} ${c2} ${p3}`,'marker-end':`url(#${authority ? 'arrow-authority' : 'arrow'})` }));
    const pick = () => { if (selectedEdge?.id === e.id) { clearSelection(); return; } selectedEdge = e; selected = null; render(); };
    g.addEventListener('click', pick); g.addEventListener('keydown', event => { if (['Enter',' '].includes(event.key)) { event.preventDefault(); pick(); } });
    edgeLayer.append(g);
    if ((e.kind === 'flow' && e.role === 'next') || ['contains','entry'].includes(e.kind)) continue;
    const label = edgeText(e), width = label.length * 5.7 + 16, mid = [0, 1].map(i => (p0[i] + 3 * c1[i] + 3 * c2[i] + p3[i]) / 8);
    let spot = { x:mid[0] - width / 2, y:mid[1] - 9 + (vertical ? 0 : -14), w:width, h:18 };
    search: for (const dx of [0, width / 2 + 16, -width / 2 - 16]) for (const dy of [0, 22, -22, 44, -44, 66, -66]) {
      const trial = { ...spot, x:mid[0] - width / 2 + dx, y:mid[1] - 9 + dy }; if (!overlaps(trial)) { spot = trial; break search; }
    }
    placed.push(spot);
    const tag = svg('g', { class:`edge-label${g.getAttribute('class').replace(/^edge/u, '')}`,transform:`translate(${spot.x + width / 2} ${spot.y + 9})`,'data-kind':e.kind });
    tag.append(svg('rect', { x:-width / 2,y:-9,width,height:18,rx:9 }), svg('text', { y:3.5,'text-anchor':'middle' }, label));
    tag.addEventListener('click', pick);
    for (const [type, on] of [['pointerenter', true], ['pointerleave', false]]) { g.addEventListener(type, () => tag.classList.toggle('hover', on)); tag.addEventListener(type, () => { tag.classList.toggle('hover', on); g.classList.toggle('hover', on); }); }
    labelLayer.append(tag);
  }
  const tile = compact ? 30 : 36, pad = 12, maxChars = Math.floor((W - pad - tile - 22) / (compact ? 6.9 : 7.4));
  for (const n of visible) {
    const p = layout.positions.get(n.id);
    const g = svg('g', { class:`node${selected === n.id ? ' selected' : ''}${hasSelection && !related.has(n.id) ? ' muted' : ''}`,transform:`translate(${p.x} ${p.y})`,tabindex:0,role:'button','aria-label':`${kindText(n.kind)} ${n.name}`,'data-id':n.id,'data-kind':n.kind,'data-family':family(n.kind) });
    g.append(svg('rect', { class:'card',width:W,height:H,rx:8 }), svg('title', {}, `${n.name}\n${n.id}`));
    const tileY = (H - tile) / 2, mark = svg('g', { transform:`translate(${pad + (tile - 24 * tile / 36) / 2} ${tileY + (tile - 24 * tile / 36) / 2}) scale(${tile / 36})`,class:'icon' });
    mark.append(svg('path', { d:icon(n.kind) }));
    const label = nodeLabel(n), subtitle = nodeSubtitle(n), textX = pad + tile + 12;
    g.append(svg('rect', { class:'tile',x:pad,y:tileY,width:tile,height:tile,rx:8 }), mark,
      svg('text', { x:textX,y:H / 2 - (compact ? 2 : 3),class:'title' }, label.length > maxChars ? `${label.slice(0, maxChars - 1)}…` : label),
      svg('text', { x:textX,y:H / 2 + (compact ? 13 : 15),class:'kind' }, subtitle.length > maxChars + 8 ? `${subtitle.slice(0, maxChars + 7)}…` : subtitle));
    g.addEventListener('click', event => { if (event.detail < 2) toggleNode(n.id); }); g.addEventListener('dblclick', event => { event.stopPropagation(); expand(n); });
    g.addEventListener('keydown', event => { if (['Enter',' '].includes(event.key)) { event.preventDefault(); toggleNode(n.id); } });
    nodeLayer.append(g);
  }
}
function expand(n) {
  if (n.kind === 'module') { $('module').value = n.id; $('group').checked = false; }
  else if (n.kind === 'package') $('package').value = n.name;
  else { selected = n.id; view = 'flow'; $('direction').value = 'outgoing'; }
  box = null; render(); save();
}
// Essential reading folds what only matters to someone reading the AIR or the package contract.
const technicalFields = new Set(['signature','type_ref','result_binding','condition_ref','collection_ref','item_binding','arguments','context','payload','constraints','default','min_length','max_length','format','min','max','value','limits','entrypoint','entrypoints','exports','dependencies','engines','hosts','touba','runtime_compatibility','air_profile','content_types','max_bytes','map','path','language','distinct_from','exclude_signers']);
function detailValue(key, value) {
  if (key === 'boundary') return el('p', text('boundaryValue'), 'prose');
  if (typeof value?.expression === 'string') return el('pre', value.expression, 'declared-expression');
  if (key === 'default' && value?.present === false) return el('code', 'none');
  if (key === 'default' && value?.present === true) return detailValue(key, value.value);
  if (value === null || ['string','number','boolean'].includes(typeof value)) {
    const target = /_ref$/u.test(key) ? nodeById(value) : null;
    if (target) { const link = button(nodeLabel(target), () => revealNode(target.id)); link.className = 'link-button'; return link; }
    const shown = key === 'type_ref' ? typeName(value) : key === 'entrypoint' ? (lang === 'fr' ? 'Oui' : 'Yes') : /_ms$/u.test(key) ? duration(value) : /_ref$|_binding$/u.test(key) ? refName(value) : String(value);
    return el(typeof value === 'string' && value.length > 60 ? 'p' : 'span', shown, typeof value === 'string' && value.length > 60 ? 'prose' : 'value');
  }
  if (Array.isArray(value)) {
    const items = el('div', undefined, value.some(item => item && typeof item === 'object') ? 'detail-items' : 'pills');
    for (const item of value) {
      if (item && typeof item === 'object') {
        const card = el('div', undefined, 'detail-item');
        if (item.name) card.append(el('h4', `${item.name}${item.type_ref ? ` · ${typeName(item.type_ref)}` : ''}`));
        const remaining = Object.fromEntries(Object.entries(item).filter(([field]) => !item.name || !['name', 'type_ref'].includes(field)));
        card.append(detailValue(key, remaining)); items.append(card);
      } else {
        const target = nodeById(item);
        if (target) { const link = button(nodeLabel(target), () => revealNode(target.id)); link.className = 'pill link-pill'; items.append(link); }
        else items.append(el('span', String(item), 'pill'));
      }
    }
    return items;
  }
  // AIR run limits carry provenance alongside their value. Keep that contract
  // intact and unwrap only this known field when presenting the limit.
  return factsList(Object.entries(value ?? {}).filter(([subKey, subValue]) => subKey !== 'source_ref' && subValue !== undefined).map(([subKey, subValue]) => [subKey, key === 'budgets' ? subValue.value : subValue]));
}
function factsList(entries) {
  const list = el('dl', undefined, 'props');
  for (const [key, value] of entries) { const row = el('div', undefined, 'prop'), detail = el('dd'); detail.append(detailValue(key, value)); row.append(el('dt', fieldText(key)), detail); list.append(row); }
  return list;
}
async function copyText(value, node) {
  try { await navigator.clipboard.writeText(value); }
  catch { $('status').textContent = text('copyFailed'); return; }
  const show = (name, key) => { uiIcon(name, node.querySelector('svg')); node.setAttribute('aria-label', text(key)); node.title = text(key); node.classList.toggle('done', key === 'copied'); };
  show('check', 'copied'); setTimeout(() => show('copy', 'copy'), 1400);
}
function emptyDetail() {
  const node = el('div', undefined, 'detail-empty'), mark = el('span', undefined, 'empty-mark'), keys = el('ul', undefined, 'shortcuts');
  mark.append(uiIcon('pointer'));
  for (const [caps, key] of [[['['], 'shortcutResources'], [[']'], 'shortcutDetails'], [['\\'], 'shortcutFocus'], [['0', '+', '−'], 'shortcutGraph'], [[text('escape')], 'shortcutClear']]) {
    const li = el('li'), group = el('span', undefined, 'keys'); for (const cap of caps) group.append(el('kbd', cap));
    li.append(el('span', text(key)), group); keys.append(li);
  }
  node.append(mark, el('h2', text('details')), el('p', text('select'), 'muted'), el('p', text('hint'), 'muted empty-hint'), el('p', text('shortcutsTitle'), 'shortcuts-title'), keys);
  return node;
}
function renderDetails() {
  const panel = $('detail'); panel.replaceChildren();
  const node = nodeById(selected), essential = prefs.level === 'essential';
  const section = (title, content, target = panel) => { const block = el('section', undefined, 'detail-section'); block.append(el('h3', title), content); target.append(block); };
  if (selectedEdge) {
    const head = el('div', undefined, 'detail-head'), meta = el('div', undefined, 'detail-meta');
    meta.append(el('span', `${labelOf(selectedEdge.from)} → ${labelOf(selectedEdge.to)}`));
    head.append(el('h2', edgeText(selectedEdge)), meta); panel.append(head);
    if (selectedEdge.aggregated) panel.append(el('p', text('aggregate'), 'note'));
    const actions = el('div', undefined, 'detail-actions');
    for (const id of [selectedEdge.from, selectedEdge.to]) actions.append(button(labelOf(id), () => revealNode(id)));
    panel.append(actions);
    return;
  }
  if (!node) { panel.append(emptyDetail()); return; }
  const head = el('div', undefined, 'detail-head'), top = el('div', undefined, 'head-top'), meta = el('div', undefined, 'detail-meta');
  const mark = svg('svg', { viewBox:'0 0 24 24',class:'detail-icon','aria-hidden':'true' }); mark.append(svg('path', { d:icon(node.kind) }));
  head.dataset.family = family(node.kind); top.append(mark); meta.append(el('span', kindText(node.kind), 'category-badge'));
  if (node.graph && nodeById(node.owner)) meta.append(el('span', nodeById(node.owner).name));
  head.append(top, el('h2', nodeLabel(node)), meta); panel.append(head);
  const actions = el('div', undefined, 'detail-actions');
  if (['module','package'].includes(node.kind) || state.graph.edges.some(e => e.kind === 'entry' && e.from === node.id)) actions.append(button(text('expand'), () => expand(node), 'open'));
  if (node.source_ref) actions.append(button(text('source'), () => openSource(node.id), 'code'));
  if (actions.children.length) panel.append(actions);
  const shown = { prose:[], rows:[], sections:[] }, folded = { prose:[], rows:[], sections:[] };
  for (const [key, value] of Object.entries(node.details ?? {})) {
    if (value === undefined) continue;
    const bucket = essential && technicalFields.has(key) ? folded : shown;
    const scalar = value === null || ['number','boolean'].includes(typeof value) || (typeof value === 'string' && value.length <= 60) || (Array.isArray(value) && !value.some(item => item && typeof item === 'object'));
    if (key === 'signature') bucket.sections.push([fieldText(key), el('pre', `${(value.inputs ?? []).map(i => `${i.name}: ${typeName(i.type_ref)}`).join('\n')}\n→ ${typeName(value.output_type)}`, 'signature')]);
    else if (key === 'boundary' || typeof value === 'string' && value.length > 60) bucket.prose.push([fieldText(key), detailValue(key, value)]);
    else if (scalar) bucket.rows.push([key, value]);
    else bucket.sections.push([fieldText(key), detailValue(key, value)]);
  }
  const origin = node.source_ref && `${node.source_ref.source_id}:${node.source_ref.start_line + 1}`;
  const place = (bucket, target) => {
    for (const [title, content] of bucket.prose) section(title, content, target);
    if (bucket.rows.length) section(text('properties'), factsList(bucket.rows), target);
    for (const [title, content] of bucket.sections) section(title, content, target);
  };
  place(shown, panel);
  const originList = origin && el('dl', undefined, 'props');
  if (originList) {
    const row = el('div', undefined, 'prop'), path = el('dd'), tools = el('span', undefined, 'prop-tools'), copy = el('button', undefined, 'tool copy');
    copy.type = 'button'; copy.append(uiIcon('copy')); copy.setAttribute('aria-label', text('copy')); copy.title = text('copy'); copy.addEventListener('click', () => void copyText(origin, copy));
    path.append(el('span', origin, 'path')); tools.append(copy); row.append(el('dt', text('file')), path, tools); originList.append(row);
    if (!essential) section(text('origin'), originList);
  }
  const touching = state.graph.edges.filter(e => e.from === node.id || e.to === node.id);
  if (touching.length) {
    const block = el('section', undefined, 'detail-section'); block.append(el('h3', text('relations'))); panel.append(block);
    for (const [outgoing, key] of [[true,'outgoingRelations'],[false,'incomingRelations']]) {
      const group = touching.filter(e => (e.from === node.id) === outgoing); if (!group.length) continue;
      block.append(el('p', text(key), 'relation-group'));
      const list = el('ul', undefined, 'relations');
      for (const e of group) {
        const target = nodeById(outgoing ? e.to : e.from), li = el('li');
        li.append(el('small', `${outgoing ? '→' : '←'} ${edgeText(e)}`), button(target ? nodeLabel(target) : '?', () => target && revealNode(target.id)));
        list.append(li);
      }
      block.append(list);
    }
  }
  if (essential && (folded.prose.length || folded.rows.length || folded.sections.length || originList)) {
    const technical = el('details', undefined, 'technical'), title = el('summary'), body = el('div', undefined, 'technical-body');
    title.append(uiIcon('code'), el('span', text('technicalData'))); place(folded, body);
    if (originList) section(text('origin'), originList, body);
    technical.append(title, body); panel.append(technical);
  }
}
function applyBox() { if (box) $('graph').setAttribute('viewBox', `${box.x} ${box.y} ${box.w} ${box.h}`); save(); }
function fit() {
  if (!layout) return;
  const rect = $('graph').getBoundingClientRect(); if (!rect.width || !rect.height) return;
  const ratio = rect.width / rect.height, margin = 24;
  // Never enlarge beyond 1:1, otherwise a single grouped module fills the whole canvas.
  const width = Math.max(layout.width + margin * 2, (layout.height + margin * 2) * ratio, rect.width), height = width / ratio;
  box = { x:(layout.width-width)/2,y:(layout.height-height)/2,w:width,h:height }; autoFit = true; applyBox();
}
function zoom(factor, anchor) {
  if (!box) return;
  const w = Math.min(30000,Math.max(160,box.w*factor)), h = box.h*w/box.w;
  const ax = anchor?.x ?? box.x + box.w / 2, ay = anchor?.y ?? box.y + box.h / 2;
  box = { x:ax-(ax-box.x)*w/box.w,y:ay-(ay-box.y)*h/box.h,w,h }; autoFit = false; applyBox();
}
function graphPoint(event) { const r = $('graph').getBoundingClientRect(); return { x:box.x + (event.clientX - r.left) * box.w / r.width, y:box.y + (event.clientY - r.top) * box.h / r.height }; }
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
function toggleDisplay(open = $('display-panel').hidden) { $('display-panel').hidden = !open; $('display-toggle').setAttribute('aria-expanded', String(open)); }
for (const target of document.querySelectorAll('svg[data-icon]')) uiIcon(target.dataset.icon, target);
$('language').addEventListener('change', () => { lang=$('language').value; translate(); });
$('theme').addEventListener('click', () => { prefs.theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'; applyTheme(prefs.theme); savePrefs(); });
const vscodeDark = document.body.classList.contains('vscode-dark') || (document.body.classList.contains('vscode-high-contrast') && !document.body.classList.contains('vscode-high-contrast-light'));
applyTheme(prefs.theme ?? (vscodeDark || matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
for (const id of ['search','kind','module','package','group','direction','depth','diagnostic-only']) $(id).addEventListener(id === 'search' ? 'input' : 'change', () => { box=null; render(); });
for (const b of document.querySelectorAll('[data-view]')) b.addEventListener('click', () => { view=b.dataset.view; selectedEdge=null; box=null; render(); save(); });
$('reset').addEventListener('click', () => { for (const id of ['search','kind','module','package']) $(id).value=''; $('direction').value='all'; $('group').checked=true; $('diagnostic-only').checked=false; selected=null; selectedEdge=null; box=null; render(); save(); });
$('fit').addEventListener('click', fit); $('zoom-in').addEventListener('click', () => zoom(.8)); $('zoom-out').addEventListener('click', () => zoom(1.25));
$('fullscreen').addEventListener('click', async () => { try { if (document.fullscreenElement) await document.exitFullscreen(); else await document.querySelector('.workspace').requestFullscreen(); fit(); } catch { $('fullscreen').disabled=true; } });
$('close-source').addEventListener('click', () => $('source-dialog').close());
function exportSvg() {
  const clone=$('graph').cloneNode(true); clone.setAttribute('width',String(layout.width)); clone.setAttribute('height',String(layout.height)); clone.setAttribute('viewBox',`0 0 ${layout.width} ${layout.height}`);
  const sourceNodes=$('graph').querySelectorAll('*'), cloneNodes=clone.querySelectorAll('*');
  sourceNodes.forEach((node,i) => {
    const style=getComputedStyle(node);
    for (const key of ['fill','fill-opacity','stroke','stroke-opacity','stroke-width','stroke-dasharray','stroke-linecap','stroke-linejoin','opacity','font-family','font-size','font-weight','paint-order']) cloneNodes[i].setAttribute(key,style.getPropertyValue(key));
    if (node.classList.contains('muted')) cloneNodes[i].setAttribute('opacity','1');
  });
  clone.prepend(svg('rect',{width:layout.width,height:layout.height,fill:getComputedStyle(document.documentElement).getPropertyValue('--touba-background').trim()}));
  return new XMLSerializer().serializeToString(clone);
}
function download(blob, name) { const url=URL.createObjectURL(blob), a=el('a'); a.href=url; a.download=name; a.click(); setTimeout(() => URL.revokeObjectURL(url),1000); }
async function exportPng() {
  const content = exportSvg(), scale = Math.min(2, 8000 / Math.max(layout.width, layout.height));
  const url = URL.createObjectURL(new Blob([content], { type:'image/svg+xml' })), image = new Image();
  try {
    await new Promise((resolve, reject) => { image.onload = resolve; image.onerror = reject; image.src = url; });
    const canvas = el('canvas'); canvas.width = Math.ceil(layout.width * scale); canvas.height = Math.ceil(layout.height * scale);
    const context = canvas.getContext('2d'); context.scale(scale, scale); context.drawImage(image, 0, 0, layout.width, layout.height);
    const blob = await new Promise((resolve, reject) => canvas.toBlob(result => result ? resolve(result) : reject(new Error('PNG')), 'image/png'));
    if (!vscode) { download(blob, 'touba-project.png'); return; }
    const bytes = new Uint8Array(await blob.arrayBuffer()); let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    vscode.postMessage({ type:'export-png', content:btoa(binary) });
  } catch { $('status').textContent = text('exportError'); } finally { URL.revokeObjectURL(url); }
}
$('export').addEventListener('click', () => {
  const content = exportSvg();
  if (vscode) { vscode.postMessage({ type:'export',content }); return; }
  download(new Blob([content],{type:'image/svg+xml'}), 'touba-project.svg');
});
$('export-png').addEventListener('click', exportPng);
$('hide-resources').addEventListener('click', () => setPanel('resources', false)); $('show-resources').addEventListener('click', () => setPanel('resources', true));
$('hide-detail').addEventListener('click', () => setPanel('detail', false)); $('show-detail').addEventListener('click', () => setPanel('detail', true));
$('focus-mode').addEventListener('click', () => { const open = !prefs.resources && !prefs.detail; prefs.resources = open; prefs.detail = open; applyPanels(); savePrefs(); });
$('filters').addEventListener('toggle', () => { if (prefs.filters !== $('filters').open) { prefs.filters = $('filters').open; savePrefs(); } });
$('display-toggle').addEventListener('click', event => { event.stopPropagation(); toggleDisplay(); });
document.addEventListener('click', event => { if (!$('display-panel').hidden && !event.target.closest('.menu')) toggleDisplay(false); });
for (const group of document.querySelectorAll('[data-pref]')) for (const b of group.querySelectorAll('button')) b.addEventListener('click', () => {
  const pref = group.dataset.pref;
  if (pref === 'panels') { setPanel(b.dataset.value, !prefs[b.dataset.value]); return; }
  prefs[pref] = b.dataset.value; if (!['labels','level'].includes(pref)) box = null; applyPanels(); savePrefs(); render();
  // An embedding host shares one detail level across its pages.
  if (pref === 'level') embeddedHost?.postMessage({ type:'preferences', level:prefs.level });
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && !$('display-panel').hidden) { toggleDisplay(false); $('display-toggle').focus(); return; }
  if (event.metaKey || (event.ctrlKey && !event.altKey) || $('source-dialog').open || event.target.closest('input,select,textarea')) return;
  const actions = { '[':() => setPanel('resources', !prefs.resources), ']':() => setPanel('detail', !prefs.detail), '\\':() => $('focus-mode').click(), '0':fit, '+':() => zoom(.8), '=':() => zoom(.8), '-':() => zoom(1.25), Escape:clearSelection };
  if (actions[event.key]) { event.preventDefault(); actions[event.key](); }
});
let drag;
$('graph').addEventListener('pointerdown', event => { if (event.target.closest('.node,.edge,.edge-label') || !box) return; drag={x:event.clientX,y:event.clientY,box:{...box}}; $('graph').setPointerCapture(event.pointerId); });
$('graph').addEventListener('pointermove', event => { if (!drag) return; const r=$('graph').getBoundingClientRect(); box={...drag.box,x:drag.box.x-(event.clientX-drag.x)*drag.box.w/r.width,y:drag.box.y-(event.clientY-drag.y)*drag.box.h/r.height}; autoFit=false; applyBox(); });
$('graph').addEventListener('pointerup', () => { drag=null; }); $('graph').addEventListener('pointercancel', () => { drag=null; });
$('graph').addEventListener('dblclick', event => { if (!event.target.closest('.node,.edge,.edge-label')) fit(); });
$('graph').addEventListener('wheel', event => { event.preventDefault(); if (box) zoom(event.deltaY>0?1.1:.9, graphPoint(event)); }, {passive:false});
let resizeFrame;
new ResizeObserver(() => {
  if (!box || autoFit) { cancelAnimationFrame(resizeFrame); resizeFrame = requestAnimationFrame(() => { if (state.graph) render(); else fit(); }); return; }
  const r = $('graph').getBoundingClientRect(); if (!r.width || !r.height) return;
  const w = box.h * r.width / r.height; if (Math.abs(w - box.w) < 0.5) return;
  box = { ...box, x:box.x + (box.w - w) / 2, w }; applyBox();
}).observe($('canvas-wrap'));
translate();
if (vscode) {
  window.addEventListener('message', event => {
    if (embeddedHost && (event.source !== window.parent || event.origin !== location.origin)) return;
    const message=event.data;
    if (message?.type==='preferences' && embeddedHost) {
      if (['fr','en'].includes(message.lang)) { lang=message.lang; $('language').value=lang; translate(); }
      if (['light','dark'].includes(message.theme)) applyTheme(message.theme);
      if (['essential','complete'].includes(message.level) && message.level !== prefs.level) { prefs.level = message.level; applyPanels(); render(); }
    }
    if (message?.type==='state') receive(message.state);
    if (message?.type==='select') revealNode(message.id);
    if (message?.type==='source') showSource(message.source);
  });
  vscode.postMessage({type:'ready'});
} else poll();
