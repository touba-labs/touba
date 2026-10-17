export function buildAirInputContract({ air, definition, kind }) {
  const typeDefinitions = Array.isArray(air?.definitions?.types) ? air.definitions.types : [];
  if (kind === "agent") {
    return buildAgentInputContract({ air, agent: definition, typeDefinitions });
  }
  if (kind === "trigger") {
    return buildTriggerInputContract({ air, trigger: definition, typeDefinitions });
  }
  return declaredInputContract(definition.signature?.inputs, typeDefinitions);
}

function buildAgentInputContract({ air, agent, typeDefinitions }) {
  if (!agent?.signature || typeof agent.signature !== "object") {
    return emptyInputContract("open");
  }
  return declaredInputContract(agent.signature.inputs, typeDefinitions);
}

export function unavailableAirInputContract() {
  return emptyInputContract("unavailable");
}

function buildTriggerInputContract({ air, trigger, typeDefinitions }) {
  const target = (air?.definitions?.strategies ?? []).find((definition) => definition.id === trigger.target_ref);
  if (target === undefined) {
    return emptyInputContract("unavailable");
  }
  const staticInputs = new Set((trigger.arguments ?? []).map((argument) => argument.input));
  const dynamicInputs = (target.signature?.inputs ?? []).filter((input) => !staticInputs.has(input.name));
  return declaredInputContract(dynamicInputs, typeDefinitions);
}

function declaredInputContract(inputs, typeDefinitions) {
  const fields = (Array.isArray(inputs) ? inputs : []).map((input) => ({
    name: input.name,
    type_ref: input.type_ref,
    required: true,
  }));
  if (fields.length === 0) {
    return emptyInputContract("none");
  }
  return {
    mode: "declared",
    fields,
    types: reachableInputTypes(fields, typeDefinitions),
  };
}

function emptyInputContract(mode) {
  return { mode, fields: [], types: [] };
}

function reachableInputTypes(fields, typeDefinitions) {
  const definitionsByRef = new Map((typeDefinitions ?? [])
    .filter((definition) => nonEmptyString(definition.id) !== undefined)
    .map((definition) => [definition.id, definition]));
  const reachable = new Map();
  const visit = (typeRef) => {
    let nestedRef = typeRef;
    while (typeof nestedRef === "string" && /^(list|optional):/u.test(nestedRef)) {
      nestedRef = nestedRef.slice(nestedRef.indexOf(":") + 1);
    }
    const definition = definitionsByRef.get(nestedRef);
    if (definition === undefined || reachable.has(nestedRef)) {
      return;
    }
    const typeFields = (definition.fields ?? []).map((field) => ({
      name: field.name,
      type_ref: field.type_ref,
      required: true,
    }));
    reachable.set(nestedRef, {
      ref: nestedRef,
      name: nonEmptyString(definition.name) ?? nestedRef,
      fields: typeFields,
      ...(definition.variants ? { enum_values: definition.variants.map(variant => variant.name) } : {}),
    });
    for (const field of typeFields) {
      visit(field.type_ref);
    }
  };
  for (const field of fields) {
    visit(field.type_ref);
  }
  return [...reachable.values()].sort((left, right) => left.ref.localeCompare(right.ref));
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}
