// Shared pure contract: no environment lookup, network access or secret resolution.
export const HANDLER_CONFIGURATION_SCHEMA = "touba-handler-configuration-v1";
const fail = () => { throw Object.assign(new Error("invalid handler configuration"), { code: "HandlerConfigurationInvalid" }); };
const object = value => value !== null && typeof value === "object" && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const key = value => /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(value) && !["constructor", "prototype"].includes(value);
const number = value => typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER;
const text = value => typeof value === "string" && !value.includes("\0") && value.isWellFormed() && Buffer.byteLength(value) <= 4096;
const closed = (value, keys) => { if (!object(value) || Object.keys(value).some(k => !keys.includes(k))) fail(); };
const fields = value => { if (!object(value) || Object.keys(value).length > 64 || Object.keys(value).some(k => !key(k))) fail(); };

export function normalizeHandlerConfigurationSchema(value) {
  closed(value, ["schema_version", "fields"]);
  if (value.schema_version !== HANDLER_CONFIGURATION_SCHEMA) fail();
  fields(value.fields);
  const entries = Object.entries(value.fields).sort(([a], [b]) => a.localeCompare(b)).map(([name, rule]) => {
    closed(rule, ["type", "required", "max_bytes", "min", "max"]);
    if (!["string", "boolean", "integer", "number"].includes(rule.type)
      || (rule.required !== undefined && typeof rule.required !== "boolean")) fail();
    if (rule.max_bytes !== undefined && (rule.type !== "string" || !Number.isSafeInteger(rule.max_bytes)
      || rule.max_bytes < 0 || rule.max_bytes > 4096)) fail();
    for (const bound of ["min", "max"]) if (rule[bound] !== undefined
      && (!["number", "integer"].includes(rule.type) || !number(rule[bound])
        || (rule.type === "integer" && !Number.isSafeInteger(rule[bound])))) fail();
    if (rule.min !== undefined && rule.max !== undefined && rule.min > rule.max) fail();
    return [name, Object.freeze({ ...rule })];
  });
  return Object.freeze({ schema_version: HANDLER_CONFIGURATION_SCHEMA, fields: Object.freeze(Object.fromEntries(entries)) });
}

export function normalizeHandlerConfigurationValues(value) {
  fields(value);
  for (const item of Object.values(value)) if (!text(item) && typeof item !== "boolean" && !number(item)) fail();
  // Reserve the same scalar budget in both SDKs, independently of float formatting.
  const bytes = 2 + Object.entries(value).reduce((total, [name, item]) => total + name.length + 4
    + (typeof item === 'string' ? Buffer.byteLength(JSON.stringify(item)) : typeof item === 'boolean' ? 5 : 32), 0);
  if (bytes > 16384) fail();
  return Object.freeze(Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))));
}

export function normalizeHandlerConfiguration(value) {
  closed(value, ["schema", "values"]);
  const schema = normalizeHandlerConfigurationSchema(value.schema);
  const values = normalizeHandlerConfigurationValues(value.values);
  if (Object.keys(values).some(name => !Object.hasOwn(schema.fields, name))) fail();
  for (const [name, rule] of Object.entries(schema.fields)) {
    if (!Object.hasOwn(values, name)) { if (rule.required === true) fail(); continue; }
    const item = values[name];
    if (rule.type === "string" ? !text(item) || Buffer.byteLength(item) > (rule.max_bytes ?? 4096)
      : rule.type === "boolean" ? typeof item !== "boolean"
        : !number(item) || (rule.type === "integer" && !Number.isSafeInteger(item))) fail();
    if ((rule.min !== undefined && item < rule.min) || (rule.max !== undefined && item > rule.max)) fail();
  }
  return Object.freeze({ schema, values });
}
