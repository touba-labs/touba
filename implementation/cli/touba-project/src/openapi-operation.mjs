const object = value => value && typeof value === 'object' && !Array.isArray(value);
const methods = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);

// Resolve only the selected operation. No network, file reads or executable
// extensions; bound both depth and expansion, including repeated references.
export function openApiOperation(document, operationId) {
  let remaining = 8192;
  function resolve(value, refs = new Set(), depth = 0) {
    if (--remaining < 0 || depth > 32) throw new Error('OpenAPI reference expansion exceeds the bounded import limit');
    if (Array.isArray(value)) return value.map(item => resolve(item, refs, depth + 1));
    if (!object(value)) return value;
    if (Object.hasOwn(value, '$ref')) {
      const ref = value.$ref;
      if (typeof ref !== 'string' || !ref.startsWith('#/') || refs.has(ref)) throw new Error('OpenAPI references must be local and acyclic');
      if (Object.keys(value).some(key => !['$ref', 'description', 'summary'].includes(key))) throw new Error('OpenAPI reference siblings with constraints require an explicit adapter');
      let target = document;
      for (const part of ref.slice(2).split('/')) {
        if (/~(?![01])/.test(part)) throw new Error('Invalid local OpenAPI reference');
        const key = part.replaceAll('~1', '/').replaceAll('~0', '~');
        if (!object(target) || !Object.hasOwn(target, key)) throw new Error('Local OpenAPI reference was not found');
        target = target[key];
      }
      return resolve(target, new Set([...refs, ref]), depth + 1);
    }
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolve(item, refs, depth + 1)]));
  }
  if (!object(document.paths)) throw new Error('openapi.paths must be an object');
  const matches = [];
  for (const [path, rawPathItem] of Object.entries(document.paths)) {
    if (!object(rawPathItem)) continue;
    if (rawPathItem.$ref) throw new Error('Referenced path items require an explicit adapter');
    for (const [rawMethod, rawOperation] of Object.entries(rawPathItem)) {
      const method = rawMethod.toUpperCase();
      if (!methods.has(method) || rawOperation?.operationId !== operationId) continue;
      const operation = resolve(rawOperation);
      const inherited = resolve(rawPathItem.parameters ?? []);
      if (!Array.isArray(inherited) || !Array.isArray(operation.parameters ?? [])) throw new Error('OpenAPI parameters must be arrays');
      const parameters = new Map();
      for (const group of [inherited, operation.parameters ?? []]) {
        const seen = new Set();
        for (const parameter of group) {
          if (!object(parameter) || !['path', 'query'].includes(parameter.in) || typeof parameter.name !== 'string'
            || !parameter.name || !object(parameter.schema) || !['string', 'boolean', 'integer', 'number'].includes(parameter.schema.type)
            || parameter.allowReserved === true || parameter.content
            || parameter.style !== undefined && parameter.style !== (parameter.in === 'path' ? 'simple' : 'form')
            || parameter.in === 'path' && parameter.required !== true) throw new Error('Parameters require scalar path/query schemas and standard serialization; path parameters must be required');
          const key = `${parameter.in}:${parameter.name}`;
          if (seen.has(key)) throw new Error('Duplicate OpenAPI parameter');
          seen.add(key); parameters.set(key, parameter);
        }
      }
      const entries = [...parameters.values()];
      const pathNames = entries.filter(p => p.in === 'path').map(p => p.name);
      const placeholders = [...path.matchAll(/\{([^{}]+)\}/g)].map(match => match[1]);
      if (placeholders.some(name => !pathNames.includes(name)) || pathNames.some(name => !placeholders.includes(name))) throw new Error('Path parameters must match the URL template exactly');
      const body = operation.requestBody?.content?.['application/json']?.schema;
      if (operation.requestBody && (!object(body) || ['GET', 'DELETE'].includes(method))) throw new Error('Request body requires a JSON object on POST, PUT or PATCH');
      if (body && (body.type !== 'object' || !object(body.properties))) throw new Error('Request body must be a JSON object');
      const properties = Object.fromEntries(entries.map(p => [p.name, p.schema]));
      if (new Set(entries.map(p => p.name)).size !== entries.length || body && Object.keys(body.properties).some(name => Object.hasOwn(properties, name))) throw new Error('Body and parameter names must be distinct');
      const inputSchema = body ? { ...body, properties: { ...properties, ...body.properties }, required: [...entries.filter(p => p.required).map(p => p.name), ...(body.required ?? [])] }
        : { type: 'object', properties, required: entries.filter(p => p.required).map(p => p.name) };
      const response = ['200', '201', '202', 'default'].map(code => operation.responses?.[code]?.content?.['application/json']?.schema).find(object);
      if (!response) throw new Error('A JSON response schema is required');
      const outputArray = response.type === 'array';
      matches.push({ name: operationId, operationId, description: operation.summary ?? operation.description ?? '', method, path,
        secret_handles: operation['x-touba-secret-handles'], inputSchema,
        outputSchema: outputArray ? { type: 'object', properties: { items: response }, required: ['items'] } : response,
        output_array: outputArray, parameter_locations: Object.fromEntries(entries.map(p => [p.name, p.in])),
        body_mode: body ? 'json' : 'query' });
    }
  }
  if (matches.length !== 1) throw new Error(matches.length ? 'Ambiguous operation identifier' : 'Operation identifier was not found');
  return matches[0];
}
