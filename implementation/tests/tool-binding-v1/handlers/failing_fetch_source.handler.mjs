process.stdout.write(
  JSON.stringify({
    ok: false,
    error: {
      code: "FixtureFailure",
      message: "fixture handler failed intentionally",
    },
  }),
);
