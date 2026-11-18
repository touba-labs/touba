# Package names and exported modules

This contract applies to the candidate currently being prepared.

A package exports declarations from its canonical module root or a dot-separated
child of that root. Convert every hyphen in the package name to an underscore;
preserve the dots. For example, `acme.sql-effects` owns exports under
`acme.sql_effects` and `acme.sql_effects.extra`. It cannot export from
`acme.sql_effects_other` or `other.sql_effects`.

The rule covers types, constants, functions, tools, skills, agents, strategies
and memories. It also applies separately to every bundled dependency. A direct
re-export of a dependency's declaration is refused. Expose your own declaration
and call the dependency through a typed import instead.

Two distinct installed packages cannot claim the same module or overlapping
parent and child modules. Neighboring names such as `acme.tools` and
`acme.toolbox` remain distinct. Multiple exports from the same package may
share a module and its children. Context-only and host-only packages may keep
empty exports.

`PackageModuleOwnershipMismatch` identifies an export outside its package root.
`PackageModuleConflict` identifies an overlap between packages. Both checks run
before installation writes, including when checking a bundled archive. Names
and digests do not authenticate a local archive's publisher; select trusted
sources and review the application's capabilities and approval requirements.

Historical archives remain immutable. An author whose exports do not satisfy
this contract should create a new conforming version, then review consumers'
imports. Registry claim recovery is an administrative operation and does not
make an old nonconforming archive executable. Existing project files and locks
are never silently rewritten to accept it.

[Guide en français](../../../docs/guides/creer-partager-package.md).
