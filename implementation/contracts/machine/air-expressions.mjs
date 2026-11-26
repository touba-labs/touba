const BUILTINS = new Set(['builtin:Text', 'builtin:Boolean', 'builtin:Int', 'builtin:Float', 'builtin:Date', 'builtin:Approval']);
const NUMERIC = new Set(['builtin:Int', 'builtin:Float']);
const BINARY = new Set(['add', 'subtract', 'multiply', 'divide', 'integer_divide', 'modulo', 'text_concat', 'equal', 'not_equal', 'less_than', 'greater_than', 'less_than_or_equal', 'greater_than_or_equal', 'and', 'or']);
/** @param {string} name */
const valueRef = name => name.startsWith('value:') ? name : `value:${name}`;
const COMPARISONS = new Set(['equal', 'not_equal', 'less_than', 'greater_than', 'less_than_or_equal', 'greater_than_or_equal']);

/** Validate executable references and declared expression types, without evaluation.
 * @param {any} document @param {(code:string,message:string,path:string)=>never} fail */
export function validateAirExpressions(document, fail) {
  const definitions = document.definitions;
  const types = new Map((definitions.types ?? []).map(/** @param {any} item */ item => [item.id, item]));
  const constants = new Map((definitions.constants ?? []).map(/** @param {any} item */ item => [item.id, item]));
  const callables = new Map(['functions', 'tools', 'skills', 'agents', 'strategies'].flatMap(key => definitions[key] ?? []).map(/** @param {any} item */ item => [item.id, item]));
  const points = new Set();
  for (const [index, point] of document.trace_points.entries()) {
    if (!point || typeof point.id !== 'string' || points.has(point.id)) fail('DuplicateAirId', 'trace points require unique identifiers', `$.trace_points[${index}]`);
    points.add(point.id);
  }
  if (document.module.id !== `module:${document.module.name}`) fail('AirModuleIdentityInvalid', 'module id must match its declared name', '$.module.id');
  /** @param {unknown} type */
  const validType = type => {
    if (typeof type !== 'string') return false;
    let current = type;
    while (current.startsWith('list:') || current.startsWith('optional:')) current = current.slice(current.indexOf(':') + 1);
    return BUILTINS.has(current) || types.has(current);
  };
  for (const [graphIndex, graph] of document.execution_graphs.entries()) {
    const path = `$.execution_graphs[${graphIndex}]`;
    const expressions = new Map();
    for (const [index, expression] of (graph.expressions ?? []).entries()) {
      if (expressions.has(expression.id)) fail('DuplicateAirId', 'expression id occurs twice in one graph', `${path}.expressions[${index}].id`);
      expressions.set(expression.id, expression);
    }
    const values = new Map((callables.get(graph.owner_ref)?.signature?.inputs ?? []).map(/** @param {any} input */ input => [`value:${input.name}`, input.type_ref]));
    for (const node of graph.nodes) {
      if (node.result_binding) values.set(valueRef(node.result_binding), callables.get(node.target_ref)?.signature?.output_type ?? (node.kind === 'human_approval' ? 'builtin:Approval' : node.kind === 'user_interaction' ? 'builtin:Text' : null));
      if (node.item_binding) values.set(valueRef(node.item_binding), null);
      if (node.kind === 'loop' && node.condition_ref?.startsWith('loop_has_next:') && node.arguments?.[1]) values.set(node.arguments[1], null);
    }
    for (const expression of expressions.values()) if (expression.kind === 'list_comprehension' && expression.value_ref) values.set(expression.value_ref, null);
    /** @param {string} handle */
    const typeOf = handle => {
      if (handle.startsWith('expr:')) return expressions.get(handle.slice(5))?.type_ref ?? null;
      if (handle.startsWith('constant:')) return constants.get(handle)?.type_ref ?? null;
      if (handle.startsWith('value:')) return values.get(handle) ?? null;
      if (handle.startsWith('literal:int:')) return 'builtin:Int';
      if (handle.startsWith('literal:float:') || handle.startsWith('literal:number:')) return 'builtin:Float';
      if (handle.startsWith('literal:bool:')) return 'builtin:Boolean';
      return 'builtin:Text';
    };
    /** @param {unknown} handle @param {string} at */
    const checkHandle = (handle, at) => {
      if (typeof handle !== 'string' || handle.length === 0) fail('AirReferenceUnresolved', 'expected a non-empty value reference', at);
      if (handle.startsWith('expr:') && !expressions.has(handle.slice(5))
        || handle.startsWith('constant:') && !constants.has(handle)
        || handle.startsWith('value:') && !values.has(handle)) fail('AirReferenceUnresolved', 'value reference is absent from this graph', at);
      if (handle.startsWith('literal:int:')) {
        const literal = handle.slice(12);
        if (!/^-?\d+$/.test(literal) || !Number.isSafeInteger(Number(literal))) fail('AirLiteralInvalid', 'Int literal exceeds the supported domain', at);
      }
      if (handle.startsWith('literal:float:') || handle.startsWith('literal:number:')) {
        const literal = handle.slice(handle.indexOf(':', 8) + 1);
        if (!literal.trim() || !Number.isFinite(Number(literal))) fail('AirLiteralInvalid', 'Float literal must be finite', at);
      }
      if (handle.startsWith('literal:bool:') && !['literal:bool:true', 'literal:bool:false'].includes(handle)) fail('AirLiteralInvalid', 'Boolean literal must be true or false', at);
    };
    // Source order supplies types for immutable bindings. Declared expression
    // types are checked independently below, including on unexecuted paths.
    for (const node of graph.nodes) {
      if (node.kind === 'loop' && node.condition_ref?.startsWith('loop_has_next:') && node.arguments?.[1]) {
        const collection = typeOf(node.arguments[0]);
        if (collection?.startsWith('list:')) values.set(node.arguments[1], collection.slice(5));
      }
      if (node.kind === 'bind' && node.result_binding && node.arguments?.length) values.set(valueRef(node.result_binding), typeOf(node.arguments[0]));
      if (node.item_binding && node.collection_ref) {
        const collection = typeOf(node.collection_ref);
        if (collection?.startsWith('list:')) values.set(valueRef(node.item_binding), collection.slice(5));
      }
    }
    for (const expression of expressions.values()) if (expression.kind === 'list_comprehension') {
      const collection = typeOf(expression.operands?.[0] ?? '');
      if (collection?.startsWith('list:')) values.set(expression.value_ref, collection.slice(5));
    }
    for (const [nodeIndex, node] of graph.nodes.entries()) {
      const at = `${path}.nodes[${nodeIndex}]`;
      if (node.approval_policy?.timeout_ms_ref !== undefined) {
        checkHandle(node.approval_policy.timeout_ms_ref, `${at}.approval_policy.timeout_ms_ref`);
        if (typeOf(node.approval_policy.timeout_ms_ref) !== 'builtin:Int') fail('InvalidHumanApprovalPolicy', 'dynamic timeout requires Int', at);
      }
      for (const [index, handle] of (node.arguments ?? []).entries()) checkHandle(handle, `${at}.arguments[${index}]`);
      for (const key of ['condition_ref', 'collection_ref', 'context_refs']) {
        for (const handle of key === 'context_refs' ? node[key] ?? [] : node[key] ? [node[key]] : []) checkHandle(handle, `${at}.${key}`);
      }
      for (const ref of node.trace_point_refs ?? []) if (!points.has(ref)) fail('AirReferenceUnresolved', 'trace point is absent', `${at}.trace_point_refs`);
    }
    const dependencies = new Map();
    for (const [index, expression] of [...expressions.values()].entries()) {
      const at = `${path}.expressions[${index}]`;
      /** @type {Record<string,string[]>} */
      const fields = {
        optional_some: ['operands'], optional_none: ['operands'], optional_present: ['operands'], optional_value: ['operands'],
        enum_value: ['literal_text'], value_ref: ['value_ref'], literal_text: ['literal_text'], literal_boolean: ['literal_boolean'], literal_int: ['literal_int'], literal_float: ['literal_float'],
        text_conversion: ['operands'], date_conversion: ['operands'], field_access: ['operands', 'field_name'], construct_record: ['record_fields'], copy_record: ['record_fields', 'operands'], construct_list: ['operands'], list_comprehension: ['operands', 'value_ref'], list_sum: ['operands'], list_sort: ['operands'], list_concat: ['operands'], text_join: ['operands'], unary_op: ['operator', 'operands'], binary_op: ['operator', 'operands'],
      };
      const extra = fields[expression.kind];
      if (!extra) fail('AirExpressionInvalid', 'unsupported expression kind', at);
      const allowed = new Set(['id', 'kind', 'type_ref', 'source_ref', 'operands', ...extra]);
      if (Object.keys(expression).some(key => !allowed.has(key))) fail('AirExpressionInvalid', 'expression contains fields not defined for its kind', at);
      const operands = expression.operands ?? [];
      if (!Array.isArray(operands)) fail('AirExpressionInvalid', 'expression operands must be an array', `${at}.operands`);
      /** @type {Record<string,number>} */
      const arity = {value_ref:0, literal_text:0, literal_boolean:0, literal_int:0, literal_float:0, enum_value:0, text_conversion:1, date_conversion:1, field_access:1, optional_some:1, optional_none:0, optional_present:1, optional_value:1, construct_record:0, copy_record:1, list_sum:1, list_sort:1, list_concat:2, text_join:2};
      if (arity[expression.kind] !== undefined && operands.length !== arity[expression.kind]) fail('AirExpressionInvalid', 'expression has an invalid operand count', at);

      const handles = [...operands, ...(expression.record_fields ?? []).map(/** @param {any} field */ field => field.value_ref), ...(expression.kind === 'value_ref' ? [expression.value_ref] : [])];
      handles.forEach((handle, index) => checkHandle(handle, `${at}.operands[${index}]`));
      dependencies.set(expression.id, handles.filter(handle => handle.startsWith('expr:')).map(handle => handle.slice(5)));
      if (expression.type_ref !== undefined && !validType(expression.type_ref)) fail('AirExpressionTypeInvalid', 'expression type is unknown', `${at}.type_ref`);
      let expected;
      if (expression.kind === 'unary_op' || expression.kind === 'binary_op') {
        const unary = expression.kind === 'unary_op';
        if (!(unary ? expression.operator === 'not' : BINARY.has(expression.operator)) || operands.length !== (unary ? 1 : 2)) fail('AirExpressionInvalid', 'operator and operand count must match the expression kind', at);
        const input = operands.map(typeOf);
        expected = unary || COMPARISONS.has(expression.operator) || ['and', 'or'].includes(expression.operator) ? 'builtin:Boolean'
          : expression.operator === 'text_concat' ? 'builtin:Text'
          : expression.operator === 'divide' ? 'builtin:Float'
          : input.every(type => type === 'builtin:Int') ? 'builtin:Int' : input.every(type => NUMERIC.has(type)) ? 'builtin:Float' : null;
        if ((unary || ['and', 'or'].includes(expression.operator)) && input.some(type => type && type !== 'builtin:Boolean')) fail('AirExpressionTypeInvalid', 'logical operands must be Boolean', at);
        if (['integer_divide', 'modulo'].includes(expression.operator)) {
          expected = 'builtin:Int';
          if (input.some(type => type && type !== 'builtin:Int')) fail('AirExpressionTypeInvalid', 'integer operator requires Int operands', at);
        }
        if (expression.operator === 'text_concat' && input.some(type => type && type !== 'builtin:Text')) fail('AirExpressionTypeInvalid', 'text concatenation requires Text operands', at);
        if (['add', 'subtract', 'multiply', 'divide'].includes(expression.operator) && input.some(type => type && !NUMERIC.has(type))) fail('AirExpressionTypeInvalid', 'arithmetic operands must be numeric', at);
      } else if (expression.kind.startsWith('literal_')) {
        const literalTypes = /** @type {Record<string,string>} */ ({literal_text:'builtin:Text', literal_boolean:'builtin:Boolean', literal_int:'builtin:Int', literal_float:'builtin:Float'});
        expected = literalTypes[expression.kind];
        if (expression.kind === 'literal_text' && typeof expression.literal_text !== 'string' || expression.kind === 'literal_boolean' && typeof expression.literal_boolean !== 'boolean') fail('AirLiteralInvalid', 'literal does not match its expression kind', at);
        if (['literal_int', 'literal_float'].includes(expression.kind) && typeof expression[expression.kind] !== 'string') fail('AirLiteralInvalid', 'numeric literal must use its canonical text encoding', at);
        if (expression.kind === 'literal_int') checkHandle(`literal:int:${expression.literal_int}`, at);
        if (expression.kind === 'literal_float') checkHandle(`literal:float:${expression.literal_float}`, at);
      } else if (expression.kind === 'value_ref') expected = typeOf(expression.value_ref);
      else if (expression.kind === 'text_conversion') expected = 'builtin:Text';
      else if (['list_sum', 'list_sort'].includes(expression.kind)) {
        const input = typeOf(operands[0]);
        if (!['list:builtin:Int', 'list:builtin:Float', ...(expression.kind === 'list_sort' ? ['list:builtin:Text'] : [])].includes(input)) fail('AirExpressionTypeInvalid', 'list operation has an invalid operand type', at);
        expected = expression.kind === 'list_sum' ? input.slice(5) : input;
      }
      else if (expression.kind === 'field_access') {
        if (operands.length !== 1 || typeof expression.field_name !== 'string') fail('AirExpressionInvalid', 'field access requires one record and a field name', at);
        const type = typeOf(operands[0]);
        if (types.has(type)) {
          const field = (types.get(type).fields ?? []).find(/** @param {any} field */ field => field.name === expression.field_name);
          if (!field) fail('AirReferenceUnresolved', 'record field is absent', at);
          expected = field.type_ref;
        }
      }
      if (expected && expression.type_ref !== undefined && expression.type_ref !== expected) fail('AirExpressionTypeInvalid', 'declared expression type does not match its operation', `${at}.type_ref`);
    }
    // Check expression cycles iteratively, never evaluating a supplied graph.
    const active = new Set(), done = new Set();
    for (const id of dependencies.keys()) {
      const stack = [[id, false]];
      while (stack.length) {
        const [current, leaving] = /** @type {[string,boolean]} */ (stack.pop());
        if (leaving) { active.delete(current); done.add(current); continue; }
        if (done.has(current)) continue;
        if (active.has(current)) fail('AirExpressionCycle', 'expression operands contain a cycle', `${path}.expressions`);
        active.add(current); stack.push([current, true]);
        for (const child of dependencies.get(current) ?? []) stack.push([child, false]);
      }
    }
  }
}
