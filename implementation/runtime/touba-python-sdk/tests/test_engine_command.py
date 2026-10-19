import json
from pathlib import Path
import tempfile
import unittest
from touba_sdk._engine_command import resolve_engine_command


class EngineCommandTests(unittest.TestCase):
    def fixture(self, installed):
        temporary = tempfile.TemporaryDirectory(prefix="touba-launch-")
        self.addCleanup(temporary.cleanup)
        prefix = Path(temporary.name) / "Touba & équipe %PATH% !"
        root = prefix / "touba-toolchain" if installed else prefix
        for name in ("bin/node.exe", "bin/touba-compile.exe", "lib/cli/touba-project/src/main.mjs"):
            path = root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("not executed")
        (prefix / "bin").mkdir(exist_ok=True, parents=True)
        (prefix / "bin/touba.cmd").write_text("This batch must never be interpreted")
        (root / "TOOLCHAIN.json").write_text(json.dumps(dict(toolchain_profile="touba-local-toolchain-v1", platform="win32-x64")))
        env = {"Path": str(prefix / "bin"), "TOUBA_DISTRIBUTION_CHANNEL": "release-test", "touba_compile_bin": "wrong"}
        return prefix, root, env

    def test_installed_and_extracted_bundle_preserve_exact_argv(self):
        arguments = ["--inputs-json", '{"text":"a & b | %TEMP% ! é"}']
        for installed in (False, True):
            prefix, root, env = self.fixture(installed)
            for command in ("touba", str(prefix / "bin/touba.cmd")):
                executable, args, resolved = resolve_engine_command(command, arguments, prefix.parent, env, platform="nt")
                self.assertEqual(executable, str(root / "bin/node.exe"))
                self.assertEqual(args, [str(root / "lib/cli/touba-project/src/main.mjs"), *arguments])
                self.assertEqual(resolved["TOUBA_COMPILE_BIN"], str(root / "bin/touba-compile.exe"))
                self.assertNotIn("touba_compile_bin", resolved)
                self.assertEqual(resolved["TOUBA_DISTRIBUTION_CHANNEL"], "release-test")
                self.assertEqual(env["touba_compile_bin"], "wrong")

    def test_invalid_or_foreign_batch_is_refused(self):
        prefix, root, env = self.fixture(True)
        second, _, _ = self.fixture(False)
        env["Path"] += ";" + str(second / "bin")
        for metadata in (None, {}, dict(toolchain_profile="touba-local-toolchain-v1", platform="darwin-arm64")):
            (root / "TOOLCHAIN.json").write_text(json.dumps(metadata))
            with self.assertRaisesRegex(ValueError, "EngineBatchLauncherUnsupported"):
                resolve_engine_command("touba", [], prefix.parent, env, platform="nt")
        (prefix / "bin/custom.cmd").write_text("exit /b 0")
        with self.assertRaisesRegex(ValueError, "EngineBatchLauncherUnsupported"):
            resolve_engine_command("custom.cmd", [], prefix.parent, env, platform="nt")

    def test_path_case_matches_javascript_child_process(self):
        prefix, root, env = self.fixture(True)
        env["PATH"], env["Path"] = env["Path"], "not-the-installation"
        executable, _, resolved = resolve_engine_command("touba", [], prefix.parent, env, platform="nt")
        self.assertEqual(executable, str(root / "bin/node.exe"))
        self.assertNotIn("Path", resolved)

    def test_executable_and_posix_transports_are_unchanged(self):
        prefix, root, env = self.fixture(True)
        (prefix / "bin/touba.exe").write_text("native")
        executable, args, _ = resolve_engine_command("touba", ["x & y"], prefix.parent, env, platform="nt")
        self.assertEqual(executable, str(prefix / "bin/touba.exe"))
        self.assertEqual(args, ["x & y"])
        self.assertEqual(resolve_engine_command("touba", ["x & y"], prefix.parent, env, platform="posix"), ("touba", ["x & y"], env))
