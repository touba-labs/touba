"""Discover the installed Windows CLI without interpreting a batch script.

Installation metadata locates a trusted executable; it is not a signature.
The same rule is used by Engine and the shared SDK backend.
"""
import json
import os
from pathlib import Path


def resolve_engine_command(command, args, cwd, env, *, platform=None):
    env = dict(env)
    if (platform or os.name) != "nt":
        return command, list(args), env
    seen = set()
    normalized = {}
    for key in sorted(env):
        if key.upper() not in seen:
            normalized[key] = env[key]
            seen.add(key.upper())
    env = normalized
    names = [command] if Path(command).suffix else [command + suffix for suffix in (".exe", ".com", ".cmd", ".bat")]
    path_key = next((key for key in env if key.lower() == "path"), "PATH")
    if "/" in command or "\\" in command:
        candidates = [Path(cwd) / name for name in names]
    else:
        candidates = [Path(cwd) / directory.strip('"') / name
                      for directory in env.get(path_key, "").split(";") if directory for name in names]
    selected = next((Path(os.path.abspath(path)) for path in candidates if path.is_file()), None)
    if selected is None:
        return command, list(args), env
    if selected.suffix.lower() not in (".cmd", ".bat"):
        return str(selected), list(args), env
    if selected.name.lower() == "touba.cmd":
        parent = selected.parent.parent
        for root in (parent, parent / "touba-toolchain"):
            try:
                metadata = json.loads((root / "TOOLCHAIN.json").read_text(encoding="utf-8"))
            except (OSError, ValueError):
                continue
            node, compiler = root / "bin/node.exe", root / "bin/touba-compile.exe"
            cli = root / "lib/cli/touba-project/src/main.mjs"
            if not isinstance(metadata, dict) or metadata.get("toolchain_profile") != "touba-local-toolchain-v1" or metadata.get("platform") != "win32-x64" or not all(path.is_file() for path in (node, compiler, cli)):
                continue
            env = {key: value for key, value in env.items() if key.upper() != "TOUBA_COMPILE_BIN"}
            env["TOUBA_COMPILE_BIN"] = str(compiler)
            env[path_key] = str(root / "bin") + ";" + env.get(path_key, "")
            channel_key = next((key for key in env if key.upper() == "TOUBA_DISTRIBUTION_CHANNEL"), "TOUBA_DISTRIBUTION_CHANNEL")
            if not env.get(channel_key):
                env[channel_key] = "local-archive"
            return str(node), [str(cli), *args], env
    raise ValueError("EngineBatchLauncherUnsupported")
