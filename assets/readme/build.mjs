#!/usr/bin/env node
// Regenerates the README visuals. The annotated program is read from the
// compiled example in README.md, so the picture cannot drift from the source.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const readme = readFileSync(resolve(here, '../../README.md'), 'utf8');
const block = readme.match(/<!-- touba-example: compile -->\n```touba\n(module shop\.refunds\n[\s\S]*?)```/);
if (!block) throw new Error('README.md: refunds example not found');
const source = block[1].replace(/\n$/, '').split('\n');

const themes = {
  light: { card: '#f6f8fa', border: '#d0d7de', rule: '#d8dee4', ink: '#1f2328', muted: '#59636e', faint: '#8c959f',
    keyword: '#2f63c6', string: '#0a7c66', type: '#9a6700', accent: '#2f63c6', band: 'rgba(47,99,198,0.09)',
    node: '#ffffff', dot: '#d0d7de' },
  dark: { card: '#161b22', border: '#30363d', rule: '#262c34', ink: '#e6edf3', muted: '#9198a1', faint: '#6e7681',
    keyword: '#7ea6ff', string: '#5fd4b3', type: '#e3b341', accent: '#7ea6ff', band: 'rgba(126,166,255,0.13)',
    node: '#0d1117', dot: '#3d444d' },
};
const mono = "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace";
const sans = "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Noto Sans', Helvetica, Arial, sans-serif";
const esc = text => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const declarations = new Set(['module', 'type', 'tool', 'skill', 'agent', 'strategy', 'trigger', 'memory', 'limits']);
const clauses = new Set(['description', 'takes', 'gives', 'requires', 'secrets', 'responsibility', 'uses',
  'callable_by', 'do', 'with', 'into', 'give', 'as', 'is', 'on', 'runs', 'strategy']);
const types = new Set(['Text', 'Int', 'Boolean', 'Approval']);

function tokens(line) {
  const result = [];
  const pattern = /"[^"]*"|human\.approve|[A-Za-z_][A-Za-z0-9_.]*|[^\sA-Za-z_"]+/g;
  let previous = null;
  for (const match of line.matchAll(pattern)) {
    const text = match[0];
    let kind = 'ink';
    if (text.startsWith('"')) kind = 'string';
    else if (text === 'human.approve') kind = 'builtin';
    else if (match.index === 0 && declarations.has(text)) kind = 'declaration';
    else if (previous && declarations.has(previous) && result.length === 1) kind = 'name';
    else if (clauses.has(text)) kind = 'keyword';
    else if (types.has(text)) kind = 'type';
    result.push({ text, column: match.index, kind });
    previous = text;
  }
  return result;
}

const annotations = [
  { from: /^\s+requires /, span: 2, title: 'Declared resources',
    detail: ['Network access and one named secret,', 'mediated by the runtime.'] },
  { from: /^\s+uses IssueRefund/, span: 2, title: 'Bounded at compile time',
    detail: ['Only declared capabilities, and only', 'from declared callers.'] },
  { from: /^\s+human\.approve/, span: 4, title: 'Human gate',
    detail: ['The run waits for a finance decision', 'attested by the host.'] },
  { from: /^\s+give receipt$/, span: 1, title: 'Traced end to end',
    detail: ['Each step is recorded with its', 'real caller and source span.'] },
];

function program(theme, narrow = false) {
  const c = themes[theme];
  const bar = 40, top = bar + 16, line = 21, fontSize = 13, char = 7.8;
  // Narrow screens drop line numbers and the note column; short labels sit inside the bands.
  const width = narrow ? 500 : 880, codeX = narrow ? 22 : 60, bandX = narrow ? 12 : 52;
  const codeRight = narrow ? width - 12 : 540, noteX = 584;
  const height = top + source.length * line + 18;
  const baseline = index => top + index * line + 15;
  const lineTop = index => top + index * line;
  const typing = [];
  let clock = 0.35;
  const parts = [];

  source.forEach((text, index) => {
    if (!narrow) parts.push(`<text class="n" x="44" y="${baseline(index)}">${index + 1}</text>`);
    if (!text.trim()) { clock += 0.05; return; }
    const spans = tokens(text).map(token =>
      `<tspan class="${token.kind}" x="${(codeX + token.column * char).toFixed(1)}">${esc(token.text)}</tspan>`).join('');
    parts.push(`<text y="${baseline(index)}">${spans}</text>`);
    const indent = text.length - text.trimStart().length;
    const length = text.length - indent;
    const x = codeX + indent * char - 1, w = Math.ceil(length * char + 3);
    const duration = Math.max(0.08, length * 0.0045);
    typing.push({ index, x, w, steps: length, delay: clock, duration });
    clock += duration + 0.03;
  });
  const typed = clock;

  const covers = typing.map(({ index, x, w, steps, delay, duration }) =>
    `<rect class="cover" x="${x}" y="${lineTop(index)}" width="${w}" height="${line}" style="transform:translateX(${w}px);animation:k${index} ${duration.toFixed(3)}s steps(${steps}) ${delay.toFixed(3)}s backwards"/>`);
  const keyframes = typing.map(({ index, w }) => `@keyframes k${index}{from{transform:translateX(0)}to{transform:translateX(${w}px)}}`);

  const notes = annotations.map((note, order) => {
    const start = source.findIndex(text => note.from.test(text));
    if (start < 0) throw new Error(`annotation anchor not found: ${note.title}`);
    const y = lineTop(start), h = note.span * line, middle = y + h / 2;
    const delay = (typed + 0.25 + order * 0.55).toFixed(2);
    if (narrow) return `<g class="reveal" style="animation-delay:${delay}s">
    <rect class="band" x="${bandX}" y="${y + 1}" width="${codeRight - bandX}" height="${h - 2}" rx="6"/>
    <text class="label" x="${codeRight - 10}" y="${y + 15}">${esc(note.title)}</text>
  </g>`;
    return `<g class="reveal" style="animation-delay:${delay}s">
    <rect class="band" x="${bandX}" y="${y + 1}" width="${codeRight - bandX}" height="${h - 2}" rx="6"/>
    <path class="link" d="M${codeRight + 6} ${middle} H${noteX - 14}"/>
    <circle class="mark" cx="${noteX - 8}" cy="${middle}" r="3.5"/>
    <text class="title" x="${noteX}" y="${middle - 13}">${esc(note.title)}</text>
    ${note.detail.map((text, row) => `<text class="detail" x="${noteX}" y="${middle + 5 + row * 17}">${esc(text)}</text>`).join('\n    ')}
  </g>`;
  });

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="title description">
  <title id="title">refunds.tb, an annotated Touba program</title>
  <desc id="description">${esc(source.join('\n'))}</desc>
  <style>
    text { font-family: ${mono}; font-size: ${fontSize}px; fill: ${c.ink}; }
    .n { fill: ${c.faint}; text-anchor: end; font-size: 12px; }
    .declaration, .builtin { fill: ${c.keyword}; font-weight: 700; }
    .keyword { fill: ${c.keyword}; }
    .name { font-weight: 700; }
    .string { fill: ${c.string}; }
    .type { fill: ${c.type}; }
    .file { fill: ${c.muted}; font-size: 12px; }
    .title { font-family: ${sans}; font-size: 13.5px; font-weight: 600; }
    .detail { font-family: ${sans}; font-size: 12.5px; fill: ${c.muted}; }
    .label { font-family: ${sans}; font-size: 12px; font-weight: 600; fill: ${c.accent}; text-anchor: end; }
    .cover { fill: ${c.card}; }
    .band { fill: ${c.band}; }
    .link { stroke: ${c.accent}; stroke-width: 1; stroke-dasharray: 2 3; opacity: 0.7; }
    .mark { fill: ${c.accent}; }
    .reveal { animation: reveal 0.5s ease-out backwards; }
    @keyframes reveal { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }
    ${keyframes.join('\n    ')}
    @media (prefers-reduced-motion: reduce) { .cover, .reveal { animation: none !important; } }
  </style>
  <defs><clipPath id="code"><rect x="${bandX - 4}" y="${bar}" width="${codeRight - bandX + 4}" height="${height - bar}"/></clipPath></defs>
  <rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" rx="14" fill="${c.card}" stroke="${c.border}"/>
  <path d="M1 ${bar} H${width - 1}" stroke="${c.rule}"/>
  <circle cx="22" cy="20" r="5" fill="${c.dot}"/><circle cx="40" cy="20" r="5" fill="${c.dot}"/><circle cx="58" cy="20" r="5" fill="${c.dot}"/>
  <text class="file" x="82" y="24">refunds.tb</text>
  ${parts.join('\n  ')}
  <g clip-path="url(#code)">
  ${covers.join('\n  ')}
  </g>
  ${notes.join('\n  ')}
</svg>
`;
}

const stages = [
  { label: '.tb source', detail: ['typed declarations', 'and workflows'], width: 144 },
  { label: 'compiler', detail: ['checks contracts', 'before execution'], width: 144 },
  { label: 'AIR', detail: ['intermediate', 'representation'], width: 136 },
  { label: 'runtime', detail: ['mediates calls, resources,', 'budgets and approvals'], width: 196 },
  { label: 'trace', detail: ['structured events', 'linked to source'], width: 160 },
];

function pipeline(theme) {
  const c = themes[theme];
  const width = 880, gap = (width - 2 - stages.reduce((sum, stage) => sum + stage.width, 0)) / (stages.length - 1);
  const y = 12, h = 84, cycle = 6;
  let x = 1;
  const boxes = stages.map((stage, index) => {
    const box = { ...stage, x, index };
    x += stage.width + gap;
    return box;
  });
  const middle = y + h / 2;
  const packetStart = boxes[0].x + boxes[0].width / 2, packetEnd = boxes[4].x + boxes[4].width / 2;
  const travel = cycle * 0.66;
  // Each stage lights up when the packet, drawn under the opaque boxes, passes its centre.
  const lightAt = box => ((box.x + box.width / 2 - packetStart) / (packetEnd - packetStart)) * travel - cycle * 0.13;
  const nodes = boxes.map(box => `<g class="stage" style="animation-delay:${lightAt(box).toFixed(2)}s">
    <rect class="node" x="${box.x}" y="${y}" width="${box.width}" height="${h}" rx="12"/>
    <text class="label" x="${box.x + box.width / 2}" y="${y + 33}">${esc(box.label)}</text>
    ${box.detail.map((text, row) => `<text class="detail" x="${box.x + box.width / 2}" y="${y + 56 + row * 16}">${esc(text)}</text>`).join('\n    ')}
  </g>`);
  const arrows = boxes.slice(1).map(box => {
    const end = box.x - 4, start = end - gap + 8;
    return `<path class="arrow" d="M${start} ${middle} H${end - 5}"/><path class="head" d="M${end - 6} ${middle - 4} L${end} ${middle} L${end - 6} ${middle + 4} Z"/>`;
  });
  const runtime = boxes[3], last = boxes[4];
  const laneX = runtime.x, laneW = last.x + last.width - runtime.x, laneY = y + h + 26;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${laneY + 44}" viewBox="0 0 ${width} ${laneY + 44}" role="img" aria-labelledby="title">
  <title id="title">A .tb source is checked by the compiler, compiled to AIR, executed by the runtime and recorded as a structured trace. The host supplies handlers, credentials and identity.</title>
  <style>
    text { font-family: ${sans}; fill: ${c.muted}; text-anchor: middle; }
    .label { font-family: ${mono}; font-size: 15px; font-weight: 600; fill: ${c.ink}; }
    .detail { font-size: 12px; }
    .node { fill: ${c.node}; stroke: ${c.border}; stroke-width: 1.2; }
    .stage .node { animation: lit ${cycle}s ease-in-out infinite; animation-delay: inherit; }
    @keyframes lit { 0%, 30%, 100% { stroke: ${c.border}; } 8%, 18% { stroke: ${c.accent}; } }
    .arrow { stroke: ${c.faint}; stroke-width: 1.4; fill: none; }
    .head { fill: ${c.faint}; }
    .packet { fill: ${c.accent}; animation: travel ${cycle}s linear infinite; }
    @keyframes travel { 0% { transform: translateX(0); } 66%, 100% { transform: translateX(${packetEnd - packetStart}px); } }
    .lane { fill: none; stroke: ${c.border}; stroke-dasharray: 4 4; }
    .lane-text { font-size: 12.5px; }
    .lane-text tspan.strong { fill: ${c.ink}; font-weight: 600; }
    @media (prefers-reduced-motion: reduce) { .stage .node, .packet { animation: none; } }
  </style>
  ${arrows.join('\n  ')}
  <circle class="packet" cx="${packetStart}" cy="${middle}" r="4"/>
  ${nodes.join('\n  ')}
  <path class="lane" d="M${runtime.x + runtime.width / 2} ${y + h} V${laneY}"/>
  <rect class="lane" x="${laneX}" y="${laneY}" width="${laneW - 1}" height="34" rx="10"/>
  <text class="lane-text" x="${laneX + laneW / 2}" y="${laneY + 21.5}"><tspan class="strong">host application</tspan> · handlers, credentials, identity</text>
</svg>
`;
}

function pipelineNarrow(theme) {
  const c = themes[theme];
  const width = 500, nodeW = 456, h = 58, gap = 26, cycle = 6, top = 1;
  const rows = stages.map((stage, index) => ({ ...stage, index, y: top + index * (h + gap) }));
  const axis = nodeW / 2, first = rows[0].y + h / 2, last = rows.at(-1).y + h / 2;
  const travel = cycle * 0.66;
  const lightAt = row => ((row.y + h / 2 - first) / (last - first)) * travel - cycle * 0.13;
  const runtime = rows[3], laneY = rows.at(-1).y + h + 30, height = laneY + 36;
  const nodes = rows.map(row => `<g class="stage" style="animation-delay:${lightAt(row).toFixed(2)}s">
    <rect class="node" x="1" y="${row.y}" width="${nodeW}" height="${h}" rx="12"/>
    <text class="label" x="20" y="${row.y + h / 2 + 5}">${esc(row.label)}</text>
    ${row.detail.map((text, line) => `<text class="detail" x="${nodeW - 18}" y="${row.y + 25 + line * 16}">${esc(text)}</text>`).join('\n    ')}
  </g>`);
  const arrows = rows.slice(1).map(row => {
    const end = row.y - 4;
    return `<path class="arrow" d="M${axis} ${end - gap + 8} V${end - 5}"/><path class="head" d="M${axis - 4} ${end - 6} L${axis} ${end} L${axis + 4} ${end - 6} Z"/>`;
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="title">
  <title id="title">A .tb source is checked by the compiler, compiled to AIR, executed by the runtime and recorded as a structured trace. The host supplies handlers, credentials and identity.</title>
  <style>
    text { font-family: ${sans}; fill: ${c.muted}; }
    .label { font-family: ${mono}; font-size: 15px; font-weight: 600; fill: ${c.ink}; }
    .detail { font-size: 12.5px; text-anchor: end; }
    .node { fill: ${c.node}; stroke: ${c.border}; stroke-width: 1.2; }
    .stage .node { animation: lit ${cycle}s ease-in-out infinite; animation-delay: inherit; }
    @keyframes lit { 0%, 30%, 100% { stroke: ${c.border}; } 8%, 18% { stroke: ${c.accent}; } }
    .arrow { stroke: ${c.faint}; stroke-width: 1.4; fill: none; }
    .head { fill: ${c.faint}; }
    .packet { fill: ${c.accent}; animation: travel ${cycle}s linear infinite; }
    @keyframes travel { 0% { transform: translateY(0); } 66%, 100% { transform: translateY(${last - first}px); } }
    .lane { fill: none; stroke: ${c.border}; stroke-dasharray: 4 4; }
    .lane-text { font-size: 12.5px; text-anchor: middle; }
    .lane-text tspan.strong { fill: ${c.ink}; font-weight: 600; }
    @media (prefers-reduced-motion: reduce) { .stage .node, .packet { animation: none; } }
  </style>
  ${arrows.join('\n  ')}
  <circle class="packet" cx="${axis}" cy="${first}" r="4"/>
  ${nodes.join('\n  ')}
  <path class="lane" d="M${nodeW} ${runtime.y + h / 2} H${width - 16} V${laneY}"/>
  <rect class="lane" x="1" y="${laneY}" width="${width - 2}" height="34" rx="10"/>
  <text class="lane-text" x="${width / 2}" y="${laneY + 21.5}"><tspan class="strong">host application</tspan> · handlers, credentials, identity</text>
</svg>
`;
}

// Brand monograms for AUTHORS.md: one solid tile that reads on both GitHub themes.
const authors = [['khadim-lo', 'KL'], ['soukaina-alaoui-ismaili', 'SA'], ['jean-sebastien-dessureault', 'JD']];
for (const [slug, initials] of authors) {
  writeFileSync(resolve(here, `author-${slug}.svg`), `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96" role="img" aria-label="${initials}">
  <rect width="96" height="96" rx="24" fill="#2f63c6"/>
  <text x="48" y="49" fill="#ffffff" font-family="${sans}" font-size="34" font-weight="650" letter-spacing="1" text-anchor="middle" dominant-baseline="central">${initials}</text>
</svg>
`);
}

for (const theme of Object.keys(themes)) {
  writeFileSync(resolve(here, `governed-agent-${theme}.svg`), program(theme));
  writeFileSync(resolve(here, `governed-agent-${theme}-narrow.svg`), program(theme, true));
  writeFileSync(resolve(here, `pipeline-${theme}.svg`), pipeline(theme));
  writeFileSync(resolve(here, `pipeline-${theme}-narrow.svg`), pipelineNarrow(theme));
}
console.log('README visuals written for', Object.keys(themes).join(' and '));
