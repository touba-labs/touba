---
sidebar_position: 8
---

# Référence diagnostics

Cette page liste les diagnostics et erreurs utilisateur principaux.

:::info Comment lire cette page
Chaque ligne donne le code ou la famille d'erreur, sa cause probable et l'action recommandée. Pour approfondir, consulter la [référence CLI](./cli-v1-rc.md) ou le [guide dépannage](https://pap-touba.github.io/documentation-site/docs/guides/depannage).
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
| `MissingAgentInterfaceOutput` | Agent avec `takes` mais sans sortie finale | Ajouter `gives <Type>` |
| `EnrichedAgentCallBlocked` | Appel `with`/`into` vers un agent historique ou dont la signature n’est pas résolue localement | Déclarer l’interface locale, ou conserver l’appel simple |
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
| `InvariantLoopCondition` | `while` utilise directement `true` ou `false` | Fournir une condition qui dépend d'une valeur runtime, ou retirer la boucle |
| `UnknownRecordType` | Type cible du constructeur inconnu | Déclarer un type local existant |
| `MissingRecordField` | Champ obligatoire non fourni | Ajouter le champ au constructeur |
| `UnknownRecordField` | Champ absent du type nominal | Corriger ou retirer le champ |
| `DuplicateRecordField` | Même champ fourni plusieurs fois | Conserver une occurrence |
| `RecordFieldTypeMismatch` | Valeur incompatible avec le type du champ | Corriger l'expression ou le type |
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
| `AgentInterfaceRequired` | AIR tente un appel agent enrichi sans interface | Recompiler avec une signature agent explicite |
| `AgentInterfaceInputRequired` | Entrée agent déclarée absente au runtime | Fournir tous les arguments `with` |
| `AgentInterfaceInputTypeMismatch` | Valeur d’entrée incompatible avec `takes` | Corriger l’appel ou le type source |
| `AgentInterfaceResultTypeMismatch` | Réponse directe ou sortie finale incompatible avec `gives` | Corriger le provider ou la capacité avant publication du résultat |
| `MissingAgentResponsibility` | Agent sans contrat de responsabilité source | Ajouter exactement une clause `responsibility "..."` non vide |
| `DuplicateAgentResponsibility` | Plusieurs responsabilités sur le même agent | Conserver une seule clause `responsibility` canonique |
| `InvalidAgentResponsibility` | Responsabilité vide | Décrire explicitement ce dont l’agent répond, sans utiliser son nom comme fallback |

## Workflow projet

| Code | Cause probable | Action |
| --- | --- | --- |
| `ModulePathNotCanonical` | Fichier source hors convention projet | Utiliser `src/<domaine>/<module>.tb` avec `module domaine.module` |
| `ModulePathMismatch` | Nom de module différent du chemin source | Aligner le chemin et la ligne `module` |
| `ProjectRunProfileUnknown` | Profil demandé absent de `touba.project.json` | Déclarer le profil ou utiliser `pure`, `dev` ou `prod` disponible |
| `EffectiveProjectMissing` | Projection effective absente en mode `check` | Relancer `touba prepare --mode write --profile <profil>` |
| `EffectiveProjectDrift` | Projection effective différente de ses entrées déclarées | Examiner les changements puis régénérer avec `prepare --mode write` |
| `EffectiveProjectReadFailed` | Projection effective illisible ou non JSON | Retirer l’artefact dérivé invalide puis le régénérer |
| `ManifestDerivedDrift` | Manifest dérivé élargi ou modifié hors des entrées projet | Déclarer l’autorité dans un fragment explicite puis régénérer ; ne pas éditer le dérivé |
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
| `PackageAirProfileIncompatible` | Profil AIR du package incompatible | Utiliser un package ciblant `touba-air-json-canonical-v1` |
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
| `BindingFragmentSchemaMismatch` | Fragment hors schéma `touba-binding-fragment-v1` | Corriger le schéma ou régénérer le fragment |
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
| `ResourceBindingsSchemaMismatch` | Resource bindings hors schéma `touba-resource-bindings-v1` | Corriger ou régénérer l’artefact |
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
| `SkillPackSchemaMismatch` | Schéma, champ ou type de champ invalide | Corriger `skill.json` selon `touba-skill-pack-v1` |
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

## Authoring client et changements

| Code | Cause probable | Action |
| --- | --- | --- |
| `ToubaServeElementAuthoringInvalid` | Intention de création incomplète ou hors contrat | Corriger les champs du formulaire selon la primitive |
| `ToubaServeElementAlreadyExists` | Une déclaration porte déjà ce nom dans le module | Choisir un nom distinct ou modifier l’élément existant |
| `ToubaServeElementDescriptionRequired` | Capacité créée sans description explicite | Ajouter une description utile au routage agentique |
| `ToubaServeElementResponsibilityRequired` | Agent créé sans responsabilité explicite | Décrire ce dont l’agent répond dans le champ `responsibility` |
| `ToubaServeElementReferenceUnknown` | Référence `uses`, `callable_by`, scope ou cible absente | Sélectionner une référence déclarée dans le module |
| `ToubaServeElementCrossModuleReferenceRejected` | L’intention tente de créer une référence implicite entre modules | Déclarer l’import dans la source avant de proposer la relation |
| `ToubaServeChangeSourceDrift` | Le fichier a changé depuis la création de la proposition | Actualiser le projet et soumettre une nouvelle proposition |
| `ToubaServeChangeProjectLocked` | Une transaction multifichier est déjà en cours | Attendre sa fin ou récupérer la transaction signalée |
| `ToubaServeChangeRecoveryConflict` | La récupération ne peut pas déterminer un état unique | Examiner le journal de transaction avant toute nouvelle écriture |

## Déploiement

| Code | Cause probable | Action |
| --- | --- | --- |
| `ToubaDeploymentSupplyChainLockMissing` | Bundle `prod` sans lock supply chain | Produire et valider `touba.lock.json` |
| `ToubaDeploymentRawSecretRejected` | Valeur secrète détectée dans un artefact | Remplacer la valeur par un handle |
| `ToubaDeploymentHandlerImplementation` | Stub de handler encore présent en profil `prod` | Implémenter et tester le handler |
| `ToubaDeploymentSourceRevision` | Révision source sale en profil `prod` | Revoir et committer les changements attendus |
| `ToubaDeploymentInsecureTargetRejected` | Cible distante en HTTP | Utiliser HTTPS |
| `ToubaDeploymentUnauthorized` | Token absent ou invalide | Fournir le token de la cible via la variable déclarée |
| `ToubaDeploymentRevisionNotFound` | Révision demandée absente | Consulter `touba deploy list` |
| `ToubaDeploymentRevisionCorrupt` | Artefact matérialisé différent de son digest | Retirer la cible du trafic et restaurer une révision vérifiée |
| `ToubaDeploymentRollbackUnavailable` | Aucune activation précédente disponible | Activer explicitement une révision connue |
| `ToubaServeDeploymentTargetNotConfigured` | Serveur projet sans cible de déploiement | Fournir les deux options `--deployment-target-*` |

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
