"""Inventory local script imports and PEP 621 identity, without importing them."""
import ast
import json
from pathlib import Path
import sys
import tomllib


class Invalid(Exception):
    def __init__(self, code, message):
        self.code, self.message = code, message


def fail(code, message):
    raise Invalid(code, message)


def inspect(options):
    if sys.version_info < (3, 11):
        fail("HandlerImportInvalid", "Python 3.11 or newer is required.")
    original_root = Path(options["package_root"]).absolute()
    root = original_root.resolve(strict=True)
    entry = root / Path(options["entrypoint"]).absolute().relative_to(original_root)
    # Python executes a script with its directory as the first import location.
    module_name = options.get("module_name")
    search_root = root / Path(options["search_root"]).absolute().relative_to(original_root) if module_name else entry.parent
    if not search_root.resolve(strict=True).is_relative_to(root):
        fail("HandlerImportInvalid", "Python module search root escapes the handler package.")
    files, visited, total = set(), set(), 0
    max_files, max_bytes = options["max_files"], options["max_bytes"]
    if type(max_files) is not int or type(max_bytes) is not int or min(max_files, max_bytes) <= 0:
        fail("HandlerImportInvalid", "Import analysis limits must be positive integers.")

    def confined(file):
        if not file.absolute().is_relative_to(root) or not file.resolve(strict=True).is_relative_to(root):
            fail("HandlerImportInvalid", "Python import escapes the handler package root.")
        return file

    def read(file):
        nonlocal total
        confined(file)
        if not file.is_file():
            fail("HandlerImportInvalid", "Python import must be a regular file.")
        size = file.stat().st_size
        if len(files) >= max_files or total + size > max_bytes:
            fail("HandlerImportInvalid", "Python import closure exceeds its file or byte limit.")
        content = file.read_bytes()
        if len(content) != size:
            fail("HandlerImportInvalid", "Python source changed during analysis; retry on a stable tree.")
        total += size
        files.add(str(file))
        return content

    project_file = root / "pyproject.toml"
    project = tomllib.loads(read(project_file).decode("utf-8")).get("project", {})
    if not all(isinstance(project.get(key), str) and project[key].strip() for key in ("name", "version")):
        fail("HandlerPackageInvalid", "pyproject.toml must declare static [project] name and version.")
    if set(project.get("dynamic", [])) & {"name", "version", "dependencies", "optional-dependencies"}:
        fail("HandlerPackageInvalid", "Dynamic Python identity or dependencies cannot be inventoried statically.")
    dependencies = project.get("dependencies", [])
    optional = project.get("optional-dependencies", {})
    if not isinstance(dependencies, list) or not isinstance(optional, dict) or not all(isinstance(items, list) for items in optional.values()):
        fail("HandlerPackageInvalid", "Python dependencies must use static PEP 621 arrays.")
    if not all(isinstance(item, str) for items in [dependencies, *optional.values()] for item in items):
        fail("HandlerPackageInvalid", "Python dependency declarations must be strings.")

    def resolve_module(parts, required=False):
        """Return a local module/package path; external top-level names stay external."""
        current = search_root
        for index, part in enumerate(parts):
            directory, module = current / part, current / (part + ".py")
            init = directory / "__init__.py"
            # A regular package wins over a same-name module; a module wins over
            # a namespace portion. Match Python FileFinder rather than guessing.
            if directory.is_dir() and init.is_file():
                confined(directory)
                visit(init, parts[:index + 1])
                current = directory
            elif module.is_file():
                visit(module, parts[:index])
                if index != len(parts) - 1:
                    fail("HandlerImportMissing", "A local Python module is not an importable package.")
                return module
            elif directory.is_dir():
                confined(directory)
                current = directory
            elif index == 0 and not required:
                return None
            else:
                fail("HandlerImportMissing", "A static local Python import is missing.")
        return current

    def visit(file, package):
        physical = confined(file).resolve(strict=True)
        # Preserve lexical paths too: a second symlink alias must not be omitted.
        if str(file) in files:
            return
        content = read(file)
        if physical in visited:
            return
        visited.add(physical)
        tree = ast.parse(content, filename="<handler>")
        aliases = {}
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                for item in node.names:
                    aliases[item.asname or item.name.split(".")[0]] = item.name if item.asname else item.name.split(".")[0]
            elif isinstance(node, ast.ImportFrom) and node.level == 0:
                for item in node.names:
                    aliases[item.asname or item.name] = (node.module or "") + "." + item.name

        def qualified(node):
            if isinstance(node, ast.Name):
                return aliases.get(node.id, node.id)
            if isinstance(node, ast.Attribute):
                return qualified(node.value) + "." + node.attr
            if isinstance(node, ast.Subscript):
                return qualified(node.value)
            return ""

        for node in ast.walk(tree):
            if isinstance(node, ast.Call):
                name = qualified(node.func)
                if name in {"__import__", "builtins.__import__", "exec", "eval", "compile", "builtins.exec", "builtins.eval", "builtins.compile"} or name.startswith(("importlib.", "runpy.", "pkgutil.")):
                    fail("HandlerImportDynamic", "Dynamic Python loading cannot be locked automatically; use explicit static imports.")
                if name.startswith(("sys.path.", "sys.meta_path.", "sys.path_hooks.")):
                    fail("HandlerImportDynamic", "Custom Python import search paths are not supported by static locking.")
            targets = []
            if isinstance(node, (ast.Assign, ast.Delete)):
                targets = node.targets
            elif isinstance(node, (ast.AnnAssign, ast.AugAssign)):
                targets = [node.target]
            if any(qualified(target) in {"sys.path", "sys.meta_path", "sys.path_hooks", "sys.modules"} for target in targets):
                fail("HandlerImportDynamic", "Custom Python import state is not supported by static locking.")
            if isinstance(node, ast.Import):
                for item in node.names:
                    resolve_module(item.name.split("."))
            elif isinstance(node, ast.ImportFrom):
                if node.level:
                    if not package or node.level > len(package):
                        fail("HandlerImportMissing", "Relative Python import has no enclosing package.")
                    base = package[:len(package) - node.level + 1]
                else:
                    base = []
                parts = base + (node.module.split(".") if node.module else [])
                target = resolve_module(parts, required=bool(node.level))
                if target is not None and target.is_dir():
                    # A from-import may denote either an attribute or a submodule.
                    for item in node.names:
                        if item.name != "*" and ((target / (item.name + ".py")).exists() or (target / item.name).is_dir()):
                            resolve_module(parts + [item.name], required=True)

    if module_name:
        if not isinstance(module_name, str) or not all(part.isidentifier() for part in module_name.split(".")):
            fail("HandlerImportInvalid", "Invalid Python module name.")
        parts = module_name.split(".")
        if search_root.joinpath(*parts).with_suffix(".py") != entry:
            fail("HandlerImportInvalid", "Python module name does not match its entrypoint.")
        for count in range(1, len(parts)):
            visit(search_root.joinpath(*parts[:count], "__init__.py"), parts[:count])
        visit(entry, parts[:-1])
    else:
        visit(entry, [])
    return {"files": sorted(str(original_root / Path(file).relative_to(root)) for file in files), "name": project["name"], "version": project["version"], "has_dependencies": bool(dependencies or any(optional.values()))}


try:
    print(json.dumps(inspect(json.load(sys.stdin))))
except Invalid as error:
    print(json.dumps({"code": error.code, "message": error.message}))
    sys.exit(1)
except (OSError, ValueError, SyntaxError, TypeError, KeyError, RecursionError):
    print(json.dumps({"code": "HandlerImportInvalid", "message": "Python source or pyproject.toml cannot be read or parsed safely."}))
    sys.exit(1)
