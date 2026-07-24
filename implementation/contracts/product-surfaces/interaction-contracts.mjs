const PRIMARY_TEXT_FIELD_NAMES = Object.freeze([
  "message",
  "prompt",
  "query",
  "goal",
  "workflow_goal",
  "instruction",
  "text",
  "content",
]);

const MEDIA_HANDLE_TYPES = Object.freeze({
  AudioHandle: "audio",
  DocumentHandle: "document",
  FileHandle: "file",
  ImageHandle: "image",
});

export function buildInteractionContract({ generatedFields = [], inputContract, kind }) {
  const fields = flattenInputFields(inputContract);
  const textFields = fields.filter((field) => field.type_ref === "builtin:Text");
  const namedPrimaryFields = textFields.filter((field) => (
    PRIMARY_TEXT_FIELD_NAMES.includes(field.name.toLowerCase())
  ));
  const primary = namedPrimaryFields.length === 1
    ? namedPrimaryFields[0]
    : namedPrimaryFields.length === 0 && textFields.length === 1
      ? textFields[0]
      : undefined;
  const mediaFields = fields
    .map((field) => ({
      ...field,
      content_kind: mediaKindForType(field.type_ref, inputContract),
    }))
    .filter((field) => field.content_kind !== undefined)
    .map((field) => ({
      path: field.path,
      content_kind: field.content_kind,
      type_ref: field.type_ref,
      multiple: false,
    }));
  return {
    presentation: presentationForKind(kind),
    primary_input_path: primary?.path ?? [],
    context_paths: fields
      .filter((field) => field !== primary && !mediaFields.some((media) => samePath(media.path, field.path)))
      .map((field) => field.path),
    accepted_content_kinds: [
      ...(primary === undefined ? [] : ["text"]),
      ...new Set(mediaFields.map((field) => field.content_kind)),
    ],
    media_fields: mediaFields,
    generated_fields: generatedFields.map((field) => ({
      path: [...field.path],
      generator: field.generator,
      ...(field.prefix === undefined ? {} : { prefix: field.prefix }),
    })),
  };
}

function presentationForKind(kind) {
  if (kind === "agent") return "conversation";
  if (kind === "strategy") return "workflow";
  if (kind === "trigger") return "event";
  return "invocation";
}

function flattenInputFields(contract) {
  if (contract?.mode !== "declared") return [];
  const typesByRef = new Map((contract.types ?? []).map((type) => [type.ref, type]));
  const fields = [];
  const visit = (field, path, seen = new Set()) => {
    fields.push({ ...field, path });
    const definition = typesByRef.get(field.type_ref);
    if (definition === undefined || seen.has(field.type_ref)) return;
    const nestedSeen = new Set(seen).add(field.type_ref);
    for (const child of definition.fields ?? []) {
      visit(child, [...path, child.name], nestedSeen);
    }
  };
  for (const field of contract.fields ?? []) {
    visit(field, [field.name]);
  }
  return fields;
}

function mediaKindForType(typeRef, contract) {
  const definition = (contract?.types ?? []).find((type) => type.ref === typeRef);
  const kind = MEDIA_HANDLE_TYPES[definition?.name];
  if (kind === undefined || !isCanonicalMediaHandle(definition)) return undefined;
  return kind;
}

function isCanonicalMediaHandle(definition) {
  const fields = new Map((definition?.fields ?? []).map((field) => [field.name, field.type_ref]));
  return fields.get("handle") === "builtin:Text"
    && fields.get("name") === "builtin:Text"
    && fields.get("media_type") === "builtin:Text"
    && fields.get("size_bytes") === "builtin:Int"
    && fields.get("digest") === "builtin:Text";
}

function samePath(left, right) {
  return left.length === right.length && left.every((segment, index) => segment === right[index]);
}
