export function validateObject(schema, value, path = "$") {
  const diagnostics = [];
  validateSchemaNode(schema, value, path, diagnostics, schema);
  return diagnostics;
}

function validateSchemaNode(schema, value, path, diagnostics, root, depth = 0) {
  if (depth > 100) {
    diagnostics.push(error("SchemaDepthExceeded", `${path} exceeds the supported nesting depth`, path));
    return;
  }
  if (!isObject(schema)) {
    diagnostics.push(error("SchemaNodeInvalid", `${path} schema node must be an object`, path));
    return;
  }
  if (schema.$ref) {
    const ref = schema.$ref;
    const target = typeof ref === "string" && ref.startsWith("#/")
      ? ref.slice(2).split("/").reduce((node, key) => node?.[key.replaceAll("~1", "/").replaceAll("~0", "~")], root) : undefined;
    if (!target) diagnostics.push(error("SchemaReferenceInvalid", `${path} contains an unresolved local reference`, path));
    else validateSchemaNode(target, value, path, diagnostics, root, depth + 1);
  }
  if (Array.isArray(schema.anyOf) && !schema.anyOf.some(branch => matchesBranch(branch, value, path, root, depth + 1))) {
    diagnostics.push(error("AnyOfMismatch", `${path} matches no declared alternative`, path));
  }
  if (Array.isArray(schema.oneOf) && schema.oneOf.filter(branch => matchesBranch(branch, value, path, root, depth + 1)).length !== 1) {
    diagnostics.push(error("OneOfMismatch", `${path} must match exactly one declared alternative`, path));
  }
  if (Object.hasOwn(schema, "const") && value !== schema.const) {
    diagnostics.push(error("ConstMismatch", `${path} must be ${JSON.stringify(schema.const)}`, path));
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    diagnostics.push(error("EnumMismatch", `${path} must be one of ${schema.enum.join(", ")}`, path));
  }
  if (schema.type !== undefined && !matchesType(value, schema.type)) {
    diagnostics.push(error("TypeMismatch", `${path} must be ${formatType(schema.type)}`, path));
    return;
  }
  if (typeof value === "string") {
    if (schema.minLength !== undefined || schema.maxLength !== undefined) {
      let length = 0;
      for (const _character of value) length += 1;
      if (schema.minLength !== undefined && length < schema.minLength) diagnostics.push(error("StringTooShort", `${path} is too short`, path));
      if (schema.maxLength !== undefined && length > schema.maxLength) diagnostics.push(error("StringTooLong", `${path} is too long`, path));
    }
    if (schema.pattern && !new RegExp(schema.pattern, "u").test(value)) diagnostics.push(error("PatternMismatch", `${path} does not match its declared pattern`, path));
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) diagnostics.push(error("NumberTooSmall", `${path} is below its minimum`, path));
    if (schema.maximum !== undefined && value > schema.maximum) diagnostics.push(error("NumberTooLarge", `${path} exceeds its maximum`, path));
  }
  if (isObject(value) && typeof schema.maxProperties === "number" && Object.keys(value).length > schema.maxProperties) {
    diagnostics.push(error("ObjectTooManyProperties", `${path} exceeds its property limit`, path));
  }
  if (schema.type === "object" || (schema.properties && isObject(value))) {
    validateObjectNode(schema, value, path, diagnostics, root, depth);
  }
  if (schema.type === "array" || (schema.items && Array.isArray(value))) {
    validateArrayNode(schema, value, path, diagnostics, root, depth);
  }
}

function matchesBranch(schema, value, path, root, depth) {
  const diagnostics = [];
  validateSchemaNode(schema, value, path, diagnostics, root, depth);
  return diagnostics.length === 0;
}

function validateObjectNode(schema, value, path, diagnostics, root, depth) {
  if (!isObject(value)) {
    diagnostics.push(error("TypeMismatch", `${path} must be object`, path));
    return;
  }
  for (const key of schema.required ?? []) {
    if (!Object.hasOwn(value, key)) {
      diagnostics.push(error("RequiredPropertyMissing", `${path}.${key} is required`, path));
    }
  }
  const properties = schema.properties ?? {};
  for (const [key, item] of Object.entries(value)) {
    if (Object.hasOwn(properties, key)) {
      validateSchemaNode(properties[key], item, `${path}.${key}`, diagnostics, root, depth + 1);
    } else if (schema.additionalProperties === false) {
      diagnostics.push(error("AdditionalPropertyRejected", `${path}.${key} is not allowed`, path));
    } else if (isObject(schema.additionalProperties)) {
      validateSchemaNode(schema.additionalProperties, item, `${path}.${key}`, diagnostics, root, depth + 1);
    }
  }
}

function validateArrayNode(schema, value, path, diagnostics, root, depth) {
  if (!Array.isArray(value)) {
    diagnostics.push(error("TypeMismatch", `${path} must be array`, path));
    return;
  }
  if (typeof schema.minItems === "number" && value.length < schema.minItems) {
    diagnostics.push(error("ArrayTooShort", `${path} must contain at least ${schema.minItems} item(s)`, path));
  }
  if (typeof schema.maxItems === "number" && value.length > schema.maxItems) diagnostics.push(error("ArrayTooLong", `${path} exceeds its item limit`, path));
  if (schema.uniqueItems && new Set(value.map(canonicalValue)).size !== value.length) diagnostics.push(error("ArrayItemsNotUnique", `${path} must contain unique items`, path));
  if (schema.items) {
    for (const [index, item] of value.entries()) {
      validateSchemaNode(schema.items, item, `${path}[${index}]`, diagnostics, root, depth + 1);
    }
  }
}

function canonicalValue(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalValue).join(",")}]`;
  if (isObject(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalValue(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function matchesType(value, expected) {
  const expectedTypes = Array.isArray(expected) ? expected : [expected];
  return expectedTypes.some((type) => {
    if (type === "array") {
      return Array.isArray(value);
    }
    if (type === "integer") {
      return Number.isInteger(value);
    }
    if (type === "number") {
      return typeof value === "number" && Number.isFinite(value);
    }
    if (type === "null") {
      return value === null;
    }
    if (type === "object") {
      return isObject(value);
    }
    return typeof value === type;
  });
}

function formatType(type) {
  return Array.isArray(type) ? type.join(" or ") : type;
}

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function error(code, message, path) {
  return { severity: "error", code, message, path };
}
