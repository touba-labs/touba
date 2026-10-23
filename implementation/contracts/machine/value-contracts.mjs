/** Shared machine value contracts. No runtime or SDK dependency.
 * Civil date, without Date.parse rollover, timezone or locale dependence.
 * @param {unknown} value */
export function isIsoDate(value) {
  if (typeof value !== "string" || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/u.test(value)) return false;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return year > 0 && month >= 1 && month <= 12 && day > 0 && day <= days[month - 1];
}

/** Closed, portable source constraints. Length counts Unicode code points.
 * @param {string} type @param {Record<string, any>} constraints */
export function validFieldConstraints(type, constraints) {
  if (typeof type !== "string" || !constraints || typeof constraints !== "object" || Array.isArray(constraints)) return false;
  for (const [key, value] of Object.entries(constraints)) {
    if (key === "format") {
      if (type !== "builtin:Text" || value !== "digits") return false;
    } else if (["min_length", "max_length"].includes(key)) {
      if (!(type === "builtin:Text" || type.startsWith("list:")) || !Number.isSafeInteger(value) || value < 0) return false;
    } else if (["min", "max"].includes(key)) {
      if (!["builtin:Int", "builtin:Float"].includes(type) || typeof value !== "number" || !Number.isFinite(value)
        || (type === "builtin:Int" && !Number.isSafeInteger(value))) return false;
    } else return false;
  }
  return !(constraints.min > constraints.max || constraints.min_length > constraints.max_length);
}

/** @param {any} value @param {Record<string, any>} [constraints] */
export function matchesFieldConstraints(value, constraints = {}) {
  for (const [key, limit] of Object.entries(constraints)) {
    if (key === "format" && (limit !== "digits" || typeof value !== "string" || !/^[0-9]+$/u.test(value))) return false;
    if (key === "min" && !(typeof value === "number" && value >= limit)) return false;
    if (key === "max" && !(typeof value === "number" && value <= limit)) return false;
    if (["min_length", "max_length"].includes(key)) {
      const length = typeof value === "string" ? Array.from(value).length : Array.isArray(value) ? value.length : null;
      if (length === null || (key === "min_length" ? length < limit : length > limit)) return false;
    }
    if (!["format", "min", "max", "min_length", "max_length"].includes(key)) return false;
  }
  return true;
}

/** @param {any} value @param {string} type @param {Record<string, any>} [constraints] */
export function validFieldDefault(value, type, constraints = {}) {
  const valid = type === "builtin:Text" ? typeof value === "string"
    : type === "builtin:Boolean" ? typeof value === "boolean"
    : type === "builtin:Int" ? Number.isSafeInteger(value)
    : type === "builtin:Float" ? typeof value === "number" && Number.isFinite(value)
    : type === "builtin:Date" ? isIsoDate(value)
    : type.startsWith("optional:") ? value !== null && typeof value === "object" && !Array.isArray(value) && value.present === false && Object.keys(value).length === 1
    : type.startsWith("list:") && Array.isArray(value) && value.length === 0;
  return valid && matchesFieldConstraints(value, constraints);
}

/** @param {string} type @param {Record<string, any>} [constraints] */
export function fieldConstraintSchema(type, constraints = {}) {
  const schema = /** @type {Record<string, any>} */ ({});
  if (constraints.format === "digits") schema.pattern = "^[0-9]+$";
  if (constraints.min !== undefined) schema.minimum = constraints.min;
  if (constraints.max !== undefined) schema.maximum = constraints.max;
  if (constraints.min_length !== undefined) schema[type.startsWith("list:") ? "minItems" : "minLength"] = constraints.min_length;
  if (constraints.max_length !== undefined) schema[type.startsWith("list:") ? "maxItems" : "maxLength"] = constraints.max_length;
  return schema;
}
export const APPROVAL_TYPE = Object.freeze({ id: "builtin:Approval", name: "Approval", fields: Object.freeze([
  { name: "decision", type_ref: "builtin:Text" }, { name: "subject_ref", type_ref: "optional:builtin:Text" },
  { name: "attested_roles", type_ref: "list:builtin:Text" }, { name: "request_id", type_ref: "builtin:Text" },
  { name: "run_id", type_ref: "builtin:Text" }, { name: "accepted_at", type_ref: "builtin:Text" },
  { name: "comment", type_ref: "optional:builtin:Text" },
]) });
