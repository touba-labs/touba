// Shared projection only. Runtime type admission and execution authority remain
// server-side. Paths use the manifest's restricted JSON object-path syntax.
export function mapTriggerPayload(payload, mapping) {
  const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
  if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping)) fail('TriggerPayloadContractInvalid', 'payload mapping must be an object');
  const entries = Object.entries(mapping);
  return Object.fromEntries(entries.map(([name, path]) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name) || typeof path !== 'string'
      || !/^\$(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/u.test(path)) {
      fail('TriggerPayloadContractInvalid', 'payload mapping must use declared names and object paths');
    }
    let value = payload;
    for (const part of path === '$' ? [] : path.slice(2).split('.')) {
      if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.hasOwn(value, part)) {
        fail('TriggerPayloadInvalid', `request body is missing mapped field ${path}`);
      }
      value = value[part];
    }
    if (value === undefined) fail('TriggerPayloadInvalid', `request body is missing mapped field ${path}`);
    return [name, value];
  }));
}
