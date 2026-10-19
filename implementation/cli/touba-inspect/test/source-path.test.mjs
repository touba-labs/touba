import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { sourceIdMatchesPath } from "../src/inspect.mjs";

test("Windows source identity accepts the drive casing used by VS Code", () => {
  const source = String.raw`D:\a\touba\examples\linear.tb`;
  const selected = String.raw`d:\a\touba\examples\linear.tb`;
  assert.equal(sourceIdMatchesPath(source, selected, path.win32), true);
  assert.equal(sourceIdMatchesPath(selected, source, path.win32), true);
  assert.equal(sourceIdMatchesPath("D:/a/touba/examples/linear.tb", selected, path.win32), true);
});

test("Windows source identity keeps different drives, folders and filenames distinct", () => {
  const selected = String.raw`d:\a\touba\examples\linear.tb`;
  for (const source of [String.raw`E:\a\touba\examples\linear.tb`,
    String.raw`D:\a\touba\other\linear.tb`, String.raw`D:\a\touba\examples\other.tb`,
    String.raw`D:\a\Touba\examples\linear.tb`, String.raw`D:\a\touba\examples\Linear.tb`]) {
    assert.equal(sourceIdMatchesPath(source, selected, path.win32), false, source);
  }
});

test("Windows UNC source identity retains the server and share", () => {
  const source = String.raw`\\server\share\examples\linear.tb`;
  assert.equal(sourceIdMatchesPath(source, source, path.win32), true);
  assert.equal(sourceIdMatchesPath(source, String.raw`\\other\share\examples\linear.tb`, path.win32), false);
  assert.equal(sourceIdMatchesPath(source, String.raw`\\server\other\examples\linear.tb`, path.win32), false);
});

test("portable source IDs match complete trailing path segments on both platforms", () => {
  for (const [paths, selected] of [[path.posix, "/work/examples/linear.tb"],
    [path.win32, String.raw`d:\work\examples\linear.tb`]]) {
    assert.equal(sourceIdMatchesPath("examples/linear.tb", selected, paths), true);
    for (const source of ["amples/linear.tb", "other/linear.tb", "../examples/linear.tb",
      "./examples/linear.tb", "examples//linear.tb", "examples\\linear.tb", "Examples/linear.tb"]) {
      assert.equal(sourceIdMatchesPath(source, selected, paths), false, source);
    }
  }
});

test("POSIX source identity preserves case and rejects foreign Windows absolute IDs", () => {
  assert.equal(sourceIdMatchesPath("/work/linear.tb", "/work/linear.tb", path.posix), true);
  assert.equal(sourceIdMatchesPath("/Work/linear.tb", "/work/linear.tb", path.posix), false);
  assert.equal(sourceIdMatchesPath(String.raw`D:\work\linear.tb`, "/work/linear.tb", path.posix), false);
});
