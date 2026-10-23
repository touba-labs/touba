// Source-derived display only: never evaluate bindings or call a host function.
const operators = { add: '+', subtract: '-', multiply: '*', divide: '/', integer_divide: '//', modulo: '%',
  equal: '==', not_equal: '!=', less_than: '<', less_than_or_equal: '<=', greater_than: '>', greater_than_or_equal: '>=', text_concat: '++',
  and: 'and', or: 'or', not: 'not', negate: '-' };
const name = ref => String(ref ?? '').replace(/^value:/, '').replace(/^.*\//, '').replace(/^builtin:/, '');
export function expressionFormatter(graph = {}, constants = []) {
  const expressions = new Map((graph.expressions ?? []).map(e => [e.id, e]));
  const values = new Map(constants.map(c => [c.id, c]));
  return handle => {
    let visited = 0;
    const format = (ref, depth = 0) => {
      if (++visited > 256 || depth > 24) return '…';
      if (typeof ref === 'string' && ref.startsWith('literal:string:')) return JSON.stringify(ref.slice(15));
      if (typeof ref === 'string' && /^literal:(int|float|bool):/.test(ref)) return ref.replace(/^literal:(int|float|bool):/, '');
      const e = expressions.get(typeof ref === 'string' ? ref.replace(/^expr:/, '') : ref) ?? values.get(ref);
      if (!e) return name(ref);
      if (Object.hasOwn(e, 'literal_text')) return e.type_ref === 'builtin:Date' ? `date(${JSON.stringify(e.literal_text)})` : JSON.stringify(e.literal_text);
      for (const key of ['literal_boolean', 'literal_int', 'literal_float']) if (Object.hasOwn(e, key)) return String(e[key]);
      const child = ref => format(ref, depth + 1);
      const args = (e.operands ?? []).map(child);
      switch (e.kind) {
        case 'value_ref': return child(e.value_ref);
        case 'field_access': return `${args[0]}.${e.field_name}`;
        case 'binary_op': return `(${args[0]} ${operators[e.operator] ?? e.operator} ${args[1]})`;
        case 'unary_op': return `${operators[e.operator] ?? e.operator} (${args[0]})`;
        case 'construct_list': return `[${args.join(', ')}]`;
        case 'list_comprehension': return `[${args[1]} for ${name(e.value_ref)} in ${args[0]}${args[2] ? ` if ${args[2]}` : ''}]`;
        case 'construct_record': return `record ${name(e.type_ref)} { ${(e.record_fields ?? []).map(f => `${f.name} as ${child(f.value_ref)}`).join(', ')} }`;
        case 'copy_record': return `copy ${args[0]} { ${(e.record_fields ?? []).map(f => `${f.name} as ${child(f.value_ref)}`).join(', ')} }`;
        case 'optional_present': return `present ${args[0]}`;
        case 'optional_none': return `none(${name(e.type_ref?.replace(/^optional:/, ''))})`;
        default: {
          const fn = { text_conversion: 'text', date_conversion: 'date', optional_some: 'some', optional_value: 'value', list_concat: 'concat', text_join: 'join' }[e.kind];
          return fn ? `${fn}(${args.join(', ')})` : name(ref);
        }
      }
    };
    const result = format(handle);
    return result.length > 4096 ? `${result.slice(0, 4096)}…` : result;
  };
}
