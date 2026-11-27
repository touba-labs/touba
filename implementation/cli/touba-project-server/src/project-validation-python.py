"""Fixed unittest runner for an operator-reviewed validation plan."""

import os
import sys
import unittest
import hashlib
import importlib.util


class ValidationResult(unittest.TextTestResult):
    def __init__(self, stream, descriptions, verbosity):
        super().__init__(stream, descriptions, verbosity)
        self.passed = 0

    def addSuccess(self, test):
        super().addSuccess(test)
        self.passed += 1


sys.path.insert(0, os.getcwd())
suite = unittest.TestSuite()
for filename in sys.argv[1:]:
    # Each path has been pinned and authorized by the operator. Discovery
    # ignores generated filenames containing dots, so load exactly that file.
    path = os.path.abspath(filename)
    name = "touba_validation_" + hashlib.sha256(path.encode()).hexdigest()
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise ImportError(f"Cannot load reviewed test file: {filename}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    suite.addTests(unittest.TestLoader().loadTestsFromModule(module))
result = unittest.TextTestRunner(verbosity=2, resultclass=ValidationResult).run(suite)
print(f"# TOUBA_VALIDATION tests={result.testsRun} passed={result.passed}")
sys.exit(0 if result.wasSuccessful() else 1)
