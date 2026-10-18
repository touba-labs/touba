# Introduire Touba dans une orchestration Python

Objectif : appeler une stratégie Touba depuis un nœud LangGraph ou un tool
LangChain, sans déplacer l’autorité d’exécution dans le framework.
Installez le [SDK Python](../guides/sdk-python.md) et, seulement pour cet
exemple, les dépendances facultatives testées (licences MIT) :

```sh
python -m pip install langgraph==1.2.16 langchain-core==1.6.12
```

## Une frontière visible avant de poursuivre

<!-- touba-example: compile -->
```touba title="program.tb"
module integration
strategy Review
    takes value as Text
    gives Text
    do
        human.approve
            with context as value
            into approval
        give value
```

```python title="orchestration.py"
from typing import TypedDict
from langchain_core.tools import tool
from langgraph.graph import StateGraph, START, END
from touba_sdk import Engine

engine = Engine(project_root=".")

@tool
def review_invoice(value: str) -> dict:
    """Submit an invoice for review; a pause is not an approval."""
    run = engine.run(source="program.tb", inputs={"value": value})
    return {"status": run.status, "reason": run.reason, "result": run.result}

class State(TypedDict, total=False):
    value: str
    status: str
    reason: str
    result: str | None

def review_node(state: State) -> dict:
    return review_invoice.invoke({"value": state["value"]})

builder = StateGraph(State)
builder.add_node("review", review_node)
builder.add_edge(START, "review")
builder.add_edge("review", END)
result = builder.compile().invoke({"value": "Invoice 42"})
assert result["reason"] == "human_approval_pending"
assert result["result"] is None
```

Exécutez `python orchestration.py`. Aucun modèle ni service payant n’est
nécessaire. Le même tool est appelable directement par
`review_invoice.invoke({"value": "Invoice 42"})`.
Dans les deux cas, l’issue est `stopped / human_approval_pending`, pas une
validation inventée par le framework.

## Passer à un workflow métier

Ajoutez au programme les capacités autorisées, le rôle requis et les limites.
Configurez `manifest`, `human_approval_host`, `effect_journal` et un
`human_checkpoint_out` distinct par opération côté hôte. Une décision réelle
reprend ce checkpoint avec `human_resume_checkpoint` et `human_decisions`,
sans réexécuter le nœud depuis son début. Conservez la trace et son `run_id`
dans votre stockage applicatif avec votre identifiant d’opération.

Ne laissez pas le modèle choisir les chemins de fichiers, le manifest, le
journal ou l’adaptateur d’identité. Il fournit les données métier typées.
Une pause doit suspendre la suite métier ; un résultat `success` avec raison
`completed` peut seulement alors être consommé comme résultat terminé.

La frontière Touba couvre cet appel, pas les autres actions du framework.
Un deuxième appel frais est une autre opération : ne configurez pas une
relance automatique d’un nœud à effets sans protocole d’idempotence métier.
Les reprises explicites utilisent le même journal, et un effet déjà appliqué
ne doit pas être rejoué. Les détails figurent dans le
[tutoriel d’approbation](./approbations-roles-delais.md).
