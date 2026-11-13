import { createHmac, timingSafeEqual } from 'node:crypto';
import { validateEntryInputPayload } from '../../../runtime/touba-runtime/src/payload-validation.mjs';

const fail = (code, message) => { throw Object.assign(new Error(message), {code}); };

// The byte body and routing/identity metadata are authenticated together.
// An ingress token alone is not an approval or a runtime capability.
export function assertWebhookSignature(request, body, secret, now = Date.now()) {
  const id = request.headers['x-touba-event-id'];
  const timestamp = request.headers['x-touba-timestamp'];
  const signature = request.headers['x-touba-signature'];
  if (typeof id !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/u.test(id)) {
    fail('TriggerEventIdInvalid', 'signed requests require x-touba-event-id (1..128 ASCII identifier characters)');
  }
  if (typeof timestamp !== 'string' || !/^[0-9]{10,12}$/u.test(timestamp)
    || !Number.isSafeInteger(Number(timestamp)) || Math.abs(now - Number(timestamp)*1000) > 300000) {
    fail('TriggerSignatureInvalid', 'x-touba-timestamp must be Unix seconds within five minutes of the server clock');
  }
  if (typeof signature !== 'string' || !/^v1=[a-f0-9]{64}$/iu.test(signature)) {
    fail('TriggerSignatureInvalid', 'x-touba-signature must use v1=<hex> with authenticated request metadata');
  }
  const target = new URL(request.url, 'http://127.0.0.1');
  const prefix = ['touba-webhook-v1', timestamp, id, request.method, target.pathname + target.search, ''].join('\n');
  const expected = createHmac('sha256', secret).update(prefix).update(body).digest();
  if (!timingSafeEqual(expected, Buffer.from(signature.slice(3), 'hex'))) {
    fail('TriggerSignatureInvalid', 'request signature mismatch');
  }
}

export function validateWebhookArguments(document, target, argumentsFromPayload) {
  if (argumentsFromPayload === undefined) return;
  // Constants stay in the compiled trigger. Only mapped inputs are supplied by HTTP.
  const inputs = target.signature.inputs.filter(input => Object.hasOwn(argumentsFromPayload, input.name));
  try {
    validateEntryInputPayload({...target, signature: {...target.signature, inputs}},
      new Map(Object.entries(argumentsFromPayload).map(([key,value]) => [`value:${key}`, value])),
      {indexes:{types:new Map((document.definitions?.types ?? []).map(type => [type.id,type]))}});
  } catch (error) {
    if (error.code !== 'EntryInputSchemaInvalid') throw error;
    fail('TriggerPayloadInvalid', `webhook inputs must match the declared types of ${target.id}`);
  }
}
