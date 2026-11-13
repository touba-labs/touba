import { createHash } from 'node:crypto';
import { constants, openSync, closeSync, fstatSync, readSync, mkdtempSync, chmodSync, rmSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { join, resolve, extname, isAbsolute, relative, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { createSqliteTraceStore } from '../../../../runtime/touba-runtime/src/sqlite-trace-store.mjs';
import { validateTraceMachineContract, validateTraceMachineStream, validateTraceMachinePrefix, validateAirMachineContract } from '../../../../contracts/machine/contracts.mjs';
import { airDocumentDigest } from '../../../../runtime/touba-runtime/src/air-identity.mjs';
import { createTraceReference, traceJsonDigest } from '../../../../contracts/trace-reference.mjs';
import { readProjectSource } from '../explorer/project.mjs';
import { eventSummary, eventCategory, projectEvent, queryOptions, queryWhere, terminalTraceStatus } from './model.mjs';

const MAX_JSON = 16 * 1024 * 1024, MAX_EVENTS = 1000000, MAX_EXPORT = 8 * 1024 * 1024;
const hash = value => createHash('sha256').update(value).digest('hex');
function jsonFile(filename) {
  const fd = openSync(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_JSON) throw new Error('TraceJsonLimit: choose SQLite for traces larger than 16 MiB');
    const bytes = Buffer.alloc(MAX_JSON + 1); let size = 0;
    while (size < bytes.length) { const n = readSync(fd, bytes, size, bytes.length - size, size); if (!n) break; size += n; }
    if (size > MAX_JSON) throw new Error('TraceJsonLimit');
    return JSON.parse(bytes.subarray(0, size));
  } finally { closeSync(fd); }
}

/** Private, disposable metadata index. Original traces are opened read-only. */
export class TraceReader {
  constructor({ filename, root = process.cwd(), air, temporaryRoot } = {}) {
    if (typeof filename !== 'string' || !filename || filename.includes('\0')) throw new Error('TracePathRequired');
    this.root = resolve(root);
    this.temporaryRoot = temporaryRoot ?? tmpdir();
    this.filename = resolve(filename);
    this.air = air ? validateAirMachineContract(jsonFile(resolve(air))) : null;
    this.index = null; this.temporary = null; this.snapshot = null;
    if (extname(filename).toLowerCase() === '.json') {
      this.document = validateTraceMachineContract(jsonFile(this.filename));
      this.store = null;
    } else this.store = createSqliteTraceStore({ filename: this.filename, readOnly: true });
  }
  closeIndex() {
    this.index?.close(); this.index = null;
    if (this.temporary) rmSync(this.temporary, { recursive: true, force: true });
    this.temporary = null; this.snapshot = null;
  }
  close() { this.closeIndex(); this.store?.close(); }
  list({ after = '', runId, groupRuns = false, search = '', category = '' } = {}) {
    if (typeof after !== 'string' || after.length > 4096 || (runId !== undefined && (typeof runId !== 'string' || runId.length > 4096))) throw new Error('TraceSelectionInvalid');
    if (typeof groupRuns !== 'boolean' || typeof search !== 'string' || search.length > 256 || !['', 'refusal', 'error'].includes(category)) throw new Error('TraceSelectionInvalid');
    if (groupRuns && this.store) {
      const page = this.store.runPage({ after, search: runId ?? search, category });
      return { segments: page.runs.map(group => {
        if (group.segmentCount > 1000) throw new Error('TraceRunSegmentLimit');
        const segments = [...this.store.segments({ runId: group.runId, limit: 1000 })].map(item => this.segmentSummary(item));
        segments.sort((a, b) => a.start - b.start || a.id.localeCompare(b.id));
        const latest = segments.at(-1);
        return { ...latest, eventCount: group.eventCount, segments, segmentCount: group.segmentCount };
      }), next: page.next, grouped: true };
    }
    if (this.document) {
      const matches = (!runId || runId === this.document.run.run_id)
        && (!search || `${this.document.run.run_id} ${this.document.run.entry_ref ?? ''}`.toLowerCase().includes(search.toLowerCase()))
        && (!category || this.document.events.some(event => eventCategory(event.kind, event.payload) === category));
      return { segments: after || !matches ? [] : [{ id: 'document', runId: this.document.run.run_id, module: this.document.run.module_ref, entry: this.document.run.entry_ref, eventCount: this.document.events.length, start: this.document.events[0].sequence_index, closed: true }], next: null };
    }
    const segments = [...this.store.segments({ after, runId, limit: 100 })].map(item => {
      const snapshot = this.store.snapshot(item.id), header = snapshot.header;
      return { id: item.id, runId: item.runId, module: header.run.module_ref, entry: header.run.entry_ref,
        eventCount: item.eventCount, start: snapshot.startIndex, closed: item.complete };
    });
    return { segments, next: segments.length === 100 ? segments.at(-1).id : null };
  }
  segmentSummary(item) {
    const snapshot = this.store.snapshot(item.id), header = snapshot.header;
    const last = item.eventCount ? this.store.page(item.id, { after: snapshot.startIndex + item.eventCount - 2, limit: 1 }).events[0] : null;
    return { id: item.id, runId: item.runId, module: header.run.module_ref, entry: header.run.entry_ref,
      origin: this.store.origin(item.runId),
      eventCount: item.eventCount, start: snapshot.startIndex, closed: item.complete,
      status: header.run.admission === 'refused' ? 'refused' : terminalTraceStatus(last) };
  }
  select({ id } = {}) {
    if (typeof id !== 'string' || !id || id.length > 4096) throw new Error('TraceSelectionInvalid');
    this.closeIndex();
    if (this.document && id !== 'document') throw new Error('TraceSelectionInvalid');
    const source = this.document ? (() => {
      const { events, ...header } = this.document;
      return { header, startIndex: events[0].sequence_index, eventCount: events.length, complete: true,
        events: () => events.values(), json: function* () { yield JSON.stringify({ ...header, events }); } };
    })() : this.store.snapshot(id);
    if (source.eventCount > MAX_EVENTS) throw new Error('TraceIndexLimit: choose a segment of at most 1,000,000 events');
    // A closed reference also verifies a complete canonical stream and its digest.
    if (!this.document) (source.complete ? validateTraceMachineStream : validateTraceMachinePrefix)(source.header, source.events());
    this.snapshot = source;
    this.temporary = mkdtempSync(join(this.temporaryRoot, 'touba-trace-index-'));
    chmodSync(this.temporary, 0o700);
    const filename = join(this.temporary, 'index.sqlite');
    this.index = new DatabaseSync(filename); chmodSync(filename, 0o600);
    this.index.exec(`PRAGMA trusted_schema=OFF; PRAGMA page_size=4096; PRAGMA cache_size=-2048; PRAGMA max_page_count=65536;
      CREATE TABLE events(sequence INTEGER PRIMARY KEY, id TEXT UNIQUE, kind TEXT, category TEXT, time TEXT,
        agent TEXT, invocation TEXT, span TEXT, parent TEXT, resource TEXT, operation TEXT, branch TEXT, status TEXT, search TEXT, summary TEXT, digest TEXT);
      CREATE INDEX spans ON events(span); CREATE INDEX categories ON events(category); CREATE INDEX agents ON events(agent);
      CREATE INDEX invocations ON events(invocation); CREATE INDEX branches ON events(branch);`);
    const insert = this.index.prepare('INSERT INTO events VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
    const digest = createHash('sha256'), counts = {}; let terminal = null, first = null, total = 0;
    try {
      this.index.exec('BEGIN');
      for (const event of source.events()) {
        const summary = eventSummary(event), projected = projectEvent(event);
        for (const key of ['id', 'kind', 'agent', 'invocation', 'span', 'parent', 'resource', 'operation', 'branch', 'status', 'call']) {
          if (typeof summary[key] !== 'string' || summary[key].length > 4096) throw new Error('TraceMetadataLimit');
        }
        const search = [summary.id, summary.kind, summary.agent, summary.resource, summary.operation, summary.branch, event.payload?.runtime_error_code].filter(Boolean).join(' ');
        insert.run(summary.sequence, summary.id, summary.kind, summary.category, summary.time, summary.agent, summary.invocation,
          summary.span, summary.parent, summary.resource, summary.operation, summary.branch, summary.status, search, JSON.stringify(summary), traceJsonDigest(event));
        digest.update(JSON.stringify(projected));
        counts[summary.category] = (counts[summary.category] ?? 0) + 1;
        first ??= event.observed_at ?? null; terminal = event; total++;
      }
      this.index.exec('COMMIT');
      const reference = source.complete && !this.document ? createTraceReference(source) : null;
      const originalDigest = createHash('sha256'); for (const part of source.json()) originalDigest.update(part);
      this.state = { id, header: source.header, origin: this.store?.origin(source.header.run.run_id) ?? null, total, start: source.startIndex, end: source.startIndex + total - 1,
        closed: source.complete, coverage: 'selected_segment', counts, first, last: terminal?.observed_at ?? null,
        status: source.header.run.admission === 'refused' ? 'refused' : terminal?.kind === 'run_completed' ? terminal.payload?.status ?? 'refused' : 'incomplete',
        reason: terminal?.kind === 'run_completed' && /^[A-Za-z0-9_:.-]{1,120}$/u.test(terminal.payload?.reason ?? '') ? terminal.payload.reason : null,
        reference, digest: originalDigest.digest('hex'), projectionDigest: digest.digest('hex'),
        integrity: source.complete ? 'complete_segment_validated' : 'prefix_validated',
        sourceAvailable: Boolean(this.air && airDocumentDigest(this.air) === source.header.run.air_digest),
        frozenAt: new Date().toISOString() };
      return this.state;
    } catch (error) { this.closeIndex(); throw error; }
  }
  requireSelected() { if (!this.index || !this.snapshot) throw new Error('TraceSelectionRequired'); }
  async attachAir({ filename } = {}) {
    this.requireSelected();
    if (typeof filename !== 'string') throw new Error('TracePathRequired');
    const root = await realpath(this.root), path = await realpath(filename), rel = relative(root, path);
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('TraceSourceOutsideRoot');
    const air = validateAirMachineContract(jsonFile(path));
    this.air = airDocumentDigest(air) === this.state.header.run.air_digest ? air : null;
    this.state.sourceAvailable = Boolean(this.air);
    return this.state;
  }
  query(input = {}) {
    this.requireSelected(); const q = queryOptions(input), { sql, values } = queryWhere(q);
    const total = this.index.prepare(`SELECT count(*) AS count FROM events ${sql}`).get(...values).count;
    const events = this.index.prepare(`SELECT summary FROM events ${sql} ORDER BY sequence LIMIT ? OFFSET ?`).all(...values, q.limit, q.offset).map(row => JSON.parse(row.summary));
    const categories = this.index.prepare(`SELECT category,count(*) AS count FROM events ${sql} GROUP BY category`).all(...values);
    return { events, total, offset: q.offset, limit: q.limit, categories, coverage: 'selected_segment', state: this.state };
  }
  detail({ sequence } = {}) {
    this.requireSelected();
    if (!Number.isSafeInteger(sequence)) throw new Error('TraceEventInvalid');
    const indexed = this.index.prepare('SELECT digest FROM events WHERE sequence=?').get(sequence);
    if (!indexed) throw new Error('TraceEventNotFound');
    const event = this.document ? this.document.events.find(e => e.sequence_index === sequence)
      : this.store.page(this.state.id, { after: sequence - 1, limit: 1 }).events[0];
    if (!event || traceJsonDigest(event) !== indexed.digest) throw new Error('TraceChanged: refresh the selection');
    return { event: projectEvent(event), originalEventDigest: indexed.digest, projection: 'structural_fields_only' };
  }
  graph(input = {}) {
    const page = this.query(input), nodes = new Map(), edges = [];
    for (const event of page.events) {
      const isCall = event.kind === 'call_started', id = isCall ? event.id : event.span || event.id;
      if (!nodes.has(id)) nodes.set(id, { id, label: (isCall ? event.resource : event.scope || event.resource) || event.kind, type: isCall ? 'call' : event.span ? 'invocation' : 'event', sequence: event.sequence, category: event.category, count: 0, outside: false });
      nodes.get(id).outside = false;
      nodes.get(id).count++;
      const parentId = isCall ? event.span : event.parent;
      if (parentId && parentId !== id) {
        if (!nodes.has(parentId)) {
          const parent = this.index.prepare('SELECT summary FROM events WHERE span=? ORDER BY sequence LIMIT 1').get(parentId);
          if (parent) { const item = JSON.parse(parent.summary); nodes.set(parentId, { id: parentId, label: item.scope || item.resource || item.kind, type:'invocation', sequence: item.sequence, category: item.category, count: 0, outside: true }); }
        }
        if (nodes.has(parentId) && !edges.some(e => e.from === parentId && e.to === id)) edges.push({ from: parentId, to: id, kind: isCall ? 'call' : 'invocation' });
      }
      const details = this.detail({ sequence: event.sequence }).event;
      if (details.payload.call_started_event_id) {
        const start = this.index.prepare('SELECT summary FROM events WHERE id=?').get(details.payload.call_started_event_id);
        if (start) {
          const item = JSON.parse(start.summary);
          if (!item.span && nodes.has(item.id) && id !== item.id) edges.push({ from: item.id, to: id, kind: 'call' });
        }
      }
    }
    return { ...page, nodes: [...nodes.values()], edges };
  }
  export(input = {}) {
    const q = queryOptions(input), where = queryWhere(q);
    this.requireSelected();
    const total = this.index.prepare(`SELECT count(*) AS count FROM events ${where.sql}`).get(...where.values).count;
    if (total > 10000) throw new Error('TraceExportLimit: narrow the selection to at most 10,000 events');
    const report = { format: 'touba-trace-explorer-report-v1', kind: 'filtered_reading_report', created_at: new Date().toISOString(),
      run: this.state.header.run, segment: { id: this.state.id, start: this.state.start, end: this.state.end, closed: this.state.closed,
        original_digest: this.state.digest, reference: this.state.reference, integrity: this.state.integrity },
      filters: Object.fromEntries(Object.entries(q).filter(([key]) => !['offset', 'limit'].includes(key))),
      coverage: { selected: total, segment: this.state.total }, redaction: 'structural_fields_only', events: [] };
    let bytes = Buffer.byteLength(JSON.stringify(report));
    for (const { sequence } of this.index.prepare(`SELECT sequence FROM events ${where.sql} ORDER BY sequence`).iterate(...where.values)) {
      const item = this.detail({ sequence }); bytes += Buffer.byteLength(JSON.stringify(item));
      if (bytes > MAX_EXPORT) throw new Error('TraceExportLimit: narrow the selection below 8 MiB');
      report.events.push(item);
    }
    if (Buffer.byteLength(JSON.stringify(report, null, 2)) > MAX_EXPORT) throw new Error('TraceExportLimit');
    return report;
  }
  async source({ sequence } = {}) {
    const { event } = this.detail({ sequence });
    if (!this.state.sourceAvailable) throw new Error('TraceSourceAirRequired: select the matching AIR with --air');
    const ref = event.air_ref;
    const graph = this.air.execution_graphs?.find(g => g.id === ref?.flow_graph_ref);
    const node = graph?.nodes?.find(n => n.id === ref?.node_id);
    const source = node?.source_ref ?? graph?.source_ref;
    if (!source || typeof source.source_id !== 'string') throw new Error('TraceSourceUnavailable');
    if (isAbsolute(source.source_id) || !source.source_id.endsWith('.tb')) throw new Error('TraceSourceOutsideProject');
    const root = await realpath(this.root), target = await realpath(resolve(root, source.source_id)), rel = relative(root, target);
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('TraceSourceOutsideProject');
    const bytes = await readProjectSource(root, target);
    return { path: rel.split(sep).join('/'), text: bytes.toString('utf8'), digest: hash(bytes), source_ref: source,
      verification: 'matching_air_current_source', notice: 'The AIR matches this execution. The displayed file is its current source, which may have changed.' };
  }
}
