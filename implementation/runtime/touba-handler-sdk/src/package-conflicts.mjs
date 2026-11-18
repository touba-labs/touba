// Bounded public graph identifiers only. Never forward paths, source content or
// arbitrary diagnostics as dependency constraints.
export function packageConflictDetails(value) {
  const name = text => typeof text === 'string' && text.length <= 180 && /^[a-z_][a-z0-9_-]*(\.[a-z_][a-z0-9_-]*)+$/.test(text);
  const version = text => text === null || typeof text === 'string' && text.length <= 128 && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(text);
  if (!Array.isArray(value) || !value.length || value.length > 128 || value.some(row => !row || !name(row.consumer) || !name(row.dependency)
      || !version(row.version) || typeof row.constraint !== 'string' || !row.constraint.length || row.constraint.length > 1024
      || !/^[0-9A-Za-z.*+~^<>=| -]+$/.test(row.constraint)
      || (Object.hasOwn(row, 'current_version') && !version(row.current_version))
      || (Object.hasOwn(row, 'origin') && !['author', 'selected', 'installed'].includes(row.origin))
      || (Object.hasOwn(row, 'blocking') && typeof row.blocking !== 'boolean'))) return undefined;
  return value.map(({ consumer, dependency, constraint, version, current_version, origin, blocking }) => ({ consumer, dependency, constraint, version,
    ...(current_version !== undefined ? { current_version } : {}), ...(origin !== undefined ? { origin } : {}),
    ...(blocking !== undefined ? { blocking } : {}) }))
    .sort((a, b) => `${a.consumer}/${a.dependency}`.localeCompare(`${b.consumer}/${b.dependency}`));
}
