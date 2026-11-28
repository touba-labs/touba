# First governed run

Install [Touba 1.5.0](https://toubalang.org/hub/telechargements/?version=1.5.0)
and open this directory in a terminal. These four runs use a synthetic order.
They need only the CLI, with no API key, account or model.

## Preview and inspect the trace

```sh
touba run refunds.tb --entry strategy:examples.refunds/PreviewRefund --trace-out preview.trace.json
touba inspect preview.trace.json
```

The preview prints `Refund preview` and `demo-order`. The trace records the
execution of the preview strategy. No refund is issued.

## Request approval

```sh
touba run refunds.tb --entry strategy:examples.refunds/HandleRefund --output run-summary --trace-out approval.trace.json
```

The summary reports `approval_pending` and zero tool and provider calls. The
command exits with code 3 to report a pending approval. The trace shows the
approval request before any invocation of the refund agent.

## Try an unauthorized caller

```sh
touba run caller-not-allowed.tb
```

The compiler reports `AgentCallerNotAllowed` for the added strategy
`RefundEverything`. The refusal happens during compilation.

## Set a step limit

```sh
touba run refunds.tb --entry strategy:examples.refunds/PreviewRefund --max-steps 1 --trace-out budget.trace.json
touba inspect budget.trace.json
```

The run fails with `StepBudgetExceeded` after using one step. Inspect the trace
to see where the budget stopped execution.
