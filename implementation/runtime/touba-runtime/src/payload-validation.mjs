// @ts-check

import { RuntimeFailure } from "./runtime-errors.mjs";

const BUILTIN_TEXT = "builtin:Text";
const BUILTIN_BOOLEAN = "builtin:Boolean";
const BUILTIN_INT = "builtin:Int";
const BUILTIN_FLOAT = "builtin:Float";

/**
 * @param {AirTool} entry
 * @param {Map<string, unknown>} values
 * @param {PayloadValidationContext} context
 */
export function validateEntryInputPayload(entry, values, context) {
  const inputs = entry.signature?.inputs ?? [];
  const expected = new Set(inputs.map(input => `value:${input.name}`));
  const missing = inputs.filter(input => !values.has(`value:${input.name}`));
  const unknown = [...values.keys()].filter(key => !expected.has(key));
  if (missing.length || unknown.length) {
    throw new RuntimeFailure("entry inputs must match the declared takes parameters", {
      entryRef: entry.id,
      missingFields: missing.map(input => input.name),
      unknownFieldCount: unknown.length,
    }, "EntryInputSchemaInvalid");
  }
  for (const input of inputs) {
    validatePayloadValue(values.get(`value:${input.name}`), input.type_ref, context, {
      toolRef: entry.id, direction: "input", path: `inputs.${input.name}`,
      errorCode: "EntryInputSchemaInvalid",
    });
  }
}

/**
 * @typedef {"input" | "output"} PayloadDirection
 * @typedef {"string" | "boolean" | "number" | "integer" | "object" | "array" | "null" | "undefined" | "bigint" | "symbol" | "function"} PayloadValueKind
 * @typedef {string | boolean | number} PortablePayloadConstraintScalar
 *
 * @typedef {object} AirParameter
 * @property {string} name
 * @property {string} type_ref
 *
 * @typedef {object} AirToolSignature
 * @property {AirParameter[]=} inputs
 * @property {string=} output_type
 *
 * @typedef {object} AirTool
 * @property {string} id
 * @property {AirToolSignature=} signature
 *
 * @typedef {object} ToubaTypeDefinition
 * @property {AirParameter[]=} fields
 * @property {{name: string}[]=} variants
 *
 * @typedef {object} PayloadValidationContext
 * @property {{ types: Map<string, ToubaTypeDefinition> }} indexes
 *
 * @typedef {object} PayloadConstraint
 * @property {string} path
 * @property {string[]} segments
 * @property {boolean=} non_empty
 * @property {number=} max_length
 * @property {number=} min
 * @property {number=} max
 * @property {PortablePayloadConstraintScalar[]=} allowed_values
 * @property {number=} min_items
 * @property {number=} max_items
 *
 * @typedef {object} SchemaFailureDetails
 * @property {string} toolRef
 * @property {PayloadDirection} direction
 * @property {string} path
 * @property {string} errorCode
 * @property {string[]=} missingFields
 * @property {string[]=} unknownFields
 *
 * @typedef {object} PayloadConstraintFailureExtra
 * @property {number=} observedLength
 */

/**
 * @param {AirTool} tool
 * @param {Record<string, unknown>} toolArguments
 * @param {PayloadValidationContext} context
 */
export function validateToolInputPayload(tool, toolArguments, context) {
  for (const input of tool.signature?.inputs ?? []) {
    validatePayloadValue(toolArguments[input.name], input.type_ref, context, {
      toolRef: tool.id,
      direction: "input",
      path: `arguments.${input.name}`,
      errorCode: "ToolInputSchemaInvalid",
    });
  }
}

/**
 * @param {AirTool} tool
 * @param {unknown} value
 * @param {PayloadValidationContext} context
 */
export function validateToolOutputPayload(tool, value, context) {
  const outputType = tool.signature?.output_type;
  if (typeof outputType !== "string" || outputType.trim() === "") {
    return;
  }

  validatePayloadValue(value, outputType, context, {
    toolRef: tool.id,
    direction: "output",
    path: "value",
    errorCode: "ToolOutputSchemaInvalid",
  });
}

/**
 * @param {PayloadDirection} direction
 * @param {AirTool} tool
 * @param {unknown} rootValue
 * @param {PayloadConstraint[]} constraints
 */
export function validateToolPayloadConstraints(direction, tool, rootValue, constraints) {
  if (!Array.isArray(constraints) || constraints.length === 0) {
    return;
  }

  for (const constraint of constraints) {
    const resolved = payloadConstraintValueAtPath(rootValue, constraint.segments);
    if (resolved.found !== true) {
      throwPayloadConstraintFailure(tool, direction, constraint, "path_not_found");
    }

    const value = resolved.value;
    if (constraint.non_empty === true) {
      if (typeof value !== "string") {
        throwPayloadConstraintFailure(tool, direction, constraint, "expected_text_for_non_empty");
      }
      if (value.trim().length === 0) {
        throwPayloadConstraintFailure(tool, direction, constraint, "non_empty");
      }
    }

    if (constraint.max_length !== undefined) {
      if (typeof value !== "string") {
        throwPayloadConstraintFailure(tool, direction, constraint, "expected_text_for_max_length");
      }
      if (value.length > constraint.max_length) {
        throwPayloadConstraintFailure(tool, direction, constraint, "max_length", {
          observedLength: value.length,
        });
      }
    }

    if (constraint.min !== undefined) {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throwPayloadConstraintFailure(tool, direction, constraint, "expected_number_for_min");
      }
      if (value < constraint.min) {
        throwPayloadConstraintFailure(tool, direction, constraint, "min");
      }
    }

    if (constraint.max !== undefined) {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throwPayloadConstraintFailure(tool, direction, constraint, "expected_number_for_max");
      }
      if (value > constraint.max) {
        throwPayloadConstraintFailure(tool, direction, constraint, "max");
      }
    }

    if (constraint.allowed_values !== undefined) {
      if (!isPortablePayloadConstraintScalar(value)) {
        throwPayloadConstraintFailure(tool, direction, constraint, "expected_scalar_for_allowed_values");
      }
      if (!constraint.allowed_values.some((allowedValue) => Object.is(allowedValue, value))) {
        throwPayloadConstraintFailure(tool, direction, constraint, "allowed_values");
      }
    }

    if (constraint.min_items !== undefined) {
      if (!Array.isArray(value)) {
        throwPayloadConstraintFailure(tool, direction, constraint, "expected_list_for_min_items");
      }
      if (value.length < constraint.min_items) {
        throwPayloadConstraintFailure(tool, direction, constraint, "min_items", {
          observedLength: value.length,
        });
      }
    }

    if (constraint.max_items !== undefined) {
      if (!Array.isArray(value)) {
        throwPayloadConstraintFailure(tool, direction, constraint, "expected_list_for_max_items");
      }
      if (value.length > constraint.max_items) {
        throwPayloadConstraintFailure(tool, direction, constraint, "max_items", {
          observedLength: value.length,
        });
      }
    }
  }
}

/**
 * @param {unknown} value
 * @returns {value is PortablePayloadConstraintScalar}
 */
export function isPortablePayloadConstraintScalar(value) {
  if (typeof value === "string" || typeof value === "boolean") {
    return true;
  }
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * @param {unknown} value
 * @returns {PayloadValueKind}
 */
export function payloadValueKind(value) {
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return "array";
  }
  if (typeof value === "number" && Number.isInteger(value)) {
    return "integer";
  }
  return typeof value;
}

/**
 * @param {unknown} rootValue
 * @param {string[]} segments
 * @returns {{ found: true, value: unknown } | { found: false }}
 */
function payloadConstraintValueAtPath(rootValue, segments) {
  if (segments.length === 0) {
    return { found: true, value: rootValue };
  }
  let current = rootValue;
  for (const segment of segments) {
    if (!isPlainRecord(current) || !Object.hasOwn(current, segment)) {
      return { found: false };
    }
    current = current[segment];
  }
  return { found: true, value: current };
}

/**
 * @param {AirTool} tool
 * @param {PayloadDirection} direction
 * @param {PayloadConstraint} constraint
 * @param {string} reason
 * @param {PayloadConstraintFailureExtra} [extra]
 * @throws {RuntimeFailure}
 * @returns {never}
 */
function throwPayloadConstraintFailure(tool, direction, constraint, reason, extra = {}) {
  throw new RuntimeFailure(
    `tool ${direction} payload constraint violation for ${tool.id} at ${constraint.path}: ${reason}`,
    {
      toolRef: tool.id,
      direction,
      constraintPath: constraint.path,
      constraint: reason,
      constraintLimitValue: payloadConstraintLimitValue(constraint, reason),
      allowedValuesCount: constraint.allowed_values?.length,
      observedLength: extra.observedLength,
    },
    "ToolPayloadConstraintViolation",
  );
}

/**
 * @param {PayloadConstraint} constraint
 * @param {string} reason
 * @returns {unknown}
 */
function payloadConstraintLimitValue(constraint, reason) {
  if (reason === "max_length") {
    return constraint.max_length;
  }
  if (reason === "min") {
    return constraint.min;
  }
  if (reason === "max") {
    return constraint.max;
  }
  if (reason === "allowed_values") {
    return constraint.allowed_values?.length;
  }
  if (reason === "min_items") {
    return constraint.min_items;
  }
  if (reason === "max_items") {
    return constraint.max_items;
  }
  return undefined;
}

/**
 * @param {unknown} value
 * @param {string} typeRef
 * @param {PayloadValidationContext} context
 * @param {SchemaFailureDetails} details
 */
function validatePayloadValue(value, typeRef, context, details) {
  if (typeof typeRef !== "string" || typeRef.trim() === "") {
    return;
  }

  if (typeRef === BUILTIN_TEXT) {
    if (typeof value !== "string") {
      throwToolSchemaFailure("expected Text", value, typeRef, details);
    }
    return;
  }

  if (typeRef === BUILTIN_BOOLEAN) {
    if (typeof value !== "boolean") {
      throwToolSchemaFailure("expected Boolean", value, typeRef, details);
    }
    return;
  }

  if (typeRef === BUILTIN_INT) {
    if (typeof value !== "number" || !Number.isSafeInteger(value)) {
      throwToolSchemaFailure("expected Int in V1 safe integer domain", value, typeRef, details);
    }
    return;
  }

  if (typeRef === BUILTIN_FLOAT) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throwToolSchemaFailure("expected finite Float", value, typeRef, details);
    }
    return;
  }

  if (typeRef.startsWith("optional:")) {
    if (!isPlainRecord(value) || !Object.hasOwn(value, "present")
      || typeof value.present !== "boolean"
      || Object.keys(value).length !== (value.present ? 2 : 1)
      || (value.present && !Object.hasOwn(value, "value"))) {
      throwToolSchemaFailure("expected explicit Optional envelope", value, typeRef, details);
    }
    if (value.present) validatePayloadValue(value.value, typeRef.slice(9), context, {
      ...details, path: `${details.path}.value`,
    });
    return;
  }

  if (typeRef.startsWith("list:")) {
    if (!Array.isArray(value)) {
      throwToolSchemaFailure("expected List", value, typeRef, details);
    }
    const itemTypeRef = typeRef.slice("list:".length);
    for (let index = 0; index < value.length; index += 1) {
      validatePayloadValue(value[index], itemTypeRef, context, {
        ...details,
        path: `${details.path}[${index}]`,
      });
    }
    return;
  }

  const localType = context.indexes.types.get(typeRef);
  if (!localType) {
    throwToolSchemaFailure("unresolved payload type", value, typeRef, details);
  }

  if (Array.isArray(localType.variants)) {
    if (typeof value !== "string" || !localType.variants.some(variant => variant.name === value)) {
      throwToolSchemaFailure("expected a declared enum member", value, typeRef, details);
    }
    return;
  }

  if (!isPlainRecord(value)) {
    throwToolSchemaFailure("expected object for local Touba type", value, typeRef, details);
  }

  const fields = Array.isArray(localType.fields) ? localType.fields : [];
  const expectedFieldNames = new Set(fields.map((field) => field.name));
  const actualFieldNames = Object.keys(value);
  const missingFields = fields
    .filter((field) => !Object.hasOwn(value, field.name))
    .map((field) => field.name);
  const unknownFields = actualFieldNames.filter((fieldName) => !expectedFieldNames.has(fieldName));

  if (missingFields.length > 0) {
    throwToolSchemaFailure("missing fields for local Touba type", value, typeRef, {
      ...details,
      missingFields,
    });
  }

  if (unknownFields.length > 0) {
    throwToolSchemaFailure("unknown fields for local Touba type", value, typeRef, {
      ...details,
      unknownFields,
    });
  }

  for (const field of fields) {
    validatePayloadValue(value[field.name], field.type_ref, context, {
      ...details,
      path: `${details.path}.${field.name}`,
    });
  }
}

/**
 * @param {string} reason
 * @param {unknown} value
 * @param {string} expectedTypeRef
 * @param {SchemaFailureDetails} details
 * @throws {RuntimeFailure}
 * @returns {never}
 */
function throwToolSchemaFailure(reason, value, expectedTypeRef, details) {
  const entry = details.errorCode === "EntryInputSchemaInvalid";
  throw new RuntimeFailure(
    `${entry ? "entry" : "tool"} ${details.direction} payload schema invalid for ${details.toolRef} at ${details.path}: ${reason}`,
    {
      ...(entry ? { entryRef: details.toolRef } : { toolRef: details.toolRef }),
      direction: details.direction,
      schemaPath: details.path,
      expectedTypeRef,
      actualType: payloadValueKind(value),
      missingFields: details.missingFields,
      unknownFieldCount: details.unknownFields?.length,
    },
    details.errorCode,
  );
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isPlainRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
