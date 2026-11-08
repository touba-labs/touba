"""Fixed unittest runner for an operator-reviewed validation plan."""

import os
import sys
import unittest

sys.path.insert(0, os.getcwd())
suite = unittest.TestSuite()
for filename in sys.argv[1:]:
    suite.addTests(unittest.TestLoader().discover(
        start_dir=os.path.dirname(filename) or ".", pattern=os.path.basename(filename)
    ))
result = unittest.TextTestRunner(verbosity=2).run(suite)
passed = result.testsRun - len(result.errors) - len(result.failures) - len(result.skipped)
print(f"# TOUBA_VALIDATION tests={result.testsRun} passed={passed}")
sys.exit(0 if result.wasSuccessful() else 1)
