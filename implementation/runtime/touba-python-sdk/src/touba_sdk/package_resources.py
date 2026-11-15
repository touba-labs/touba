"""Resolve declared, locked package resources without loading their code."""
import hashlib
import json
import os
from pathlib import Path
import re
import stat

_MANIFEST = "touba.package.json"
_NAME = re.compile(r"[a-z_][a-z0-9_-]*(\.[a-z_][a-z0-9_-]*)+\Z")
_HASH = re.compile(r"sha256:[a-f0-9]{64}\Z")


class PackageDependencyError(Exception):
    def __init__(self, code):
        super().__init__(code + ": verify the declared dependency, its installation lock and file inventory")
        self.code = code


def _fail(code):
    raise PackageDependencyError(code)


def _path(root, resource):
    if (not isinstance(resource, str) or len(resource) > 240
        or not re.fullmatch(r"[A-Za-z0-9_./@+ -]+", resource)
        or any(not part or part in (".", "..") or part.endswith((".", " ")) for part in resource.split("/"))):
        _fail("PackagePathInvalid")
    path = root
    for part in resource.split("/"):
        path = path / part
        if path.is_symlink():
            _fail("PackageSymlinkForbidden")
    return path


def _bytes(path, limit):
    if path.is_symlink() or not path.is_file() or path.stat().st_size > limit:
        _fail("PackageIntegrityMismatch")
    descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    with os.fdopen(descriptor, "rb") as stream:
        opened = os.fstat(stream.fileno())
        if not stat.S_ISREG(opened.st_mode) or opened.st_size > limit:
            _fail("PackageIntegrityMismatch")
        value = stream.read(limit + 1)
    if len(value) > limit:
        _fail("PackageIntegrityMismatch")
    return value


def _hash(value):
    return "sha256:" + hashlib.sha256(value).hexdigest()


def _verify(root, entry):
    files = entry.get("files")
    if type(files) is not list or not 1 <= len(files) <= 4096 or not _HASH.fullmatch(entry.get("digest", "")):
        _fail("PackageLockInvalid")
    known, inventory, total = set(), [], 0
    for item in files:
        if (type(item) is not dict or set(item) != {"path", "size", "digest"}
            or type(item["size"]) is not int or not 0 <= item["size"] <= 16 * 1024 * 1024
            or not isinstance(item["digest"], str) or not _HASH.fullmatch(item["digest"])
            or not isinstance(item["path"], str) or item["path"].lower() in known):
            _fail("PackageLockInvalid")
        total += item["size"]
        if total > 64 * 1024 * 1024:
            _fail("PackageLockInvalid")
        known.add(item["path"].lower())
        content = _bytes(_path(root, item["path"]), item["size"])
        if len(content) != item["size"] or _hash(content) != item["digest"]:
            _fail("PackageIntegrityMismatch")
        inventory.append({"path": item["path"], "size": item["size"], "digest": item["digest"]})
    serialized = json.dumps(inventory, ensure_ascii=False, separators=(",", ":")).encode()
    if _hash(serialized) != entry["digest"] or _MANIFEST not in known:
        _fail("PackageIntegrityMismatch")
    manifest = json.loads(_bytes(_path(root, _MANIFEST), 1024 * 1024))
    if manifest.get("name") != entry["name"] or manifest.get("version") != entry["version"]:
        _fail("PackageIntegrityMismatch")


def resolve_package_resource(manifest_path, dependency, resource):
    """Return an inventoried Path. No import, permission, network or cwd lookup.

    The caller supplies its own manifest anchored to __file__. Confinement must
    separately allow the installation lock, manifests and inventoried files.
    """
    try:
        manifest_path = Path(manifest_path)
        if (not manifest_path.is_absolute() or manifest_path.name != _MANIFEST
            or not isinstance(dependency, str) or not _NAME.fullmatch(dependency)):
            _fail("PackageDependencyInvalid")
        if manifest_path.parent.is_symlink():
            _fail("PackageSymlinkForbidden")
        root = manifest_path.parent.resolve(strict=True)
        owner = json.loads(_bytes(_path(root, _MANIFEST), 1024 * 1024))
        if (owner.get("package_schema_version") != "touba-package-v1" or not _NAME.fullmatch(owner.get("name", ""))
            or type(owner.get("dependencies")) is not dict or dependency not in owner["dependencies"]):
            _fail("PackageDependencyUndeclared")
        installed = root.parent.name == "packages"
        workspace = root.parent.parent if installed else root
        if (workspace / ".touba-package-installing").exists():
            _fail("PackageInstallationIncomplete")
        lock = json.loads(_bytes(_path(workspace, "touba.packages.lock.json"), 8 * 1024 * 1024))
        if lock.get("lock_schema_version") != "touba-package-lock-v1" or type(lock.get("packages")) is not list or len(lock["packages"]) > 1024:
            _fail("PackageLockInvalid")
        names = set()
        for entry in lock["packages"]:
            if (type(entry) is not dict or not _NAME.fullmatch(entry.get("name", "")) or entry["name"] in names
                or entry.get("manifest") != f"packages/{entry['name']}/{_MANIFEST}" or not isinstance(entry.get("version"), str)):
                _fail("PackageLockInvalid")
            names.add(entry["name"])
        if installed:
            own = next((item for item in lock["packages"] if item["name"] == owner["name"]), None)
            if own is None or root.name != owner["name"]:
                _fail("PackageLockInvalid")
            _verify(root, own)
        entry = next((item for item in lock["packages"] if item["name"] == dependency), None)
        if entry is None or entry["version"] != owner["dependencies"][dependency]:
            _fail("PackageDependencyMissing")
        target = _path(workspace, entry["manifest"]).parent
        _verify(target, entry)
        if not any(item["path"] == resource for item in entry["files"]):
            _fail("PackageResourceUndeclared")
        return _path(target, resource)
    except PackageDependencyError:
        raise
    except (OSError, ValueError, TypeError, KeyError, AttributeError):
        _fail("PackageDependencyInvalid")
