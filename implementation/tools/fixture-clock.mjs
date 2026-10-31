import { mock } from "node:test";
import crypto from "node:crypto";
import { syncBuiltinESMExports } from "node:module";

// Repository fixtures describe deterministic executions, not wall-clock evidence.
// Freeze Date and opaque UUIDs only in these dedicated generator processes;
// applications and regression tests keep their real clocks and randomness.
mock.timers.enable({ apis: ["Date"], now: new Date("2026-01-01T00:00:00.000Z") });
let fixtureIdentity = 0;
mock.method(crypto, "randomUUID", () => `00000000-0000-4000-8000-${String(++fixtureIdentity).padStart(12, '0')}`);
syncBuiltinESMExports();
