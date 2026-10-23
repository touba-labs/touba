import { mock } from "node:test";

// Repository fixtures describe deterministic executions, not wall-clock evidence.
// Freeze only Date in these dedicated generator processes; runtime clocks and
// timers in applications and regression tests keep their real behavior.
mock.timers.enable({ apis: ["Date"], now: new Date("2026-01-01T00:00:00.000Z") });
