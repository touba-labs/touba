export function normalizeTriggerEntries(values) {
  if (values === undefined) {
    return {};
  }
  if (!Array.isArray(values)) {
    throw new Error("AIR definitions.triggers must be an array when present");
  }

  const triggers = {};
  for (const trigger of values) {
    if (!trigger || typeof trigger !== "object" || Array.isArray(trigger)) {
      throw new Error("AIR trigger entries must be objects");
    }
    if (typeof trigger.id !== "string" || !trigger.id.startsWith("trigger:")) {
      throw new Error("AIR trigger entries must contain trigger:id");
    }
    const sourceKind = trigger.event?.kind;
    if (sourceKind !== "schedule" && sourceKind !== "request") {
      throw new Error(`AIR trigger ${trigger.id} must use schedule or request source kind`);
    }

    const entry = {
      enabled: false,
      source: {
        kind: sourceKind,
      },
      limits: normalizeTriggerLimits(trigger.limits, trigger.id),
    };

    if (trigger.payload !== undefined) {
      entry.payload = normalizeTriggerPayload(trigger.payload, trigger.id);
    }

    triggers[trigger.id] = entry;
  }

  return triggers;
}

function normalizeTriggerLimits(limits, triggerId) {
  if (!limits || typeof limits !== "object" || Array.isArray(limits)) {
    throw new Error(`AIR trigger ${triggerId} must contain limits`);
  }
  return {
    max_runs_per_day: positiveInteger(limits.max_runs_per_day, undefined, "max_runs_per_day"),
    timeout_ms: positiveInteger(limits.timeout_ms, undefined, "timeout_ms"),
  };
}

function normalizeTriggerPayload(payload, triggerId) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error(`AIR trigger ${triggerId} payload must be an object`);
  }
  const format = payload.format ?? "json";
  if (format !== "json") {
    throw new Error(`AIR trigger ${triggerId} payload format must be json`);
  }
  const contentTypes = normalizeOptionalStringArray(
    payload.content_types,
    ["application/json"],
    "content_types",
  );
  const maxBytes = positiveInteger(payload.max_bytes, 65536, "max_bytes");
  if (!payload.map || typeof payload.map !== "object" || Array.isArray(payload.map)) {
    throw new Error(`AIR trigger ${triggerId} payload.map must be an object`);
  }
  const map = {};
  for (const [inputName, jsonPath] of Object.entries(payload.map)) {
    if (typeof inputName !== "string" || inputName.trim() === "") {
      throw new Error(`AIR trigger ${triggerId} payload.map input names must be non-empty`);
    }
    if (typeof jsonPath !== "string" || !/^\$(\.[A-Za-z_][A-Za-z0-9_]*)+$/u.test(jsonPath)) {
      throw new Error(`AIR trigger ${triggerId} payload.map values must use $.field JSON paths`);
    }
    map[inputName] = jsonPath;
  }
  return {
    format,
    content_types: contentTypes,
    max_bytes: maxBytes,
    map,
  };
}

function normalizeOptionalStringArray(values, fallback, label) {
  if (values === undefined) {
    return fallback;
  }
  if (!Array.isArray(values)) {
    throw new Error(`${label} must be an array when present`);
  }
  return values.map((value) => {
    if (typeof value !== "string" || value.trim() === "") {
      throw new Error(`${label} entries must be non-empty strings`);
    }
    return value;
  });
}

export function positiveInteger(value, fallback, label) {
  if (value === undefined) {
    if (fallback === undefined) {
      throw new Error(`${label} is required`);
    }
    return fallback;
  }
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}
