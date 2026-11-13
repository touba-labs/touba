import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {assertWebhookSignature, validateWebhookArguments} from '../src/request-admission.mjs';
import {mapTriggerPayload} from '../../../contracts/machine/trigger-payload.mjs';

const clock = 1800000000000;
const secret = 'synthetic-signing-key';
const body = Buffer.from('{"message":"private fixture"}');

test('HTTP and interactive event mapping share object paths, preserve types and reject missing fields', () => {
  const input = {contract_id:'C-1003', payment:{amount:12}, ignored:'not forwarded'};
  const map = {id:'$.contract_id',amount:'$.payment.amount'};
  assert.deepEqual(mapTriggerPayload(input,map),{id:'C-1003',amount:12});
  assert.deepEqual(mapTriggerPayload(input,{request:'$'}),{request:input});
  assert.deepEqual(mapTriggerPayload({value:false},{enabled:'$.value'}),{enabled:false});
  assert.deepEqual(mapTriggerPayload({value:null},{value:'$.value'}),{value:null});
  for (const payload of [null,[],{},Object.create(input)]) assert.throws(()=>mapTriggerPayload(payload,map),{code:'TriggerPayloadInvalid'});
  for (const path of ['$.payment[0]','payment.amount','$.*','$.x..y']) assert.throws(()=>mapTriggerPayload(input,{value:path}),{code:'TriggerPayloadContractInvalid'});
  assert.equal(Object.hasOwn(mapTriggerPayload(JSON.parse('{"__proto__":"data"}'),JSON.parse('{"__proto__":"$.__proto__"}')),'__proto__'),true);
  const document={definitions:{types:[]}};
  const target={id:'strategy:qa/Process',signature:{inputs:[{name:'id',type_ref:'builtin:Text'},{name:'amount',type_ref:'builtin:Int'}]}};
  assert.doesNotThrow(()=>validateWebhookArguments(document,target,mapTriggerPayload(input,map)));
  assert.throws(()=>validateWebhookArguments(document,target,mapTriggerPayload({...input,payment:{amount:'12'}},map)),{code:'TriggerPayloadInvalid'});
});
function signed() {
  const request = {method:'POST', url:'/events?project=one', headers:{
    'x-touba-event-id':'event-one', 'x-touba-timestamp':String(clock/1000),
  }};
  const canonical = `touba-webhook-v1\n${clock/1000}\nevent-one\nPOST\n/events?project=one\n`;
  request.headers['x-touba-signature'] = `v1=${createHmac('sha256',secret).update(canonical).update(body).digest('hex')}`;
  return request;
}
test('a signed webhook authenticates its identity, timestamp, method, target and exact bytes', () => {
  assert.doesNotThrow(() => assertWebhookSignature(signed(),body,secret,clock));
  for (const mutate of [
    r => {r.headers['x-touba-event-id']='event-two';},
    r => {r.headers['x-touba-timestamp']=String(clock/1000+1);},
    r => {r.method='PUT';}, r => {r.url='/other?project=one';},
    r => {r.url='/events?project=two';},
    r => {r.headers['x-touba-signature']='sha256='+r.headers['x-touba-signature'].slice(3);},
  ]) {
    const request=signed(); mutate(request);
    assert.throws(() => assertWebhookSignature(request,body,secret,clock),{code:'TriggerSignatureInvalid'});
  }
  assert.throws(() => assertWebhookSignature(signed(),Buffer.from('changed'),secret,clock),{code:'TriggerSignatureInvalid'});
  for (const skew of [-300001,300001]) {
    assert.throws(() => assertWebhookSignature(signed(),body,secret,clock+skew),{code:'TriggerSignatureInvalid'});
  }
  for (const header of ['x-touba-event-id','x-touba-timestamp','x-touba-signature']) {
    const request=signed(); delete request.headers[header];
    assert.throws(() => assertWebhookSignature(request,body,secret,clock));
  }
});

test('mapped inputs are checked with runtime schemas before HTTP acceptance without exposing their values', () => {
  const target={id:'strategy:example/Accept', signature:{inputs:[
    {name:'message',type_ref:'builtin:Text'}, {name:'constant',type_ref:'builtin:Int'},
  ]}};
  const document={definitions:{types:[]}};
  assert.doesNotThrow(() => validateWebhookArguments(document,target,{message:'valid'}));
  for (const args of [{message:42},{message:{secret:'private fixture'}},{unknown:'private fixture'}]) {
    assert.throws(() => validateWebhookArguments(document,target,args),error => {
      assert.equal(error.code,'TriggerPayloadInvalid');
      assert.equal(error.message.includes('private fixture'),false);
      return true;
    });
  }
});
