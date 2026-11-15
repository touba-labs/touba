// Portable dependency contract shared by the CLI and JavaScript handlers.
// Ranges are conjunctions of full-version comparators, never a latest selector.
const VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
function version(value) {
  if (typeof value !== 'string' || value.length > 256) return null;
  const match = VERSION.exec(value);
  if (!match || match[0] !== value || match.slice(1, 4).some(part => !Number.isSafeInteger(Number(part)))
      || match[4]?.split('.').some(part => /^[0-9]+$/.test(part) && /^0[0-9]/.test(part))) return null;
  return { core: match.slice(1, 4).map(Number), pre: match[4]?.split('.') ?? [] };
}
function compare(left, right) {
  for (let i = 0; i < 3; i++) if (left.core[i] !== right.core[i]) return left.core[i] < right.core[i] ? -1 : 1;
  if (!left.pre.length || !right.pre.length) return Number(!left.pre.length) - Number(!right.pre.length);
  for (let i = 0; i < Math.max(left.pre.length, right.pre.length); i++) {
    const a = left.pre[i], b = right.pre[i];
    if (a === b) continue;
    if (a === undefined || b === undefined) return a === undefined ? -1 : 1;
    const an = /^[0-9]+$/.test(a), bn = /^[0-9]+$/.test(b);
    if (an && bn) return BigInt(a) < BigInt(b) ? -1 : 1;
    if (an !== bn) return an ? -1 : 1;
    return a < b ? -1 : 1;
  }
  return 0;
}
function comparators(constraint) {
  if (typeof constraint !== 'string' || constraint.length > 1024 || constraint !== constraint.trim()) return null;
  if (version(constraint)) return [{ operator: '=', value: version(constraint) }];
  const terms = constraint.split(' ');
  if (!terms.length || terms.length > 8) return null;
  const result = [];
  for (const term of terms) {
    const match = /^(>=|<=|>|<|=)(.+)$/.exec(term);
    const parsed = match && version(match[2]);
    if (!parsed) return null;
    result.push({ operator: match[1], value: parsed });
  }
  return result;
}
export function validPackageConstraint(constraint, schema) {
  return schema === 'touba-package-v1' ? version(constraint) !== null
    : schema === 'touba-package-v2' && comparators(constraint) !== null;
}
export function satisfiesPackageConstraint(selected, constraint, schema) {
  const parsed = version(selected);
  if (!parsed || !validPackageConstraint(constraint, schema)) return false;
  // Exact pins keep their original byte-for-byte version identity, including build metadata.
  if (version(constraint)) return selected === constraint;
  const terms = comparators(constraint);
  if (parsed.pre.length && !terms.some(term => term.value.pre.length && term.value.core.every((v, i) => v === parsed.core[i]))) return false;
  return terms.every(term => {
    const order = compare(parsed, term.value);
    return ({ '=': order === 0, '>': order > 0, '>=': order >= 0, '<': order < 0, '<=': order <= 0 })[term.operator];
  });
}
