---
sidebar_position: 35
---

# Tester un budget financier sans appel payant

Cet exercice vérifie le registre du SDK, sans modèle, sans clé et sans facture.
Les montants sont un contrat d'essai, pas un tarif fournisseur. Installez le
[SDK JavaScript](../guides/sdk-javascript.md) ou le [SDK Python](../guides/sdk-python.md).

## JavaScript

Enregistrez ce programme dans `budget-test.mjs` puis lancez
`node budget-test.mjs`. Le répertoire temporaire appartient à cet exercice.

```javascript
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSqliteProviderBudget } from "@touba/sdk/budget/sqlite";

const directory = mkdtempSync(join(tmpdir(), "touba-budget-example-"));
const options = { filename: join(directory, "costs.sqlite"),
  budgetId: "test-operation", currency: "USD", limitMicros: 100n };
const quote = { basis: "upper_bound", maxCostMicros: 60n, currency: "USD",
  tariffId: "exercise-contract", tariffDate: "2026-10-18" };
let budget;
try {
  budget = createSqliteProviderBudget(options);
  const attempt = budget.reserve(quote);
  budget.settle(attempt, { kind: "unknown" });
  assert.equal(budget.snapshot().remainingMicros, 40n);
  assert.throws(() => budget.reserve(quote),
    error => error.code === "ProviderCostBudgetExceeded");
  budget.close();
  budget = createSqliteProviderBudget(options);
  assert.equal(budget.snapshot().remainingMicros, 40n);
  assert.equal(budget.listAttempts({ status: "unknown" })[0].id, attempt);
  // Test evidence only; production reconciliation requires provider evidence.
  budget.settle(attempt, { kind: "reported", costMicros: 20n });
  assert.equal(budget.snapshot().remainingMicros, 80n);
  console.log("BUDGET_OK");
} finally {
  budget?.close();
  rmSync(directory, { recursive: true, force: true });
}
```

## Python

Enregistrez ce programme dans `budget_test.py` puis lancez-le avec le Python du
projet où le SDK est installé. Il vérifie exactement le même cycle.

```python
from pathlib import Path
from tempfile import TemporaryDirectory
from touba_sdk import ToubaAgentDecisionProviderError
from touba_sdk.budget.sqlite import create_sqlite_provider_budget

with TemporaryDirectory(prefix="touba-budget-example-") as directory:
    options = dict(filename=Path(directory) / "costs.sqlite",
                   budget_id="test-operation", currency="USD", limit_micros=100)
    quote = dict(basis="upper_bound", max_cost_micros=60, currency="USD",
                 tariff_id="exercise-contract", tariff_date="2026-10-18")
    budget = create_sqlite_provider_budget(**options)
    try:
        attempt = budget.reserve(quote)
        budget.settle(attempt, {"kind": "unknown"})
        assert budget.snapshot()["remaining_micros"] == 40
        try:
            budget.reserve(quote)
        except ToubaAgentDecisionProviderError as error:
            assert error.code == "ProviderCostBudgetExceeded"
        else:
            raise AssertionError("Expected a monetary budget refusal")
        budget.close()
        budget = create_sqlite_provider_budget(**options)
        assert budget.snapshot()["remaining_micros"] == 40
        assert budget.list_attempts(status="unknown")[0]["id"] == attempt
        # Test evidence only; production reconciliation requires provider evidence.
        budget.settle(attempt, {"kind": "reported", "cost_micros": 20})
        assert budget.snapshot()["remaining_micros"] == 80
        print("BUDGET_OK")
    finally:
        budget.close()
```

## Lire le résultat

`BUDGET_OK` confirme que l'usage inconnu garde sa réservation, que le dépassement
est refusé et que la reprise conserve le solde. Seule une information d'usage
explicite libère ensuite la différence. Cela teste la comptabilité, pas un appel
LLM ni la justesse d'un tarif. Pour protéger de vrais appels, suivez le
[guide des coûts fournisseurs](../guides/couts-fournisseurs.md).
