import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadAirFromJson, loadToolBindingManifestFromJson } from '@touba/runtime';
import { readPreparedProject } from './prepared-project.mjs';
import { readProjectEntrypoints } from '../../touba-project/src/project-entrypoints.mjs';
import { buildRequestRoutes, materializePayloadArguments, readBoundedBody } from '../../touba-trigger-service/src/serve.mjs';
import { assertWebhookSignature, validateWebhookArguments } from '../../touba-trigger-service/src/request-admission.mjs';
import { createSqliteTriggerQueue } from '../../touba-trigger-service/src/sqlite-queue.mjs';
import { createSqliteTriggerStore } from '../../../runtime/touba-runtime/src/sqlite-trigger-store.mjs';

export const WEBHOOK_PREFIX = '/_touba/events';
const OWNER = 'project-server-v1';
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = (code, message = code) => { throw Object.assign(new Error(message), {code}); };
const safeCode = value => /^[A-Za-z][A-Za-z0-9]{0,99}$/.test(value ?? '') ? value : 'TriggerExecutionInterrupted';
const active = new Set(['queued', 'processing', 'continuing', 'awaiting_human']);

/** All exposed routes share the same verified preparation and execution host. */
export function readProjectRequestRoutes(root) {
  const prepared = readPreparedProject(root);
  if (!prepared) fail('ToubaServePreparedProjectInvalid');
  const manifestInput = prepared.inputs.find(item => item.kind === 'manifest');
  if (!manifestInput) return [];
  const manifestPath = join(root, manifestInput.path);
  const manifest = loadToolBindingManifestFromJson(readFileSync(manifestPath, 'utf8'), {baseDir: root});
  const exposed = new Set(readProjectEntrypoints(root)), routes = new Map(), paths = new Map();
  for (const input of prepared.inputs.filter(item => item.kind === 'air')) {
    const document = loadAirFromJson(readFileSync(join(root, input.path), 'utf8'));
    const exposedDocument = {...document,definitions:{...document.definitions,triggers:(document.definitions.triggers??[]).filter(trigger=>exposed.has(trigger.id))}};
    for (const route of buildRequestRoutes(exposedDocument, manifest)) {
      if (!exposed.has(route.trigger.id)) continue;
      const signature = digest([route.trigger, prepared.inputs.map(item => [item.path, item.digest_sha256])]);
      if (routes.has(route.trigger.id)) {
        if (routes.get(route.trigger.id).signature !== signature) fail('ToubaServeTriggerDefinitionConflict');
        continue;
      }
      const key = `${route.method} ${route.path}`;
      if (paths.has(key)) fail('TriggerRouteConflict', `Multiple exposed triggers declare ${key}`);
      paths.set(key, route.trigger.id);
      routes.set(route.trigger.id, {...route, document, signature,
        limit: Math.min(route.trigger.limits.max_runs_per_day, manifest.triggers.get(route.trigger.id).limits?.max_runs_per_day ?? Infinity)});
      if (routes.size > 100) fail('TriggerRouteCapacityExceeded');
    }
  }
  return [...routes.values()];
}

/** Queue payloads stay private; public views contain only state and review evidence. */
export function createProjectWebhooks({enabled, root, queuePath, statePath, signatureSecret,
  execute, outcome, gate, emit, now = Date.now}) {
  if (enabled && (typeof signatureSecret !== 'string' || Buffer.byteLength(signatureSecret) < 32)) {
    fail('TriggerSignatureSecretRequired', 'Project webhooks require a signature secret of at least 32 bytes');
  }
  let queue, timer, task, stopping = true, observationError = null, waitCursor = '';
  const open = () => queue ??= createSqliteTriggerQueue({filename:queuePath});
  function* entries() {
    if (!queue && !existsSync(queuePath)) return;
    for (let after = '';;) {
      const page = open().page({after,limit:100});
      yield* page.entries;
      if (!page.entries.length) return;
      after = page.next;
    }
  }
  const metadata = () => !queue && !existsSync(queuePath) ? [] : open().metadata();
  function assertOwned(entry) {
    if (entry.execution_owner !== OWNER) fail('TriggerQueueOwnerMismatch', 'Use a separate queue for project webhooks; autonomous waits are not imported');
  }
  function consumed(entry) {
    if (!existsSync(statePath)) return false;
    const state = createSqliteTriggerStore({filename:statePath,readOnly:true});
    try { return state.consumed(entry.trigger_ref,entry.event_id); } finally { state.close(); }
  }
  const fingerprint = entry => digest(entry);
  function row(entry) {
    const reviewed = entry.review?.action === 'close' || entry.review?.action === 'discard';
    const retryable = !reviewed && ['failed','dead_lettered'].includes(entry.status)
      && entry.effects_started === false && !consumed(entry);
    const actions = reviewed || active.has(entry.status) || entry.status === 'succeeded' ? []
      : [...(retryable ? ['retry'] : []), entry.effects_started === false ? 'discard' : 'close'];
    return {queue_id:entry.queue_id,trigger_ref:entry.trigger_ref,event_id:entry.event_id,
      status:reviewed?'closed':entry.status,run_id:entry.run_id ?? null,received_at:entry.received_at,
      request_id:entry.status==='awaiting_human'?outcome(entry.run_id)?.request_id??null:null,
      attempt_count:entry.attempt_count ?? 0,code:entry.runtime_error_code ?? null,
      effect_outcome:entry.effects_started === false?'none':entry.status === 'succeeded'?'completed':'review_required',
      review_digest:fingerprint(entry),actions};
  }
  function reconcile(entry) {
    if (!['processing','awaiting_human','interrupted'].includes(entry.status) || ['close','discard'].includes(entry.review?.action)) return;
    const result = outcome(entry.run_id);
    if (!result) return;
    if (result.status === 'pending') {
      if (entry.status === 'awaiting_human') return;
      entry.status = 'awaiting_human';
    }
    else if (['success','failed'].includes(result.status)) {
      entry.status = result.status === 'success'?'succeeded':'failed';
      entry.completed_at = new Date(now()).toISOString();
      entry.runtime_error_code = result.code ?? null;
    } else return;
    open().finish(entry);
  }
  async function poll() {
    if (stopping || !enabled) return;
    const waiting = open().page({after:waitCursor,limit:25,states:['awaiting_human']});
    waitCursor = waiting.next ?? '';
    for (const entry of waiting.entries) {
      assertOwned(entry);
      reconcile(entry);
    }
    if (gate.mutating) return;
    const entry = open().claim(1,now(),{guardUnknown:true});
    if (!entry) { observationError=null; return; }
    assertOwned(entry);
    let release, dispatched = false;
    try {
      const route = readProjectRequestRoutes(root).find(item => item.trigger.id === entry.trigger_ref);
      if (!route || route.signature !== entry.plan_signature) fail('TriggerPlanChanged', 'Review the event against the current preparation');
      release = gate.enter('execution');
      entry.effects_started = true;
      entry.run_id = `webhook_${digest(entry.queue_id).slice(0,40)}`;
      open().progress(entry); // Persist intent and worker ownership before entering the runtime.
      dispatched = true;
      const authority = () => !stopping && readProjectRequestRoutes(root).some(item => item.trigger.id === entry.trigger_ref && item.signature === entry.plan_signature);
      const result = await execute({...entry,authority,cancelled:()=>stopping});
      const pending = outcome(entry.run_id)?.status === 'pending';
      entry.status = pending?'awaiting_human':result.status === 'success'?'succeeded':'failed';
      entry.runtime_error_code = result.status === 'success'||pending?null:safeCode(result.reason);
      if (!pending) entry.completed_at = new Date(now()).toISOString();
      if (result.reason === 'TriggerRateLimited' && !consumed(entry)) {
        entry.status = 'queued';entry.effects_started = false;
        entry.next_attempt_at = new Date((Math.floor(now()/86400000)+1)*86400000).toISOString();
        delete entry.completed_at;
      }
    } catch (error) {
      entry.status = dispatched?'interrupted':'dead_lettered';
      entry.effects_started = dispatched;
      entry.runtime_error_code = safeCode(error.code);
      entry.completed_at = new Date(now()).toISOString();
    } finally { release?.(); }
    open().finish(entry);
    observationError=null;
    emit('trigger.webhook.updated', {queue_id:entry.queue_id,trigger_ref:entry.trigger_ref,run_id:entry.run_id ?? null,
      status:entry.status,code:entry.runtime_error_code ?? null});
  }
  const tick = () => task ??= poll().catch(error => { observationError=safeCode(error.code); })
    .finally(()=>{task=null;});
  return {
    blockers() { return metadata().filter(entry=>!['close','discard'].includes(entry.review_action) && (active.has(entry.status)||entry.status==='interrupted')).map(entry=>entry.trigger_ref); },
    async receive(request) {
      if (!enabled || stopping) fail('TriggerIngressDisabled');
      if (request.headers.origin) fail('TriggerIngressOriginRejected');
      const initialUrl = new URL(request.url,'http://127.0.0.1');
      const path = initialUrl.pathname.slice(WEBHOOK_PREFIX.length);
      const route = readProjectRequestRoutes(root).find(item=>item.method===request.method&&item.path===path);
      if (!route) fail('TriggerRouteNotFound');
      const body = await readBoundedBody(request,route.payload?.maxBytes ?? 65536);
      if (stopping) fail('TriggerIngressDisabled');
      assertWebhookSignature(request,body.buffer,signatureSecret,now());
      const inputs = materializePayloadArguments(route,request,body) ?? {};
      validateWebhookArguments(route.document,route.target,inputs);
      // Body reading yields: pin the same reviewed preparation before admission.
      const release = gate.enter('execution');
      try {
        if (!readProjectRequestRoutes(root).some(item=>item.trigger.id===route.trigger.id&&item.signature===route.signature)) fail('TriggerPlanChanged');
        const eventId=request.headers['x-touba-event-id'], existing=open().find(route.trigger.id,eventId);
        if (existing) {
          assertOwned(existing);
          if (existing.http.payload_sha256!==body.digest) fail('TriggerEventPayloadConflict');
          return {http:active.has(existing.status)?202:409,body:{queue_id:existing.queue_id,status:existing.status,deduplicated:true}};
        }
        const entry={queue_id:`queue:${digest([route.trigger.id,eventId])}`,execution_owner:OWNER,
          trigger_ref:route.trigger.id,event_id:eventId,plan_signature:route.signature,
          status:'queued',received_at:new Date(now()).toISOString(),attempt_count:0,effects_started:false,
          arguments:inputs,http:{payload_sha256:body.digest,payload_bytes:body.buffer.length}};
        const state=createSqliteTriggerStore({filename:statePath});
        try {
          if (state.consumed(entry.trigger_ref,eventId)) fail('TriggerReplayRejected');
          open().enqueue(entry,{beforeInsert(pending){
            const reserved=pending.filter(item=>item.trigger_ref===entry.trigger_ref&&!state.consumed(item.trigger_ref,item.event_id)).length;
            if (reserved+state.count(entry.trigger_ref)>=route.limit) fail('TriggerRateLimited');
          }});
        } finally {state.close();}
        void tick();
        return {http:202,body:{queue_id:entry.queue_id,status:'queued',deduplicated:false}};
      } finally {release();}
    },
    status({after='',limit=25}={}) {
      if (typeof after!=='string'||after.length>128||!Number.isInteger(limit)||limit<1||limit>100) fail('TriggerQueueQueryInvalid');
      const all=metadata(); all.forEach(assertOwned);
      let routes=[],code=observationError;
      try { if(enabled) routes=readProjectRequestRoutes(root).map(item=>({trigger_ref:item.trigger.id,method:item.method,path:WEBHOOK_PREFIX+item.path})); }
      catch(error){code=safeCode(error.code);}
      const selected=all.length ? open().page({after,limit}).entries : [];
      const counts=Object.fromEntries(['queued','processing','awaiting_human','interrupted','succeeded','failed','dead_lettered','closed'].map(status=>[status,0]));
      for(const entry of all) counts[['close','discard'].includes(entry.review_action)?'closed':entry.status==='continuing'?'processing':entry.status]++;
      return {schema_version:'touba-project-webhooks-v1',enabled:Boolean(enabled),code:code??null,routes,counts,
        entries:selected.map(row),next:all.some(entry=>entry.queue_id>(selected.at(-1)?.queue_id??after))?selected.at(-1).queue_id:null};
    },
    review({queue_id,review_digest,action,reason,reconciled},actor) {
      if(typeof queue_id!=='string'||queue_id.length>128||!/^\w[\w:-]*$/.test(queue_id)
        ||typeof review_digest!=='string'||!/^[a-f0-9]{64}$/.test(review_digest)
        ||reconciled!==undefined&&typeof reconciled!=='boolean') fail('TriggerQueueReviewInvalid');
      if(typeof reason!=='string'||!reason.trim()||reason.length>500||!['retry','discard','close'].includes(action)) fail('TriggerQueueReviewInvalid');
      const entry=open().get(queue_id);if(!entry) fail('TriggerQueueReviewConflict');assertOwned(entry);
      if(fingerprint(entry)!==review_digest||!row(entry).actions.includes(action)) fail('TriggerQueueReviewConflict');
      if(action==='close'&&reconciled!==true) fail('TriggerQueueReconciliationRequired');
      if(action==='retry') {
        if(!enabled||stopping) fail('TriggerIngressDisabled');
        const route=readProjectRequestRoutes(root).find(item=>item.trigger.id===entry.trigger_ref);
        if(!route) fail('TriggerRouteNotFound');
        if(route.signature!==entry.plan_signature) fail('TriggerPlanChanged', 'Discard this event and submit a new delivery for the changed preparation');
        validateWebhookArguments(route.document,route.target,entry.arguments);
        entry.plan_signature=route.signature;entry.status='queued';delete entry.completed_at;
        entry.next_attempt_at=new Date(now()+1000).toISOString();
      } else entry.status='failed';
      entry.review={action,reason:reason.trim(),reconciled:reconciled===true,actor,at:new Date(now()).toISOString()};
      open().finish(entry);
      emit('trigger.webhook.reviewed',{queue_id,trigger_ref:entry.trigger_ref,action,actor,reason:reason.trim(),reconciled:reconciled===true});
      return row(entry);
    },
    start() {
      if(!enabled)return;
      readProjectRequestRoutes(root); // Refuse ambiguous routes before accepting requests.
      for(const entry of entries()) {
        assertOwned(entry);
        if(['processing','continuing'].includes(entry.status)) {
          entry.status='interrupted';entry.runtime_error_code='TriggerExecutionInterrupted';open().finish(entry);
        }
        reconcile(entry);
      }
      stopping=false;timer=setInterval(()=>void tick(),500);timer.unref?.();void tick();
    },
    async stop(){stopping=true;clearInterval(timer);await task;queue?.close();queue=undefined;},
    tick,
  };
}
