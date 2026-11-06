---
sidebar_position: 8
---

# Référence diagnostics

## Gouvernance et intégrité des packages

**Prochain build — en qualification locale.**

| Code | Action |
| --- | --- |
| `PackageGovernanceReviewRequired` | Relire les changements affichés par `prepare --mode plan`, puis sélectionner le digest exact dans `review_packages`. |
| `PackageGovernanceStale` | Vérifier la configuration du consommateur et refaire la préparation. |
| `ToolApprovalPolicyConflict` | Choisir explicitement des rôles et règles compatibles côté application et package. |
| `PackagePreparationStale` | Préparer à nouveau après un changement du projet, du package, du manifest ou du plan. |
| `PackageIntegrityMismatch` | Conserver l'archive attendue, examiner la modification, puis réinstaller une copie vérifiée. |
| `PackageLockInvalid` / `PackageLockMismatch` | Corriger la cohérence du projet et du verrou ; conserver les éléments pour diagnostic. |

La CLI et les SDK JavaScript/Python conservent ces codes d'admission.
`EngineCommandFailed` reste le diagnostic de transport lorsqu'aucun résultat
structuré exploitable n'a été reçu ; le code de sortie est alors disponible.
Les messages privés de stderr ne sont pas recopiés dans le diagnostic public.

## Données typées et admission

| Code | Cause | Action |
| --- | --- | --- |
| `ProjectEntrypointsInvalid` | Liste d'entrées invalide, répétée ou entrée agent directe | Déclarer `entry` et `entrypoints` ; appeler l'agent depuis sa stratégie autorisée |
| `ProjectEntrypointNotAllowed` | Parcours absent des entrées du projet | Vérifier la sélection ; ajouter le parcours autorisé puis refaire `prepare` |
| `InvalidFieldConstraint` | Contrainte incompatible avec le type ou bornes incohérentes | Employer `format "digits"` sur `Text`, `length` sur texte/liste et `min`/`max` sur nombre |
| `InvalidFieldDefault` | Valeur par défaut incompatible avec le type ou ses contraintes | Fournir une valeur statique valide ; voir [données typées](../concepts/donnees-typees.md) |
| `DateValueInvalid` | Conversion d'une date invalide | Fournir une date civile réelle au format `YYYY-MM-DD` |
| `RecordValueInvalid` | Construction ou copie qui viole le contrat d'un champ | Corriger la valeur avant la construction ; les entrées et sorties externes sont également contrôlées |
| `HumanApprovalExclusionEvidenceRequired` | Liste de signataires exclus absente ou règle incorrecte | Faire attester par l'hôte la règle `exclude_signers` déclarée dans le source |

Les erreurs fournisseur exposent des détails bornés : `http_status`,
`finish_reason` et, si disponible, `incomplete_reason`. Une erreur de handler
conserve sa cause ; `receipt_error_code` distingue un reçu d'effet absent ou
invalide. Sans preuve d'application, l'effet reste d'issue inconnue.

## Intégration projet, agents et handlers

| Code | Cause | Action |
| --- | --- | --- |
| `StrategyInterfaceRequired` | Appel source d’une stratégie sans signature de sortie explicite | Déclarer `gives` et fournir chaque argument `takes` |
| `StrategyInputTypeMismatch` | Arguments incompatibles avec l’interface de la stratégie | Corriger les valeurs ou types source, puis recompiler |
| `InvocationDepthLimitExceeded` | Plus de 64 appels imbriqués | Borner la récursion ou simplifier le workflow, sans élargir l’autorité |
| `InvalidHumanApprovalCheckpoint` / `HumanApprovalCheckpointIncompatible` | Continuation absente, mal formée ou incompatible avec l’AIR | Préserver l’état ; employer l’AIR correspondant et un checkpoint complet du format courant, sans rejouer les effets |
| `UnknownToolCapability` | Nom de capacité inconnu | Utiliser la liste fermée du [guide tools](../guides/tool-binding-handler-manifest.md) ; séparer les opérations en tools distincts |
| `MissingTriggerArgument` | Argument `takes` de la cible non lié | Ajouter `with <nom> as payload.<champ>` pour une requête, ou une valeur pour un schedule |
| `AgentDecisionRequired` | Aucune décision déterministe ou provider configuré | Configurer `--agent-decision-provider` sur `run` ou `serve`, ou des décisions explicites |
| `ToolHandlerReportedError` / `UnhandledHandlerError` | Exception du handler | Reproduire son `run({ request, context })` dans un test métier local ; ne pas publier de messages contenant des secrets |
| `TriggerPayloadInvalid` | Champ requis absent ou mauvais type | Corriger le payload et son mapping ; un littéral source n'est pas un repli d'un champ mappé manquant |
| `TriggerEventPayloadConflict` | Identifiant déjà utilisé avec un contenu différent | Ne pas réutiliser l'identifiant pour un nouvel événement |
| `TriggerReplayRejected` | Événement déjà consommé | Retrouver son résultat ; ne pas redispatcher l'effet |
| `ToubaServeDecisionIdentityUnauthorized` | Utilisateur inactif, appareil non appairé ou autorité de décision absente | Configurer l'[identité et l'affectation](../guides/api-serveur-projet.md), sans désactiver les contrôles |
| `ToubaServeSandboxCheckpointStoreInvalid` | État durable incohérent ou corrompu | Conserver les fichiers et diagnostiquer la corrélation ; ne pas supprimer les attentes pour redémarrer |
| `ToubaServeSandboxInvalid` | Requête ou discriminant incorrect pour la route | Utiliser `/triggers/fire` pour un trigger et `/runs/sandbox` pour une entrée |
| `ToubaServeProjectAirStale` | Sources plus récentes que l'AIR ou AIR absent | Relancer `prepare --profile dev --mode write`, puis rafraîchir le projet |
| `ToubaServePreparedProjectInvalid` | Préparation dev invalide, périmée ou hors racine | Corriger les entrées et régénérer la préparation |
| `ToubaServeHumanWaitConflict` | Décision ou reprise déjà réclamée | Relire l'état de cette demande ; ne pas créer une approbation de remplacement |
| `HandlerEntryUnknownTool` | Binding sans déclaration dans les AIR verrouillés | Fournir tous les AIR du projet avec des `--air` répétés, ou retirer le binding réellement obsolète |
| `PreparedAirDrift` | AIR dérivé différent de la compilation attendue | Régénérer avec `prepare --mode write` ; ne pas éditer le dérivé |
| `HandlerDeclaredContractDrift` | Constantes du handler généré différentes du source | Relire et ajuster grants, handles et signature du handler et de son test ; le code métier n'est pas écrasé |
| `RuntimeFailure` (retour incompatible) | Valeur retournée incompatible avec `gives` | Corriger le chemin de retour et son type, puis recompiler ; ne pas accepter `null` comme succès typé |

## Préparation et diagnostic local

| Code | Cause | Action |
| --- | --- | --- |
| `HostDecisionJsonInvalid` / `HostDecisionInvalid` / `HostDecisionFieldUnknown` | Décisions hôte malformées ou champs inconnus | Fournir uniquement les sélections documentées ; JSON CLI limité à 64 KiB, sans valeurs secrètes |
| `HostDecisionTargetUnknown` / `HostDecisionSelectionInvalid` | Cible, grant, handle ou accès non déclaré, ou sélection répétée | Vérifier les besoins source et sélectionner explicitement les droits légitimes |
| `HostDecisionEffectInvalid` / `HostDecisionLimitInvalid` | Contrat d'effet ou limite invalide | Déclarer le contrat exact et des limites entières strictement positives |
| `HostDecisionDrift` | Décisions demandées non appliquées | Revoir le diff en `plan`, appliquer en `write`, puis vérifier en `check` |
| `HostDecisionFragmentConflict` / `BindingFragmentManifestDrift` | Décision concurrente ou dérive d'un fragment | Réconcilier explicitement le fragment et le manifest, sans élargissement automatique |
| `HandlerDiagnosticsForbidden` | Diagnostic privé hors profil local autorisé | Utiliser un run plan `dev` sur POSIX, sans lock obligatoire ni profil durci |
| `HandlerDiagnosticsUnavailable` | Destination absente, existante ou non inscriptible | Choisir un fichier nouveau dans un répertoire accessible ; aucun fichier n'est écrasé |

Cette page liste les diagnostics et erreurs utilisateur principaux.

:::info Comment lire cette page
Chaque ligne donne le code ou la famille d'erreur, sa cause probable et l'action recommandée. Pour approfondir, consulter la [référence CLI](./cli-v1-rc.md) ou le [guide dépannage](https://toubalang.org/docs/guides/depannage).
:::

## Sources, audit et démarrage

| Code | Cause | Action |
| --- | --- | --- |
| `SourceRefMismatch` | Source correspondante absente | Fournir tous les modules avec des `--source` répétés et conserver leur arborescence |
| `SourceRefAmbiguous` / `SourceArtifactDuplicate` / `SourceArtifactUnused` | Sources ambiguës, répétées ou étrangères | Fournir exactement les sources référencées |
| `TraceAuditDigestMismatch` | Artefact différent du scellé | Conserver les preuves et rechercher l'altération, sans régénérer le scellé pour masquer l'écart |
| `ToubaServePreflightFailed` | Démarrage refusé | Lire les diagnostics détaillés et chemins signalés |
| `ToubaServeProductIdentityPathInvalid` | Chemin d'identité extérieur au projet ou invalide | Placer le fichier sous `--project-root` et corriger `--identity` |
| `AgentCapabilityNotAllowed` | Sélection absente du `uses` de l'agent | Corriger la décision ; élargir l'autorité uniquement si la capacité est légitime |
| `InvalidTextLiteral` | Échappement invalide ou contrôle brut | Utiliser les échappements JSON, notamment `\n` et `\\` |

## Compilation et sémantique

| Code ou famille | Cause probable | Action |
| --- | --- | --- |
| `UnknownReference` | Appel ou référence introuvable | Vérifier le nom et la déclaration |
| `MissingExplicitCallArgument` | Argument requis absent | Ajouter `with <nom> as <expression>` |
| `UnknownCallArgument` | Nom d'argument inconnu | Aligner le nom après `with` avec `takes` |
| `DuplicateCallArgument` | Même argument fourni deux fois | Supprimer le doublon |
| `DuplicateResultBinding` | Binding `into` déjà utilisé | Choisir un nom distinct |
| `DuplicateLocalBinding` | Nom `bind` déjà utilisé dans le graphe | Choisir un nom local distinct |
| `UnsupportedModuleConstantExpression` | `define` contient autre chose qu'un littéral ou membre d'énumération qualifié | Utiliser une valeur admise ou déplacer le calcul dans une fonction |
| `UnreachableStatement` | Instruction placée après un retour terminal (`give`, `stop`, ou `if` dont toutes les branches terminent) | Déplacer l’instruction avant le retour, ou garder un seul `give` par chemin |
| `InvalidBranchCondition` | Condition `if` non booléenne | Produire un `Boolean` |
| `MissingAgentInterfaceOutput` | Agent avec `takes` mais sans sortie finale | Ajouter `gives <Type>` |
| `EnrichedAgentCallBlocked` | Appel `with`/`into` vers un agent sans interface résolue | Déclarer `takes` / `gives` et fournir les sources nécessaires à la résolution, y compris les modules importés |
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
| `UnknownEnumVariant` | Membre d'énumération inconnu | Utiliser un membre déclaré du type qualifié |
| `DuplicateEnumVariant` | Membre déclaré plusieurs fois | Garder un nom unique par membre |
| `StaticExpressionDivisionByZero` | Division par zéro détectable | Corriger le dénominateur |
| `InvariantLoopCondition` | `while` utilise directement `true` ou `false` | Fournir une condition qui dépend d'une valeur runtime, ou retirer la boucle |
| `UnknownRecordType` | Type cible du constructeur inconnu | Déclarer un type local existant |
| `MissingRecordField` | Champ obligatoire non fourni | Ajouter le champ au constructeur |
| `UnknownRecordField` | Champ absent du type nominal | Corriger ou retirer le champ |
| `DuplicateRecordField` | Même champ fourni plusieurs fois | Conserver une occurrence |
| `RecordFieldTypeMismatch` | Valeur incompatible avec le type du champ | Corriger l'expression ou le type |
| `AstError` | Erreur de syntaxe ou construction non admise | Examiner la position locale et le conseil associé ; vérifier indentation et clauses, sans accepter un arbre récupéré |

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
| `OptionalValueAbsent` | Extraction d'une absence dans un AIR fourni directement | Recompiler le source et extraire seulement dans `if present` |
| `OptionalValueInvalid` | Enveloppe ou type d'optionnel incohérent | Conserver l'enveloppe présente/absente et le type déclaré, sans null implicite |
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
| `PackageExportMissing` | Import privé, module exporté absent de l’inventaire, ou package sans export ni contexte | Vérifier exports, fichiers inclus et contexts ; corriger l’import si nécessaire |
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
| `SkillPackRefInvalid` | Ref de pack ou de ressource invalide | Utiliser `skill_pack:<namespace>/<skill-id>` ou `resource:<skill-id>/<name>` |
| `SkillPackResourceKindInvalid` | Type de ressource non supporté | Utiliser `procedure`, `reference`, `example`, `template`, `sample` ou `script` |
| `SkillPackResourcePathInvalid` | Chemin absent, absolu, sortant ou non fichier | Garder un chemin relatif interne au pack |
| `SkillPackDigestMismatch` | Digest différent du contenu | Mettre à jour le digest après relecture du fichier |
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

## Parallélisme et continuations

| Code | Cause | Action |
| --- | --- | --- |
| `InvalidParallelContract` | Cible, signature ou contexte de `parallel` invalide | Déclarer une cible typée depuis une skill/stratégie et recompiler la source. |
| `ParallelInputTypeMismatch` | Au moins un argument ne respecte pas la signature | Corriger la liste ou les liaisons ; le groupe est refusé avant son premier appel. |
| `ParallelItemLimitExceeded` | Entrée non liste ou cardinalité au-delà de la borne | Vérifier le type et traiter des lots dans les limites déclarées ; aucune troncature implicite. |
| `ParallelBranchLimitExceeded` | Trop de branches vivantes, groupes imbriqués compris | Réduire le fan-out ou revoir les plafonds hôte justifiés, sans contourner les budgets. |
| `ParallelUserInputRequired` | `ask` sans réponse hôte pour son occurrence | Fournir une réponse corrélée ; ne pas réutiliser la réponse d'une autre branche. |
| `ParallelJournalLimitExceeded` / `ParallelCheckpointLimitExceeded` | Journal privé ou checkpoint trop volumineux | Réduire la taille des données ou du groupe ; préserver le dernier état valide. |
| `InvalidParallelCheckpoint` / `ParallelContinuationMismatch` | État incomplet ou divergent de l'exécution sauvegardée | Conserver le fichier, vérifier build, source et artefacts ; ne pas le corriger à la main. |
| `ParallelOutcomeUnknown` | Appel interrompu sans issue démontrée | Rapprocher l'effet avec le journal et le service externe ; pas de redispatch aveugle. |

Les erreurs propres au tool, au provider, à l'autorité ou au budget restent
visibles : un échec de branche n'est pas remplacé par un succès partiel.
Voir [Reprise](../guides/reprise-durable-bornee.md) et [Budgets](../guides/budgets-autonomie.md).

## Distribution des packages

Voir les [diagnostics de package](packages.md#vérifications-et-diagnostics). Les fichiers auteur utilisent un seul manifeste ; les contrôles contextuels runtime conservent leurs codes SkillPack.

## Contraintes d'approbation

| Code | Action |
| --- | --- |
| `InvalidHumanApprovalPolicy` | Fournir des littéraux valides pour rôle, délai et séparation. |
| `HumanApprovalExpirationMustTerminate` | Terminer chaque chemin d'expiration par `give` ou `stop`. |
| `HumanApprovalAuthorityRequired` / `HumanApprovalEvidenceRequired` | Fournir l'adaptateur hôte et la référence d'une preuve authentifiée. |
| `HumanApprovalAuthorityUnavailable` | Rétablir le service d'identité ; aucune continuation n'a été autorisée. |
| `HumanApprovalRoleRequired` / `HumanApprovalSignerConflict` | Choisir un signataire distinct possédant actuellement le rôle requis. |
| `HumanApprovalAttestationInvalid` | Lier la preuve à cette demande, ce run et cette décision exacts. |
| `HumanApprovalCheckpointIncompatible` | Conserver l'AIR original et le checkpoint privé complet ; ne pas inventer l'état d'autorité manquant. |
| `HumanApprovalStateLimitExceeded` | Le run atteint sa borne de 10 000 demandes et reçus d'approbation. |

## Provenance d’état et installation

- `ToubaServeStateBuildMismatch` : utiliser la build conservée qui a créé l’état,
 puis contrôler la transition ; ne pas réécrire son identité.
- `ToubaServeStateProjectMismatch` : la provenance vise un autre chemin de projet.
 Restaurer le projet à son emplacement d’origine ; aucune migration implicite.
- `ToubaServeStateOriginInvalid` / `ToubaServeBuildIdentityInvalid` : métadonnées
 invalides ; vérifier l’archive et la sauvegarde.
- `ToubaServeStateSnapshotRequired` : journal SQLite présent ; arrêter les
 écrivains et établir une sauvegarde cohérente avant le préflight.
- `ToubaStoreFormatIncompatible` : format d’état non reconnu par cette build.
- `InstallationBuildMismatch`, `InstallationArchiveConflict` : empreinte
 incohérente ; l’installation active n’est pas remplacée.
- `InstallationInProgress` : verrou d’installation présent. Vérifier le processus
 propriétaire avant toute intervention ; pas de reprise concurrente implicite.
- `InstallationPathUnsafe` / `InstallationPathsOverlap` : cible liée ou
 recouvrant la source ; choisir des répertoires distincts.

## Politiques hôtes et contrôle de contenu

- `ProjectConfigFieldUnknown` : clé inconnue dans le projet ou `configuration`.
 Les contextes se déclarent dans `configuration.contexts`.
- `ToolHandlerSandboxAccessDenied` : l'OS signale un accès refusé dans la
 sandbox obligatoire. Vérifier les chemins de code et les grants/périmètres
 de données, sans désactiver l'isolation. Un module inaccessible peut aussi
 apparaître comme introuvable ; ce cas reste un échec de chargement.
- `EngineCapacityExceeded` : le moteur JavaScript persistant a atteint sa
 capacité de requêtes. Attendre la fin d'un run actif avant de réessayer ;
 ce n'est pas un échec de lancement.

`SkillPackSensitiveContentForbidden` reconnaît les valeurs de secrets résolues
pour le run et les catégories de contenu explicitement interdites. Il ne s'agit
pas d'un détecteur générique de motifs de clés API. Aucun secret ne doit être
distribué dans les ressources de package.

`HandlerSandboxUnsupportedPolicy` refuse une sandbox obligatoire sur un backend
non qualifié. `HandlerSandboxGrantMissing` demande le grant correspondant aux
chemins sélectionnés. `HandlerSandboxPathInvalid` demande un interpréteur
absolu existant et des fichiers `code_paths` individuels existants.
`HandlerSandboxPythonRuntimeMissing` indique que l'interpréteur natif d'une
installation CPython framework macOS manque dans cet inventaire. Générez et
relisez la sélection avec `touba sdk sandbox python --handler <fichier.py>`.
`SdkSandboxConfigurationInvalid` demande de vérifier le handler local, le SDK
et l'interpréteur choisis avant de générer l'inventaire.
`ToolHandlerSdkMissing` couvre aussi l'import Python `touba_sdk` inaccessible.
Vérifiez l'installation du SDK puis, sous confinement, ses fichiers de code.
Le diagnostic local Python conserve uniquement une classe d'erreur connue et
la ligne du handler sélectionné ; les messages et chemins privés restent exclus.
`HardenedSandboxUnavailable` indique l'échec de la sonde hôte réelle ou une
politique non qualifiée, sans autoriser une relance hors sandbox.

## Composition, providers et reprise

| Diagnostic | Action |
| --- | --- |
| `CapabilityNotDeclaredInUses` / `CompositionCapabilityNotAllowed` | Déclarer la cible dans le `uses` de la skill ou stratégie appelante, y compris fallback et appel parallèle. |
| `AgentCapabilityDescriptionRequired` | Ajouter une description utile à la capacité du catalogue agent. L'avertissement localise l'agent concerné. |
| `ToolBindingReviewRequired` | Relire le brouillon de manifest et choisir explicitement le contrat d'effet. |
| `HumanApprovalCheckpointIncompatible` | Retrouver le contrat hôte de la demande ou créer une nouvelle demande revue. |
| `HumanApprovalPauseRequiresDurableResume` | Activer le checkpoint durable avant une pause humaine dans l'agent. |
| `TraceAirDigestMismatch` | Sélectionner l'AIR exact de cette exécution pour naviguer vers ses sources. |
| `PythonHostImportFailed` / `PythonHostConfigurationInvalid` | Vérifier l'environnement du projet, les imports et le callback exporté. |
| `PythonHostCallbackFailed` | Examiner le diagnostic local borné du module hôte. |
| `PythonHostTlsFailed` / `PythonHostTransportFailed` / `PythonHostTimeout` | Vérifier certificat, destination et délai du transport fournisseur. |

`ToolPayloadConstraintViolation` relève de l'autorité, les erreurs de sortie
de handler de la famille `handler`. Une issue d'effet inconnue exige un
rapprochement ; elle n'entre pas dans un fallback métier automatique.
