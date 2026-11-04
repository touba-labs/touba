---
sidebar_position: 18
---

# Compensations explicites et bornées

Une compensation demande au runtime d'appliquer l'opération inverse déclarée
pour un effet externe précis. Elle est explicite : un échec, un fallback, une
annulation ou un rollback de déploiement ne la déclenche jamais.

## Quand l'utiliser

Utilisez cette capacité quand un service externe a confirmé une écriture et
que le package sait fournir une inverse métier précise, par exemple libérer
une réservation précédemment créée.

L'effet original reste `applied` dans le journal. L'inverse possède son propre
run, son propre effet, ses budgets, ses secrets et son autorité. Le résultat
peut être :

- `completed` : l'inverse déclarée a été appliquée ;
- `partial` : l'inverse a été appliquée partiellement ;
- `unavailable` : aucune inverse ou aucun reçu exploitable n'est disponible ;
- `failed` : le handler prouve que l'inverse n'a pas été appliquée ;
- `unknown` : l'issue ne peut pas être établie de façon sûre.

## Déclarer l'inverse

Le binding de l'écriture originale utilise un manifest V1 et désigne une
stratégie existante :

```json title="touba.manifest.json"
{
  "manifest_version": "touba-manifest-v1",
  "bindings": {
    "tool:reservations/CreateReservation": {
      "handler": {
        "kind": "process",
        "command": "node",
        "args": ["handlers/create-reservation.mjs"]
      },
      "grants": ["network"],
      "secrets": ["RESERVATION_API_TOKEN"],
      "timeout_ms": 5000,
      "max_payload_bytes": 65536,
      "effect_contract": {
        "kind": "external_write",
        "retry_mode": "idempotency_key",
        "compensation": {
          "entry_ref": "strategy:reservations/ReleaseReservation"
        }
      }
    }
  }
}
```

La stratégie inverse reste volontairement petite : des `bind` purs, au plus
une approbation humaine, exactement un appel de tool externe, puis `give` ou
`stop`. Branches, boucles, fallback, appels imbriqués, interactions, deuxième
effet et compensation récursive sont refusés.

## Implémenter le handler inverse

Le SDK expose le contexte de compensation uniquement pour l'appel inverse :

```js title="release-reservation.handler.mjs"
import { createToolResult, defineTool } from "@touba/sdk";

await defineTool({
  toolRef: "tool:reservations/ReleaseReservation",
  inputSignature: [
    { name: "reservation_id", type_ref: "builtin:Text" },
  ],
  outputType: "builtin:Text",
  run: async ({ request: reservation_id, context }) => {
    const response = await releaseReservation({
      reservationId: reservation_id,
      originalReceipt: context.compensation.original_effect_receipt,
      idempotencyKey: context.effect.effect_id,
    });

    return createToolResult(response.message, {
      effectReceipt: context.createEffectReceipt({
        outcome: "applied",
        receipt_ref: response.receiptRef,
      }),
      compensationReceipt: context.createCompensationReceipt({
        result: response.complete ? "completed" : "partial",
      }),
    });
  },
});
```

Cet extrait suppose un adaptateur métier `releaseReservation` fourni par
votre package ; ce n'est pas un helper du SDK. L'appel inverse utilise
`operation: compensate` dans le protocole handler V1.

Le reçu original est une donnée de contrôle. Ne le recopiez pas dans les
arguments métier, les logs ou les traces.

## Création, reprise et approbation

L'hôte appelle séparément la création et la reprise. Chaque commande passe par
une autorité de ciblage avant la lecture du journal. L'autorité est ensuite
revalidée pour progresser et immédiatement avant un nouveau spawn.

Une reprise fournit la révision et le digest courants du record. Un rejeu
exact déjà traité est une lecture pure : il ne relance pas le handler et ne
produit pas de nouvelle trace. Une approbation expirée peut être renouvelée
pour le même sujet et la même référence ; elle n'est pas héritée du run
original.

## Appeler depuis l'application

L'application fournit un fichier hôte de confiance exportant
`checkCompensationAuthority(request)` en JavaScript, ou
`check_compensation_authority(request)` en Python. Il retourne `true` après
avoir vérifié l'identité authentifiée, le journal ciblé et, si nécessaire,
l'approbation. Les phases sont `lookup`, `resume` et `pre_spawn`.
Les champs `requester_ref` et `journal_scope_ref` de la commande sont des
références à vérifier par cet hôte.

Le module est choisi par l'application, dans `authorityHost` /
`authority_host`. Son chargement est explicite. Pour un module Python,
`TOUBA_HOST_PYTHON` sélectionne l'interpréteur où `touba-sdk` est installé.

Préparez `compensation-request.json` avec les champs suivants :

| Champ | Valeur attendue |
| --- | --- |
| `compensation_request_id` | identifiant stable de la demande, par exemple `request:refund-17` |
| `compensates_effect_id` | identifiant exact de l'effet dans le journal |
| `requester_ref` | identité vérifiée par l'application |
| `journal_scope_ref` | périmètre vérifié par l'application |

Les fichiers AIR et manifest doivent correspondre à l'effet original.
Le journal existant, le store de compensations et les traces utilisent des
bases distinctes.

```js title="create-compensation.mjs"
import {readFileSync, writeFileSync} from "node:fs";
import {ToubaEngine} from "@touba/sdk";

const engine = new ToubaEngine({projectRoot: "."});
try {
  const {record} = await engine.createCompensation({
    air: "payment.air.json",
    manifest: "manifest.json",
    effectJournal: "effects.effect-journal.sqlite",
    store: "compensations.sqlite",
    authorityHost: "authority.mjs",
    request: JSON.parse(readFileSync("compensation-request.json", "utf8")),
  });
  writeFileSync("compensation-result.json", JSON.stringify(record));
  console.log(record.state, record.result);
} finally {
  await engine.close();
}
```

Même opération en Python, avec le même journal et le même contrat hôte :

```python title="create-compensation.py"
import json
from pathlib import Path
from touba_sdk import ToubaEngine

engine = ToubaEngine(project_root=".")
result = engine.create_compensation(
    air="payment.air.json",
    manifest="manifest.json",
    effect_journal="effects.effect-journal.sqlite",
    store="compensations.sqlite",
    authority_host="authority.py",
    request=json.loads(Path("compensation-request.json").read_text()),
)
record = result["record"]
Path("compensation-result.json").write_text(json.dumps(record))
print(record["state"], record["result"])
```

La CLI expose les mêmes opérations :

```sh
touba compensation create --air payment.air.json --manifest manifest.json \
  --effect-journal effects.effect-journal.sqlite --store compensations.sqlite \
  --authority-host authority.mjs --request-json "$COMPENSATION_REQUEST"
```

`COMPENSATION_REQUEST` contient le JSON de la demande, sans secret.
La commande renvoie `record` ; `--trace-store traces.sqlite` conserve
les événements. Les SDK acceptent `traceStore` / `trace_store`,
`runLimits` / `run_limits`, `secrets` et
`resourceBindings` / `resource_bindings`.

### Reprendre une attente

Pour un record `action_required`, transmettez à `resumeCompensation`,
`resume_compensation` ou `touba compensation resume` :

- `resume_request_id` : identifiant stable de cette reprise ;
- `compensation_id`, `compensates_effect_id` : valeurs du record ;
- `expected_revision`, `expected_record_digest` : révision et empreinte lues ;
- `requester_ref`, `journal_scope_ref` : références vérifiées par l'hôte ;
- `approval_evidence`, si attendue : preuve vérifiée par l'application.

La preuve comprend `schema_version: "touba-compensation-approval-v1"`,
`approval_id`, `approval_ref` repris du record, `subject_ref` égal à
`compensation_id`, `decision: "approved"`, `decided_at` et `expires_at`.
Les dates sont UTC, au format `YYYY-MM-DDTHH:mm:ss.sssZ`.
Une approbation porte sur cette compensation précise.

L'hôte acquiert un verrou local du journal pendant l'opération.
Après un arrêt brutal, vérifiez l'état durable et le service métier avant de
lever un verrou résiduel. Une inverse d'issue incertaine reste `unknown`.

## Limites

Le store SQLite fourni vérifie atomiquement révision et empreinte, y compris
entre plusieurs processus locaux. L'hôte coordonne les exécutions et conserve
les sauvegardes. Ce store ne fournit pas de lease multi-hôte ni d'historique
inviolable. Les anciens fichiers JSON utilisent la migration explicite
présentée dans [Stockage et conservation](stockage-et-conservation.md).

Une compensation terminée prouve l'application de l'inverse déclarée, pas la
restauration parfaite du monde extérieur. Cette capacité n'est ni une saga,
ni une transaction distribuée, ni une garantie `exactly-once`.
