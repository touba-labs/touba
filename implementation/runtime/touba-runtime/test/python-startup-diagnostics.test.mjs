import test from "node:test";
import assert from "node:assert/strict";
import { startupHandlerDiagnostic } from "../src/handler-diagnostics.mjs";

test("Python startup diagnostics preserve only a closed class and a selected script location", () => {
  const sources = [{ index: 1, path: "/selected/handler.py" }];
  for (const error of ["ModuleNotFoundError", "ImportError", "PermissionError", "FileNotFoundError", "SyntaxError"]) {
    const stderr = `Traceback (most recent call last):\n  File "/selected/handler.py", line 8, in <module>\n    private_code_and_secret\n${error}: private message\n`;
    assert.deepEqual(startupHandlerDiagnostic(stderr, sources), { error_class: error, handler_arg_index: 1, line: 8, column: 1 });
  }
  assert.deepEqual(startupHandlerDiagnostic('  File "/other/private.py", line 7\nPermissionError: hidden', sources), { error_class: "PermissionError" });
  assert.equal(startupHandlerDiagnostic("CustomSecretError: private", sources), null);
  assert.deepEqual(startupHandlerDiagnostic("Error: hidden\n/selected/handler.py:9:3", sources), { error_class: "Error", handler_arg_index: 1, line: 9, column: 3 });
});
