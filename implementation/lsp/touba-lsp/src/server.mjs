import {
  CompletionItemKind,
  createConnection,
  DiagnosticSeverity,
  SymbolKind,
  TextDocuments,
  TextDocumentSyncKind,
} from "vscode-languageserver/node.js";
import { TextDocument } from "vscode-languageserver-textdocument";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { compilerInputsForFile } from "../../../cli/touba-project/src/project.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const implDir = process.env.TOUBA_IMPLEMENTATION_DIR
  ? resolve(process.env.TOUBA_IMPLEMENTATION_DIR)
  : join(__dir, "../../..");

let connection = null;
let documents = null;

// Keep editor URI mappings outside AIR; unsaved source is supplied on stdin.
const airCache = new Map();

export function startServer() {
  if (connection) {
    return;
  }

  connection = createConnection();
  documents = new TextDocuments(TextDocument);

  connection.onInitialize(() => ({
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Full,
      documentSymbolProvider: true,
      hoverProvider: true,
      definitionProvider: true,
      completionProvider: {},
    },
  }));

  documents.onDidChangeContent(({ document }) => {
    validate(document);
  });

  documents.onDidClose(({ document }) => {
    airCache.delete(document.uri);
    connection.sendDiagnostics({ uri: document.uri, diagnostics: [] });
  });

  connection.onDocumentSymbol(({ textDocument }) => {
    const cached = airCache.get(textDocument.uri);
    if (!cached) return [];
    return extractSymbols(cached.air, textDocument.uri, cached.sourceUris);
  });

  connection.onHover(({ textDocument, position }) => {
    const cached = airCache.get(textDocument.uri);
    if (!cached) return null;
    const value = hoverForPosition(cached.air, position, textDocument.uri, cached.sourceUris);
    return value ? { contents: { kind: "plaintext", value } } : null;
  });

  connection.onDefinition(({ textDocument, position }) => {
    const cached = airCache.get(textDocument.uri);
    if (!cached) return null;
    return definitionForPosition(cached.air, textDocument.uri, position, cached.sourceUris);
  });

  connection.onCompletion(({ textDocument, position }) => {
    const document = documents.get(textDocument.uri);
    const air = airCache.get(textDocument.uri)?.air;
    return completionForPosition(air, document?.getText() ?? "", position);
  });

  documents.listen(connection);
  connection.listen();
}

function validate(document) {
  try {
    const sourcePath = document.uri.startsWith("file:") ? fileURLToPath(document.uri) : document.uri;
    const context = document.uri.startsWith("file:") ? compilerInputsForFile(sourcePath) : {};
    const result = context.diagnostics?.length ? { ok: false, air: null, diagnostics: context.diagnostics }
      : runToubaCompileJson(sourcePath, { ...context, sourceText: document.getText() });
    const sourceUris = new Map([[resolve(sourcePath), document.uri], [sourcePath, document.uri]]);
    if (existsSync(sourcePath)) sourceUris.set(realpathSync(sourcePath), document.uri);
    if (result.air && typeof result.source_root === "string") {
      const visit = value => {
        if (!value || typeof value !== "object") return;
        const id = value.source_ref?.source_id;
        if (typeof id === "string") {
          const path = resolve(result.source_root, id);
          sourceUris.set(id, sourceUris.get(path) ?? pathToFileURL(path).href);
        }
        for (const child of Object.values(value)) visit(child);
      };
      visit(result.air);
    }
    publishResult(document.uri, result, sourceUris, document.getText());
  } catch (e) {
    // A failed compiler is not evidence that a document is valid.
    airCache.delete(document.uri);
    connection.sendDiagnostics({ uri: document.uri, diagnostics: [{
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
      severity: DiagnosticSeverity.Error,
      source: "touba",
      code: "CompilerUnavailable",
      message: "Touba could not validate this document. Check the selected toolchain and TOUBA_COMPILE_BIN configuration, then reopen the document.",
    }] });
  }
}

function publishResult(uri, result, sourceUris, sourceText) {
  if (result.ok && result.air) {
    airCache.set(uri, { air: result.air, sourceUris });
  } else {
    airCache.delete(uri);
  }
  const diagnostics = [...(result.diagnostics ?? []), ...(result.warnings ?? []).map(w => ({ ...w, severity: "warning" }))]
    .map((diagnostic) => diagnosticForDocument(diagnostic, uri, sourceUris, sourceText));
  connection.sendDiagnostics({ uri, diagnostics });
}

export function diagnosticForDocument(diagnostic, uri, sourceUris, sourceText) {
  const ref = diagnostic.source_ref;
  const location = ref && locationForSourceRef(uri, ref, sourceUris);
  if (!location || location.uri === uri) return toLspDiagnostic(diagnostic, sourceText);
  let dependencyText;
  try { dependencyText = readFileSync(fileURLToPath(location.uri), "utf8"); } catch { /* The source may have been removed. */ }
  const dependencyDiagnostic = toLspDiagnostic(diagnostic, dependencyText);
  return {
    ...toLspDiagnostic({ ...diagnostic, source_ref: undefined }, sourceText),
    message: `Dependency ${ref.source_id}: ${diagnostic.message}`,
    relatedInformation: [{ location: { ...location, range: dependencyDiagnostic.range }, message: diagnostic.message }],
  };
}

export function compilerCommandSpec(sourcePath, {
  implementationDir = implDir,
  env = process.env,
  platform = process.platform,
  sourceText,
  sourceRoots = [],
  moduleSourcePaths = [],
} = {}) {
  const args = ["--json", ...(sourceText === undefined ? [] : ["--stdin"]),
    ...sourceRoots.flatMap(root => ["--source-root", root]),
    ...moduleSourcePaths.flatMap(path => ["--module-source", path]), sourcePath];
  if (env.TOUBA_COMPILE_BIN) {
    return { command: env.TOUBA_COMPILE_BIN, args };
  }
  const executableName = platform === "win32" ? "touba-compile.exe" : "touba-compile";
  const packagedCompiler = join(implementationDir, "bin", executableName);
  if (existsSync(packagedCompiler)) {
    return { command: packagedCompiler, args };
  }
  const cargoManifest = join(implementationDir, "Cargo.toml");
  if (![
    cargoManifest,
    join(implementationDir, "compiler", "touba-compiler", "Cargo.toml"),
    join(implementationDir, "cli", "touba-cli", "Cargo.toml"),
  ].every((file) => existsSync(file))) {
    throw new Error(`Touba compiler unavailable: provide ${packagedCompiler} or set TOUBA_COMPILE_BIN; Cargo requires local compiler sources.`);
  }
  return {
    command: env.CARGO ?? "cargo",
    args: ["run", "--manifest-path", cargoManifest, "-p", "touba-cli", "--bin", "touba-compile", "--quiet", "--", ...args],
  };
}

export function runToubaCompileJson(sourcePath, options = {}) {
  const compiler = compilerCommandSpec(sourcePath, options);
  try {
    const raw = execFileSync(
      compiler.command,
      compiler.args,
      { encoding: "utf8", input: options.sourceText, stdio: ["pipe", "pipe", "pipe"], env: options.env ?? process.env },
    );
    return parseCompilerEnvelope(raw);
  } catch (error) {
    const envelope = tryParseCompilerEnvelopeFromExecError(error);
    if (envelope) {
      return envelope;
    }
    throw error;
  }
}

export function parseCompilerEnvelope(raw) {
  const result = JSON.parse(raw);
  if (result?.warnings !== undefined && (!Array.isArray(result.warnings)
    || result.warnings.some(d => !d || typeof d.code !== "string" || typeof d.message !== "string"))) {
    throw new Error("Invalid Touba compiler warnings");
  }
  if (!result || typeof result.ok !== "boolean" || !Array.isArray(result.diagnostics)
    || result.diagnostics.some(d => !d || typeof d.code !== "string" || typeof d.message !== "string")
    || (result.ok ? result.diagnostics.length !== 0 || !result.air
      || typeof result.air.module?.name !== "string"
      || !result.air.definitions || !Array.isArray(result.air.execution_graphs)
      : result.air !== null || result.diagnostics.length === 0)) {
    throw new Error("Invalid Touba compiler response: expected an AIR document or explicit diagnostics.");
  }
  return result;
}

export function tryParseCompilerEnvelopeFromExecError(error) {
  const raw = normalizeExecOutput(error?.stdout);
  if (!raw) {
    return null;
  }
  try {
    return parseCompilerEnvelope(raw);
  } catch {
    return null;
  }
}

function normalizeExecOutput(output) {
  if (typeof output === "string") {
    return output.trim().length > 0 ? output : null;
  }
  if (Buffer.isBuffer(output)) {
    const decoded = output.toString("utf8");
    return decoded.trim().length > 0 ? decoded : null;
  }
  return null;
}

export function toLspDiagnostic(d, sourceText) {
  // Tree-sitter columns are UTF-8 bytes; LSP defaults to UTF-16 code units.
  const lines = sourceText?.split("\n");
  const position = (line, byteColumn) => ({
    line,
    character: lines?.[line] === undefined ? byteColumn
      : Buffer.from(lines[line], "utf8").subarray(0, byteColumn).toString("utf8").length,
  });
  const ref = d.source_ref;
  const range = ref
    ? {
        start: position(ref.start_line, ref.start_column),
        end: position(ref.end_line, ref.end_column),
      }
    : { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } };
  return {
    range,
    severity: d.severity === "warning" ? DiagnosticSeverity.Warning : DiagnosticSeverity.Error,
    source: "touba",
    message: d.message,
    code: d.code,
  };
}

export function extractSymbols(air, uri, sourceUris) {
  const symbols = [];

  if (air.module?.name && air.module?.source_ref) {
    symbols.push({
      name: air.module.name,
      kind: SymbolKind.Module,
      location: locationForSourceRef(uri, air.module.source_ref, sourceUris),
    });
  }

  const defs = air.definitions ?? {};
  for (const item of air.imports ?? []) {
    const ref = item.source_ref;
    if (!ref) continue;
    symbols.push({
      name: `${item.kind} ${item.name}`,
      kind: SymbolKind.Namespace,
      location: locationForSourceRef(uri, ref, sourceUris),
    });
  }

  for (const [definitionKey, symbolKind] of [
    ["constants", SymbolKind.Constant],
    ["types", SymbolKind.Struct],
    ["functions", SymbolKind.Function],
    ["tools", SymbolKind.Interface],
    ["memories", SymbolKind.Variable],
    ["skills", SymbolKind.Class],
    ["agents", SymbolKind.Object],
    ["strategies", SymbolKind.Module],
    ["triggers", SymbolKind.Event],
  ]) {
    for (const item of defs[definitionKey] ?? []) {
      const ref = item.source_ref;
      if (!ref) continue;
      symbols.push({
        name: item.name,
        kind: item.variants ? SymbolKind.Enum : symbolKind,
        location: locationForSourceRef(uri, ref, sourceUris),
      });
      for (const variant of item.variants ?? []) {
        symbols.push({ name: variant.name, containerName: item.name, kind: SymbolKind.EnumMember,
          location: locationForSourceRef(uri, variant.source_ref, sourceUris) });
      }
    }
  }
  return symbols;
}

export function hoverForPosition(air, position, uri, sourceUris) {
  position = { ...position, uri, sourceUris };
  const member = findEnumMember(air, position);
  if (member) return `${member.type.name}.${member.variant.name}\ntype: ${member.type.id}`;
  const importDeclaration = findHoverImport(air, position);
  if (importDeclaration) {
    return renderHoverImport(importDeclaration);
  }
  const declaration = findHoverDeclaration(air, position);
  if (declaration) {
    return renderHoverDeclaration(declaration);
  }
  const humanApproval = findHoverHumanApproval(air, position);
  if (humanApproval) {
    return renderHoverHumanApproval(humanApproval);
  }
  const userInteraction = findHoverUserInteraction(air, position);
  if (userInteraction) {
    return renderHoverUserInteraction(userInteraction);
  }
  const bindNode = findHoverBind(air, position);
  if (bindNode) {
    return renderHoverBind(bindNode);
  }
  const call = findHoverCall(air, position);
  return call ? renderHoverCall(call) : null;
}

export function findHoverImport(air, position) {
  const definitions = indexDefinitionsById(air);
  for (const item of air.imports ?? []) {
    if (!containsPosition(position, item.source_ref)) continue;
    return {
      item,
      target: definitions.get(item.target_ref) ?? null,
    };
  }
  return null;
}

export function renderHoverImport({ item, target }) {
  const lines = [`import ${item.kind} ${item.name}`];
  pushIfPresent(lines, "from_module", item.from_module);
  pushIfPresent(lines, "target_ref", item.target_ref);
  lines.push(`status: ${target?.source_ref ? "resolved" : "unresolved"}`);
  return lines.join("\n");
}

export function findHoverDeclaration(air, position) {
  if (isOnDeclarationHeader(position, air.module?.source_ref)) {
    return { kind: "module", item: air.module };
  }

  const defs = air.definitions ?? {};
  for (const [definitionKey, kind] of [
    ["constants", "define"],
    ["types", "type"],
    ["functions", "function"],
    ["tools", "tool"],
    ["memories", "memory"],
    ["skills", "skill"],
    ["agents", "agent"],
    ["strategies", "strategy"],
    ["triggers", "trigger"],
  ]) {
    for (const item of defs[definitionKey] ?? []) {
      if (isOnDeclarationHeader(position, item.source_ref)) {
        return { kind: item.variants ? "enum" : kind, item };
      }
    }
  }

  return null;
}

export function renderHoverDeclaration({ kind, item }) {
  const lines = [`${kind} ${item.name}`];
  pushIfPresent(lines, "id", item.id);
  pushIfPresent(lines, "type", item.type_ref);
  pushConstantLiteral(lines, item);
  pushSignature(lines, item.signature);
  pushFields(lines, item.fields);
  pushList(lines, "members", item.variants?.map(variant => variant.name));
  pushList(lines, "uses", item.uses);
  pushCallableBy(lines, item.callable_by);
  pushMemoryAccesses(lines, item.memory_accesses);
  pushMemoryScopes(lines, item.memory_scopes);
  pushTriggerEvent(lines, item.event);
  pushTriggerArguments(lines, item.arguments);
  pushTriggerLimits(lines, item.limits);
  pushList(lines, "required_capabilities", item.required_capabilities);
  pushList(lines, "required_secrets", item.required_secrets);
  if (item.approval_policy !== undefined) {
    lines.push("human.approve: required for each operation");
    for (const [key, value] of Object.entries(item.approval_policy)) pushIfPresent(lines, key, value);
  }
  pushIfPresent(lines, "responsibility", item.responsibility);
  pushIfPresent(lines, "target_ref", item.target_ref);
  pushIfPresent(lines, "target_kind", item.target_kind);
  pushIfPresent(lines, "body_graph_ref", item.body_graph_ref);
  pushIfPresent(lines, "flow_graph_ref", item.flow_graph_ref);
  return lines.join("\n");
}

export function findHoverBind(air, position) {
  for (const graph of air.execution_graphs ?? []) {
    for (const node of graph.nodes ?? []) {
      if (node.kind !== "bind") continue;
      if (!containsPosition(position, node.source_ref)) continue;
      return { graph, node };
    }
  }
  return null;
}

export function renderHoverBind({ graph, node }) {
  const lines = [`bind ${node.result_binding ?? ""}`.trimEnd()];
  pushIfPresent(lines, "graph_ref", graph?.id);
  pushList(lines, "arguments", node.arguments);
  pushIfPresent(lines, "result_binding", node.result_binding);
  return lines.join("\n");
}

export function findHoverCall(air, position) {
  const definitions = indexDefinitionsById(air);
  for (const graph of air.execution_graphs ?? []) {
    for (const node of graph.nodes ?? []) {
      if (typeof node.target_ref !== "string") continue;
      if (!containsPosition(position, node.source_ref)) continue;
      return {
        graph,
        node,
        target: definitions.get(node.target_ref) ?? null,
      };
    }
  }
  return null;
}

export function renderHoverCall({ graph, node, target }) {
  const targetName = target?.name ?? node.target_ref;
  const lines = [`call ${targetName}`];
  pushIfPresent(lines, "target_ref", node.target_ref);
  pushIfPresent(lines, "graph_ref", graph?.id);
  pushList(lines, "arguments", node.arguments);
  pushIfPresent(lines, "result_binding", node.result_binding);
  return lines.join("\n");
}

export function findHoverHumanApproval(air, position) {
  for (const graph of air.execution_graphs ?? []) {
    for (const node of graph.nodes ?? []) {
      if (node.kind !== "human_approval") continue;
      if (!containsPosition(position, node.source_ref)) continue;
      return { graph, node };
    }
  }
  return null;
}

export function renderHoverHumanApproval({ graph, node }) {
  const lines = ["human approval"];
  pushIfPresent(lines, "approval_ref", node.approval_ref);
  pushIfPresent(lines, "mode", node.approval_mode);
  pushIfPresent(lines, "graph_ref", graph?.id);
  pushList(lines, "context_refs", node.context_refs);
  pushIfPresent(lines, "decision_binding", node.result_binding);
  for (const key of ["role", "timeout_ms", "distinct_from", "exclude_signers"]) {
    const value = node.approval_policy?.[key];
    pushIfPresent(lines, key, value === undefined ? undefined : String(value));
  }
  if (graph?.edges?.some(edge => edge.from_node_id === node.id && edge.role === "expired")) {
    lines.push("on expired: explicit source branch");
  }
  if (graph?.edges?.some(edge => edge.from_node_id === node.id && edge.role === "rejected")) {
    lines.push("on rejected: explicit source branch");
  }
  return lines.join("\n");
}

export function findHoverUserInteraction(air, position) {
  for (const graph of air.execution_graphs ?? []) {
    for (const node of graph.nodes ?? []) {
      if (node.kind !== "user_interaction") continue;
      if (!containsPosition(position, node.source_ref)) continue;
      return { graph, node };
    }
  }
  return null;
}

export function renderHoverUserInteraction({ graph, node }) {
  const lines = ["user interaction"];
  pushIfPresent(lines, "interaction_ref", node.interaction_ref);
  pushIfPresent(lines, "mode", node.interaction_mode);
  pushIfPresent(lines, "graph_ref", graph?.id);
  pushList(lines, "arguments", node.arguments);
  pushIfPresent(lines, "result_binding", node.result_binding);
  return lines.join("\n");
}

function pushSignature(lines, signature) {
  if (!signature) return;
  pushParameters(lines, signature.inputs);
  pushIfPresent(lines, "gives", signature.output_type);
}

function pushParameters(lines, inputs) {
  if (!Array.isArray(inputs) || inputs.length === 0) return;
  lines.push("takes:");
  for (const input of inputs) {
    lines.push(`- ${input.name}: ${input.type_ref}`);
  }
}

function pushFields(lines, fields) {
  if (!Array.isArray(fields) || fields.length === 0) return;
  lines.push("fields:");
  for (const field of fields) {
    lines.push(`- ${field.name}: ${field.type_ref}`);
  }
}

function pushConstantLiteral(lines, item) {
  if (!item || !item.id?.startsWith?.("constant:")) return;
  if (typeof item.literal_text === "string") {
    pushIfPresent(lines, "literal", JSON.stringify(item.literal_text));
    return;
  }
  if (typeof item.literal_boolean === "boolean") {
    pushIfPresent(lines, "literal", String(item.literal_boolean));
    return;
  }
  if (typeof item.literal_int === "number") {
    pushIfPresent(lines, "literal", String(item.literal_int));
    return;
  }
  if (typeof item.literal_float === "number") {
    pushIfPresent(lines, "literal", String(item.literal_float));
  }
}

function pushList(lines, label, values) {
  if (!Array.isArray(values) || values.length === 0) return;
  lines.push(`${label}:`);
  for (const value of values) {
    lines.push(`- ${value}`);
  }
}

function pushCallableBy(lines, values) {
  if (!Array.isArray(values) || values.length === 0) return;
  lines.push("callable_by:");
  for (const value of values) {
    lines.push(`- ${value.caller_ref}`);
  }
}

function pushMemoryAccesses(lines, values) {
  if (!Array.isArray(values) || values.length === 0) return;
  lines.push("memory_accesses:");
  for (const value of values) {
    lines.push(`- ${value.memory_ref} ${value.access}`);
  }
}

function pushMemoryScopes(lines, values) {
  if (!Array.isArray(values) || values.length === 0) return;
  lines.push("memory_scopes:");
  for (const value of values) {
    lines.push(`- ${value.memory_ref} ${value.access}`);
  }
}

function pushTriggerEvent(lines, event) {
  if (!event || typeof event !== "object") return;
  if (typeof event.kind === "string" || typeof event.value === "string") {
    lines.push(`event: ${event.kind ?? "unknown"} ${event.value ?? ""}`.trimEnd());
  }
}

function pushTriggerArguments(lines, values) {
  if (!Array.isArray(values) || values.length === 0) return;
  lines.push("trigger_arguments:");
  for (const value of values) {
    const input = value.input ?? "unknown";
    const valueRef = value.value_ref ?? "absent";
    lines.push(`- ${input}: ${valueRef}`);
  }
}

function pushTriggerLimits(lines, limits) {
  if (!limits || typeof limits !== "object") return;
  const parts = [];
  if (typeof limits.max_runs_per_day === "number") {
    parts.push(`max_runs_per_day=${limits.max_runs_per_day}`);
  }
  if (typeof limits.timeout_ms === "number") {
    parts.push(`timeout_ms=${limits.timeout_ms}`);
  }
  if (parts.length > 0) {
    lines.push(`limits: ${parts.join(" ")}`);
  }
}

function pushIfPresent(lines, label, value) {
  if (typeof value !== "string" || value.length === 0) return;
  lines.push(`${label}: ${value}`);
}

function isOnDeclarationHeader(position, ref) {
  if (!ref || typeof ref.start_line !== "number" || !isSourceRefInDocument(position, ref)) return false;
  if (position.line !== ref.start_line) return false;
  return position.character >= (ref.start_column ?? 0);
}

export function definitionForPosition(air, uri, position, sourceUris) {
  position = { ...position, uri, sourceUris };
  const member = findEnumMember(air, position);
  if (member) return locationForSourceRef(uri, member.variant.source_ref, sourceUris);
  const definitions = indexDefinitionsById(air);
  const reference = findReferenceAtPosition(air, position);
  if (!reference) return null;
  const target = definitions.get(reference.target_ref);
  return target?.source_ref ? locationForSourceRef(uri, target.source_ref, sourceUris) : null;
}

export function findReferenceAtPosition(air, position) {
  for (const item of air.imports ?? []) {
    if (containsPosition(position, item.source_ref)) {
      return { target_ref: item.target_ref };
    }
  }

  const defs = air.definitions ?? {};
  for (const definitionKey of ["skills", "agents", "strategies"]) {
    for (const item of defs[definitionKey] ?? []) {
      for (const useRef of item.use_refs ?? []) {
        if (containsPosition(position, useRef.source_ref)) {
          return { target_ref: useRef.target_ref };
        }
      }
      for (const authorityRef of item.callable_by ?? []) {
        if (containsPosition(position, authorityRef.source_ref)) {
          return { target_ref: authorityRef.caller_ref };
        }
      }
      for (const memoryScope of item.memory_scopes ?? []) {
        if (containsPosition(position, memoryScope.source_ref)) {
          return { target_ref: memoryScope.memory_ref };
        }
      }
    }
  }

  for (const tool of defs.tools ?? []) {
    for (const memoryAccess of tool.memory_accesses ?? []) {
      if (containsPosition(position, memoryAccess.source_ref)) {
        return { target_ref: memoryAccess.memory_ref };
      }
    }
  }

  for (const trigger of defs.triggers ?? []) {
    if (
      typeof trigger.target_ref === "string" &&
      containsPosition(position, trigger.source_ref) &&
      !containsPosition(position, trigger.event?.source_ref) &&
      !containsPosition(position, trigger.limits?.source_ref)
    ) {
      return { target_ref: trigger.target_ref };
    }
  }

  for (const graph of air.execution_graphs ?? []) {
    for (const node of graph.nodes ?? []) {
      if (typeof node.target_ref === "string" && containsPosition(position, node.source_ref)) {
        return { target_ref: node.target_ref };
      }
    }
  }

  return null;
}

export function completionForPosition(air, documentText, position) {
  const prefix = (documentText.split("\n")[position.line] ?? "").slice(0, position.character);
  const enumPrefix = /\b([A-Z][A-Za-z0-9_]*)\.([a-z_][A-Za-z0-9_]*)?$/u.exec(prefix);
  if (enumPrefix && isCompletionSupportedContext(documentText, position)) {
    const type = (air?.definitions?.types ?? []).find(type => type.name === enumPrefix[1] && type.variants);
    if (type) return type.variants.filter(member => member.name.startsWith(enumPrefix[2] ?? ""))
      .map(member => ({ label: member.name, kind: CompletionItemKind.EnumMember, detail: `${type.name}.${member.name}` }));
  }
  if (!isCompletionSupportedContext(documentText, position)) {
    return [];
  }
  return [...keywordCompletions(), ...declarationCompletions(air)];
}

function keywordCompletions() {
  return TOUBA_V01_KEYWORDS.map((keyword) => ({
    label: keyword,
    kind: CompletionItemKind.Keyword,
    detail: "Touba v0.1 keyword",
  }));
}

function declarationCompletions(air) {
  const defs = air?.definitions ?? {};
  const items = [];
  const seen = new Set();
  for (const [definitionKey, kindLabel, completionKind] of [
    ["constants", "define", CompletionItemKind.Constant],
    ["types", "type", CompletionItemKind.Class],
    ["functions", "function", CompletionItemKind.Function],
    ["tools", "tool", CompletionItemKind.Interface],
    ["memories", "memory", CompletionItemKind.Variable],
    ["skills", "skill", CompletionItemKind.Class],
    ["agents", "agent", CompletionItemKind.Object],
    ["strategies", "strategy", CompletionItemKind.Module],
    ["triggers", "trigger", CompletionItemKind.Event],
  ]) {
    for (const item of defs[definitionKey] ?? []) {
      if (!item.name) continue;
      if (seen.has(item.name)) continue;
      seen.add(item.name);
      items.push({
        label: item.name,
        kind: item.variants ? CompletionItemKind.Enum : completionKind,
        detail: `Touba ${item.variants ? "enum" : kindLabel} declaration`,
      });
    }
  }
  for (const item of air?.imports ?? []) {
    if (!item.name || seen.has(item.name)) continue;
    seen.add(item.name);
    items.push({
      label: item.name,
      kind: completionKindForImportKind(item.kind),
      detail: `Touba imported ${item.kind}`,
    });
  }
  return items.sort((left, right) => left.label.localeCompare(right.label));
}

function completionKindForImportKind(kind) {
  if (kind === "type") return CompletionItemKind.Class;
  if (kind === "define") return CompletionItemKind.Constant;
  if (kind === "function") return CompletionItemKind.Function;
  return CompletionItemKind.Reference;
}

function isCompletionSupportedContext(documentText, position) {
  const line = documentText.split(/\r?\n/u)[position.line] ?? "";
  const beforeCursor = line.slice(0, position.character);
  if (beforeCursor.trimStart().startsWith("#")) return false;
  if ((beforeCursor.match(/"/g) ?? []).length % 2 === 1) return false;
  return /^[\t A-Za-z_.]*$/u.test(beforeCursor);
}

function indexDefinitionsById(air) {
  const index = new Map();
  const defs = air.definitions ?? {};
  for (const definitionKey of ["constants", "types", "functions", "tools", "memories", "skills", "agents", "strategies", "triggers"]) {
    for (const item of defs[definitionKey] ?? []) {
      if (item.id) {
        index.set(item.id, item);
      }
    }
  }
  return index;
}

function containsPosition(position, ref) {
  if (!ref || !isSourceRefInDocument(position, ref)) return false;
  if (position.line < ref.start_line || position.line > ref.end_line) return false;
  if (position.line === ref.start_line && position.character < ref.start_column) return false;
  if (position.line === ref.end_line && position.character > ref.end_column) return false;
  return true;
}

function isSourceRefInDocument(position, ref) {
  const sourceUri = position.sourceUris?.get(ref.source_id);
  return sourceUri === undefined || sourceUri === position.uri;
}

function findEnumMember(air, position) {
  for (const graph of air.execution_graphs ?? []) {
    for (const expression of graph.expressions ?? []) {
      if (expression.kind !== "enum_value" || !containsPosition(position, expression.source_ref)) continue;
      const type = (air.definitions.types ?? []).find(type => type.id === expression.type_ref);
      const variant = type?.variants?.find(variant => variant.name === expression.literal_text);
      if (variant) return { type, variant };
    }
  }
  return null;
}

function locationForSourceRef(uri, ref, sourceUris) {
  const targetUri = uriForSourceRef(uri, ref, sourceUris);
  return {
    uri: targetUri,
    range: {
      start: { line: ref.start_line, character: ref.start_column },
      end: { line: ref.end_line, character: ref.end_column },
    },
  };
}

function uriForSourceRef(defaultUri, ref, sourceUris) {
  if (sourceUris?.has(ref?.source_id)) {
    return sourceUris.get(ref.source_id);
  }
  if (typeof ref?.source_id !== "string" || ref.source_id.length === 0) {
    return defaultUri;
  }
  if (ref.source_id.startsWith("file://")) {
    return ref.source_id;
  }
  return pathToFileURL(resolve(ref.source_id)).href;
}

const TOUBA_V01_KEYWORDS = Object.freeze([
  "module",
  "import",
  "define",
  "type",
  "enum",
  "function",
  "tool",
  "memory",
  "skill",
  "agent",
  "strategy",
  "trigger",
  "takes",
  "gives",
  "requires",
  "secrets",
  "responsibility",
  "human.approve",
  "human.review",
  "on expired",
  "on rejected",
  "show",
  "ask",
  "text",
  "concat",
  "join",
  "date",
  "record",
  "copy",
  "format",
  "length",
  "min",
  "max",
  "default",
  "some",
  "none",
  "present",
  "callable_by",
  "uses",
  "do",
  "bind",
  "with",
  "into",
  "on",
  "schedule",
  "runs",
  "limits",
  "run",
  "max_run_ms",
  "max_steps",
  "max_tool_calls",
  "max_agent_invocations",
  "max_provider_calls",
  "max_runs_per_day",
  "timeout_ms",
  "failure",
  "fallback",
  "stop",
  "if",
  "else",
  "match",
  "case",
  "for",
  "in",
  "while",
  "parallel",
  "each",
  "max_concurrency",
  "max_items",
  "give",
  "is",
  "are",
  "as",
  "List",
  "Optional",
  "Date",
  "Approval",
  "of",
  "true",
  "false",
]);

export function isMainModule(moduleUrl, entryPath) {
  if (typeof entryPath !== "string" || entryPath.length === 0) return false;
  try {
    return realpathSync(entryPath) === realpathSync(fileURLToPath(moduleUrl));
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return false;
    throw error;
  }
}

if (isMainModule(import.meta.url, process.argv[1])) {
  startServer();
}
