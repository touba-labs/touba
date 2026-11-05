import test from "node:test";
import assert from "node:assert/strict";
import { projectAdmissionFailure, requestsJsonRunOutput } from "../src/run-admission.mjs";
import { validateRunResult } from "../../../contracts/run-outcome.mjs";

test("project admission exposes only controlled codes and a bounded refusal", () => {
  for (const code of ["ProjectEntrypointNotAllowed", "ProjectEntrypointsInvalid",
    "PackageIntegrityMismatch", "PackageLockMismatch", "PackageNotInstalled", "PackageUnexpectedFile",
    "PackageInstallationIncomplete", "PackageInstalledReadOnly", "PackagePreparationStale",
    "PackageNameConflict", "PackageGovernanceReviewRequired", "PackageGovernanceInvalid", "PackageGovernanceStale"]) {
    const result = projectAdmissionFailure(Object.assign(new Error("private path and inputs"), { code }));
    validateRunResult(result);
    assert.equal(result.reason, code);
    assert.equal(JSON.stringify(result).includes("private"), false);
  }
  for (const error of [new Error("unknown"), { code: "ProjectEntrypointNotAllowed" },
    Object.assign(new Error("private"), { code: "PrivateCustomFailure" })]) {
    assert.equal(projectAdmissionFailure(error), null);
  }
});

test("project admission respects both output syntaxes and the last selection", () => {
  for (const mode of ["json", "json-reference"]) {
    assert.equal(requestsJsonRunOutput(["--output", mode]), true);
    assert.equal(requestsJsonRunOutput([`--output=${mode}`]), true);
    assert.equal(requestsJsonRunOutput([`--output=${mode}`, "--output", "show"]), false);
  }
  for (const args of [[], ["--output"], ["--output", "unknown"], ["--output=trace"]]) {
    assert.equal(requestsJsonRunOutput(args), false);
  }
});
