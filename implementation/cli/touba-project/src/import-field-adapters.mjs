// Generated adapters keep wire names and explicit Touba optional values distinct.
export function renderImportedField(field) {
  return `    ${field.name} is ${field.required ? field.type : `Optional of ${field.type} default none(${field.type})`}`;
}

export function renderJsonFieldAdapters(tool) {
  return `const INPUT_FIELDS = ${JSON.stringify(tool.inputFields)};
const OUTPUT_FIELDS = ${JSON.stringify(tool.outputFields)};

function toJsonRequest(request) {
  return toJsonRecord(request, INPUT_FIELDS);
}

function toJsonRecord(request, fields) {
  if (!request || typeof request !== "object" || Array.isArray(request)) throw new ToubaHandlerError("InvalidArguments", "expected an input record");
  const entries = [];
  for (const field of fields) {
    let value = request[field.name];
    if (!field.required) {
      if (value === undefined || value?.present === false) continue;
      if (value?.present !== true || !Object.hasOwn(value, "value")) {
        throw new ToubaHandlerError("InvalidArguments", "expected an explicit optional value");
      }
      value = value.value;
    }
    if (value === null || value === undefined) {
      throw new ToubaHandlerError("InvalidArguments", "required input value is missing");
    }
    entries.push([field.originalName, convertNested(value, field, true)]);
  }
  return Object.fromEntries(entries);
}

function fromJsonResult(result) {
  return fromJsonRecord(result, OUTPUT_FIELDS);
}

function fromJsonRecord(result, fields) {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new ToubaHandlerError("InvalidOutput", "expected a JSON object result");
  }
  return Object.fromEntries(fields.map(field => {
    const present = Object.hasOwn(result, field.originalName);
    let value = result[field.originalName];
    if ((field.required && !present) || (present && (value === null || value === undefined))) {
      throw new ToubaHandlerError("InvalidOutput", "result does not match the imported schema");
    }
    if (present) value = convertNested(value, field, false);
    return [field.name, field.required ? value : present ? { present: true, value } : { present: false }];
  }));
}

function convertNested(value, field, input) {
  if (field.item) {
    if (!Array.isArray(value)) throw new ToubaHandlerError(input ? "InvalidArguments" : "InvalidOutput", "expected an array");
    return value.map(item => convertNested(item, field.item, input));
  }
  if (field.fields) return input ? toJsonRecord(value, field.fields) : fromJsonRecord(value, field.fields);
  return value;
}
`;
}
