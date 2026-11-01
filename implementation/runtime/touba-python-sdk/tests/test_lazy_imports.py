import os
from pathlib import Path
import subprocess
import sys
import unittest


class LazyImportsTest(unittest.TestCase):
    def cold(self, code):
        env = {**os.environ, "PYTHONPATH": str(Path(__file__).resolve().parents[1] / "src")}
        subprocess.run([sys.executable, "-B", "-c", code], env=env, check=True, timeout=10)

    def test_simple_import_does_not_load_integrations(self):
        self.cold("import sys, touba_sdk; assert 'ToubaEngine' in dir(touba_sdk); "
                  "assert not any('touba_sdk.' + name in sys.modules for name in ['mcp', 'providers', 'engine', 'handlers'])")

    def test_handler_does_not_load_mcp_or_providers(self):
        self.cold("import sys; from touba_sdk import define_tool; assert callable(define_tool); "
                  "assert 'touba_sdk.mcp' not in sys.modules; assert 'touba_sdk.providers' not in sys.modules")

    def test_every_public_export_keeps_its_identity(self):
        import touba_sdk
        from importlib import import_module
        for name in touba_sdk.__all__:
            value = getattr(touba_sdk, name)
            self.assertIs(value, getattr(import_module('.' + touba_sdk._EXPORT_MODULE[name], 'touba_sdk'), name))
        with self.assertRaises(AttributeError):
            getattr(touba_sdk, "missing_public_export")
