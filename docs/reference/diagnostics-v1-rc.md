---
sidebar_position: 8
---

# Référence diagnostics

Cette page liste les diagnostics et erreurs utilisateur principaux.

:::info Comment lire cette page
Chaque ligne donne le code ou la famille d'erreur, sa cause probable et l'action recommandée. Pour approfondir, consulter la [référence CLI](./cli-v1-rc.md) ou le [guide dépannage](../guides/depannage.md).
:::

## Compilation et sémantique

| Code ou famille | Cause probable | Action |
| --- | --- | --- |
| `UnknownReference` | Appel ou référence introuvable | Vérifier le nom et la déclaration |
| `MissingExplicitCallArgument` | Argument requis absent | Ajouter `with <source> as <nom>` |
| `UnknownCallArgument` | Nom d'argument inconnu | Aligner `as <nom>` avec `takes` |
| `DuplicateCallArgument` | Même argument fourni deux fois | Supprimer le doublon |
| `DuplicateResultBinding` | Binding `into` déjà utilisé | Choisir un nom distinct |
| `DuplicateLocalBinding` | Nom `bind` déjà utilisé dans le graphe | Choisir un nom local distinct |
| `UnsupportedModuleConstantExpression` | `define` contient autre chose qu'un littéral | Utiliser un littéral ou déplacer le calcul dans une fonction |
| `UnreachableStatement` | Instruction placée après un retour terminal (`give`, `stop`, ou `if` dont toutes les branches terminent) | Déplacer l’instruction avant le retour, ou garder un seul `give` par chemin |
| `InvalidBranchCondition` | Condition `if` non booléenne | Produire un `Boolean` |
| `EnrichedAgentCallBlocked` | Appel agent enrichi non supporté | Utiliser un appel simple d'agent |
| `AgentCallerNotAllowed` | Appel agent non autorisé | Corriger `callable_by` |
| `UnsupportedTriggerEventKind` | Trigger d'une famille non livrée | Utiliser `on schedule "..."` |
| `UnsupportedTriggerTargetKind` | Trigger vers une cible non livrée | Utiliser `runs strategy <Name>` |
| `MissingTriggerLimits` | Trigger sans bloc `limits` | Ajouter `max_runs_per_day` et `timeout_ms` |
| `MissingTriggerLimit` | Limite obligatoire absente | Ajouter la limite manquante |
| `InvalidTriggerLimit` | Limite non positive ou non entière | Fournir un entier strictement positif |
| `UnknownTriggerTarget` | Strategy cible absente | Déclarer la strategy ciblée |
| `InvalidTriggerArgument` | Argument trigger invalide | Utiliser un littéral, un `define` de module, ou `payload.<champ>` sur un trigger `request` |

## Expressions

| Code ou famille | Cause probable | Action |
| --- | --- | --- |
| `InvalidExpressionOperandType` | Opérateur appliqué au mauvais type | Vérifier `Text`, `Boolean`, `Int`, `Float` |
| `UnknownExpressionField` | Champ absent | Vérifier le type local |
| `StaticExpressionDivisionByZero` | Division par zéro détectable | Corriger le dénominateur |
| `AstError` | Syntaxe hors périmètre | Utiliser les expressions natives |

## Runtime, tools, manifest et secrets

| Code | Cause probable | Action |
| --- | --- | --- |
| `ToolBindingManifestMissing` | Manifest absent | Fournir le manifest |
| `ToolBindingMissing` | Binding absent pour le tool | Ajouter l'entrée au manifest |
| `ToolCapabilityNotGranted` | Capability requise absente | Ajouter le grant si légitime |
| `SecretReadGrantMissing` | Secret sans grant adapté | Corriger le binding |
| `SecretRequiredButNotBound` | Handle absent du binding | Ajouter le handle |
| `SecretNotResolved` | Secret non disponible | Fournir le fichier secrets avec source `env`, `dotenv` ou `touba_store` |
| `SecretHandleRevoked` | Handle explicitement révoqué dans le profil secrets | Réactiver le handle si l'usage est légitime ou choisir un profil de secrets adapté |
| `SecretHandleExpired` | Handle expiré selon le profil secrets | Renouveler la valeur et mettre à jour l'expiration du profil |
| `SecretNotGrantedToAgent` | Agent non autorisé à utiliser le handle | Corriger le scope agent |
| `ToolInputSchemaInvalid` | Input tool invalide | Aligner l'entrée avec `takes` |
| `ToolOutputSchemaInvalid` | Sortie handler invalide | Corriger le handler ou le `gives` |
| `ToolPayloadConstraintViolation` | Contrainte `payload_constraints` violée | Corriger l'entrée, la sortie handler ou la contrainte du manifest |
| `ToolHandlerTimeout` | Handler trop lent | Corriger le handler ou le timeout |
| `AgentDecisionProviderUnavailable` | Provider agentique indisponible ou exception levée | Vérifier le module provider et ses dépendances |
| `AgentDecisionProviderTimeout` | Provider agentique trop lent | Corriger le provider ou ajuster `--agent-decision-provider-timeout-ms` |
| `AgentDecisionProviderSchemaViolation` | Réponse provider hors contrat | Retourner une décision conforme à `touba-agent-decision-v1` |
| `AgentDecisionProviderBudgetExceeded` | Budget d'appels provider dépassé | Augmenter `--max-provider-calls` si le run le justifie |
| `AgentDecisionProviderRetryLimitExceeded` | Retries provider épuisés | Corriger la cause provider ou ajuster `--agent-decision-provider-max-retries` |
| `AgentProviderObservationsBudgetExceeded` | Observations trop volumineuses pour le contexte provider | Réduire les observations ou utiliser des références opaques côté provider |
| `AgentCapabilityDescriptionRequired` | Capacité exposée à un decision provider sans `description` source | Ajouter une description explicite à chaque capacité déclarée dans `agent.uses` |

## Workflow projet

| Code | Cause probable | Action |
| --- | --- | --- |
| `ModulePathNotCanonical` | Fichier source hors convention projet | Utiliser `src/<domaine>/<module>.tb` avec `module domaine.module` |
| `ModulePathMismatch` | Nom de module différent du chemin source | Aligner le chemin et la ligne `module` |
| `ManifestMissing` | Projet avec tool sans manifest en mode `check` | Lancer `touba prepare --mode write` ou créer le manifest |
| `ManifestBindingMissing` | Tool déclaré sans binding | Mettre à jour le manifest depuis l'AIR |
| `ManifestGrantMissing` | Grant attendu absent | Relire et accorder explicitement le grant si légitime |
| `ManifestSecretMissing` | Handle de secret attendu absent | Ajouter le handle, jamais la valeur |
| `HandlerStubMissing` | Stub handler attendu absent | Générer le stub ou fournir le handler attendu |
| `ManifestBindingObsolete` | Binding présent pour un tool supprimé | Retirer le binding si le tool n'existe plus |
| `PackageSchemaMismatch` | Manifeste de package local invalide ou version de schéma inconnue | Corriger `touba.package.json` |
| `PackageExportMissing` | Import depuis un package vers une déclaration non exportée | Ajouter l’export au package ou corriger l’import |
| `PackageExportUnknownRef` | Export de package vers une déclaration absente | Corriger `exports` ou la source du package |
| `PackageVersionIncompatible` | Version demandée différente de la version du package | Aligner `touba.project.json` et le package |
| `PackageAirProfileIncompatible` | Profil AIR du package incompatible | Utiliser un package ciblant `air-json-v0.1` |
| `PackageNameConflict` | Module ou package local en conflit | Renommer le package ou le module concerné |
| `PackageAuthorityFieldForbidden` | Package tente de déclarer handler, binding, grant, secret ou permission | Retirer l’autorité du package ; l’autorité reste dans AIR, manifest et runtime |
| `PackageRegistryForbidden` | Package local ou entrée projet tente d’utiliser une registry | Fournir un manifeste local explicite |
| `RunPlanMissing` | Run plan attendu absent en mode `check` | Lancer `touba prepare --run-plan <path> --mode write` |
| `RunPlanDrift` | Run plan différent des artefacts attendus | Régénérer le plan avec `touba prepare --run-plan <path> --mode write` |
| `RunPlanSchemaMismatch` | Version ou forme du run plan invalide | Corriger le JSON ou régénérer le plan |
| `RunPlanEntryUnknown` | `entry_ref` absent de l'AIR | Corriger `--entry` ou le source Touba |
| `RunPlanAirMissing` | AIR pointé absent | Relancer `touba prepare --mode write` ou corriger le chemin |
| `RunPlanManifestMissing` | Manifest requis absent | Produire le manifest avec `touba prepare --mode write` |
| `RunPlanSecretsProfileMissing` | Profil secrets requis absent | Produire ou fournir le profil secrets explicite |
| `RunPlanSupplyChainLockRequired` | Profil strict sans lock disponible | Fournir ou régénérer `touba.lock.json` |
| `RunPlanSupplyChainDrift` | Lock supply chain incohérent avec AIR, manifest ou handler | Régénérer le lock après vérification des changements |
| `RunPlanTriggerManifestMissing` | Manifest trigger pointé absent | Fournir le manifest trigger explicite |
| `RunPlanLimitInvalid` | Limite de run invalide | Utiliser une limite positive supportée |
| `RunPlanSensitivePayloadForbidden` | Payload, prompt ou secret placé dans le run plan | Retirer ces données du plan et les fournir par le canal prévu |
| `BindingFragmentReadFailed` | Fragment de binding illisible | Corriger le chemin ou le JSON |
| `BindingFragmentSchemaMismatch` | Fragment hors schéma `touba-binding-fragment-v0.1` | Corriger le schéma ou régénérer le fragment |
| `BindingFragmentUnknownTool` | Fragment cible un tool absent de l’AIR préparé | Corriger le tool, l’import ou le package local |
| `BindingFragmentDuplicateBinding` | Même binding répété par fragment | Garder une seule source de binding |
| `BindingFragmentConflictingBinding` | Deux fragments divergent pour le même tool | Arbitrer explicitement avant composition |
| `BindingFragmentMissingGrant` | Grant requis par l’AIR absent du fragment | Ajouter le grant au fragment |
| `BindingFragmentMissingSecret` | Secret requis par l’AIR absent du fragment | Ajouter le handle de secret au fragment |
| `BindingFragmentMemoryAccessMissing` | Accès mémoire requis absent du fragment | Ajouter l’accès mémoire explicitement |
| `BindingFragmentConstraintInvalid` | Contrainte de payload invalide | Corriger `payload_constraints` |
| `BindingFragmentAuthorityFieldForbidden` | Fragment tente d’accorder caller, scope, policy ou statut de sécurité | Retirer l’autorité du fragment |
| `BindingFragmentNotAssembled` | `touba run` reçoit un fragment au lieu d’un manifest assemblé | Lancer `touba prepare --binding-fragment ...` et fournir `touba.manifest.json` |
| `ResourceBindingsReadFailed` | Fichier de resource bindings illisible | Corriger le chemin ou le JSON |
| `ResourceBindingsSchemaMismatch` | Resource bindings hors schéma `touba-resource-bindings-v0.1` | Corriger ou régénérer l’artefact |
| `ResourceBindingUnknownResource` | Binding cible une ressource absente de l’AIR préparé | Corriger la référence ou l’import |
| `ResourceBindingUnsupportedKind` | Famille non supportée par les resource bindings | Utiliser `memory_backend`, `event_source` ou `decision_provider` |
| `ResourceBindingMissing` | Ressource logique requise sans binding actif | Fournir un binding ou désactiver l’exigence |
| `ResourceBindingInactive` | Binding explicitement inactif | Activer le binding ou choisir un autre profil |
| `ResourceBindingSecretMissing` | Secret handle requis absent du binding | Ajouter le handle, jamais la valeur |
| `ResourceBindingGrantMissing` | Grant requis absent du binding | Ajouter le grant si légitime |
| `ResourceBindingScopeMissing` | Owner sans scope mémoire compatible | Corriger `memory_scopes` dans la source Touba |
| `ResourceBindingPayloadForbidden` | Payload brut ou valeur secrète dans le binding | Remplacer par un handle ou une référence hôte |

## Skill packs

| Code | Cause probable | Action |
| --- | --- | --- |
| `SkillPackDescriptorMissing` | Pack sans `skill.json` | Créer ou restaurer le descripteur |
| `SkillPackSchemaMismatch` | Schéma, champ ou type de champ invalide | Corriger `skill.json` selon `touba-skill-pack-v0.1` |
| `SkillPackRefInvalid` | Ref de pack ou de ressource invalide | Utiliser `skill_pack:<namespace>/<skill-id>` ou `resource:<skill-id>/<name>` |
| `SkillPackLayoutInvalid` | Organisation du dossier incomplète | Recréer le layout avec `touba skill new` ou ajouter les dossiers attendus |
| `SkillPackResourceKindInvalid` | Type de ressource non supporté | Utiliser `procedure`, `reference`, `example`, `template`, `sample` ou `script` |
| `SkillPackResourcePathInvalid` | Chemin absent, absolu, sortant ou non fichier | Garder un chemin relatif interne au pack |
| `SkillPackDigestMismatch` | Digest différent du contenu | Mettre à jour le digest après relecture du fichier |
| `SkillPackResourceUndeclared` | Fichier sous `resources/` ou `scripts/` absent de `skill.json` | Ajouter l'entrée correspondante ou retirer le fichier |
| `SkillPackAuthorityFieldForbidden` | Le pack tente de déclarer handler, command, grant, secret, scope ou caller | Retirer l'autorité du pack ; l'autorité reste dans Touba et le manifest |
| `SkillPackScriptExecutionForbidden` | Script traité comme exécutable par le pack | Garder le script comme ressource et passer par un `tool` Touba |
| `SkillPackExecutionLinkUnauthorized` | Lien vers une capacité absente de `agent.uses` | Ajouter la capacité au bon agent ou retirer le lien |
| `SkillPackBudgetExceeded` | Hints, activation ou entrée modèle hors budget | Réduire le pack ou augmenter explicitement le budget |
| `SkillPackSensitiveContentForbidden` | Contenu actif contenant secret, payload brut, prompt complet ou mémoire brute | Remplacer par handle, résumé ou référence hôte |
| `SkillPackActivationUntraced` | Pack actif sans événement d'activation observable | Corriger l'hôte ou la trace de run |
| `SkillPackExecutableConfusion` | Un `skill_pack:*` est choisi comme capacité exécutable | Choisir une `skill` ou un `tool` Touba déclaré dans `uses` |

## Agents, mémoires et interactions

| Code | Cause probable | Action |
| --- | --- | --- |
| `UnauthorizedAgentInvocation` | Caller absent de `callable_by` | Corriger l'autorité |
| `MemoryBindingMissing` | Accès mémoire sans binding | Fournir un binding mémoire |
| `MemoryGrantMissing` | Grant mémoire absent | Ajouter le grant si légitime |
| `MemoryNotGrantedToOwner` | Owner actif sans scope mémoire | Corriger le scope source |
| `HumanApprovalRequired` | Approval sans décision | Fournir une décision explicite |
| `InvalidHumanApprovalDecision` | Décision non supportée | Utiliser une décision acceptée |
| `UserInteractionRequired` | `ask` sans entrée | Fournir les entrées utilisateur |
| `InvalidUserInput` | Entrée `ask` non textuelle | Fournir une chaîne |
