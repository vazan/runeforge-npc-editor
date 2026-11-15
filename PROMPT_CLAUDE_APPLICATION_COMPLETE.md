# PROMPT MAÎTRE — DÉVELOPPER RUNEFORGE STUDIO AU COMPLET

> **Mode d'emploi :** placer ce fichier et `CLAUDE.md` à la racine du dépôt, puis copier intégralement la section **« Prompt à envoyer à Claude Code »** dans Claude Code. Ce document vise l'application complète (M0 à M9), pas uniquement la V1. Il peut servir de mandat de réalisation et de protocole de reprise entre les sessions.
>
> **Attention :** aucun agent de codage ne peut garantir une réalisation intégrale en une seule session. Il doit poursuivre tant que l'environnement et les limites de session le permettent, préserver l'état du projet, puis reprendre au prochain lancement. Les résultats sont considérés comme réalisés uniquement après exécution et vérification.

---

# Prompt à envoyer à Claude Code

Tu es **Claude Code**, agissant comme une équipe intégrée d'ingénierie composée des rôles suivants : architecte logiciel principal, ingénieur TypeScript, ingénieur Rust/Tauri, spécialiste des langages de programmation et des LSP, concepteur UX/UI, ingénieur QA, expert DevSecOps et responsable technique produit. Organise le travail comme le ferait une équipe professionnelle, mais réalise **du vrai code dans ce dépôt** plutôt que de livrer seulement des conseils, des maquettes ou des spécifications.

## 1. MISSION — APPLICATION ENTIÈRE, PAS SEULEMENT UN MVP

Ta mission est de **construire de bout en bout RuneForge Studio**, un IDE desktop commercial pour créer, modifier, comprendre, tester et déployer des NPC et scripts de Ragnarok Online, compatible **rAthena et Hercules**, disponible sous **Windows et Linux**, avec tous les modules décrits ci-dessous.

**Lis d'abord entièrement `CLAUDE.md`.** Ce fichier constitue le cahier des charges détaillé et la référence principale pour la conception. Le présent prompt ajoute une directive décisive : **la cible finale est l'application complète, incluant M0, M1, M2, M3, M4, M5, M6, M7, M8 et M9, et non l'arrêt après M0, après l'IDE de base ou après une V1.**

En cas de conflit :
1. la sécurité, les droits et les interdictions explicites du propriétaire priment ;
2. le cahier des charges `CLAUDE.md` fixe les contrats, le périmètre et l'architecture ;
3. ce prompt impose l'objectif final complet, la méthode d'exécution continue et les critères de preuve ;
4. documente toute décision de résolution dans `docs/DECISIONS.md`.

**Ne déclare jamais un module terminé tant que ses comportements réels ne sont pas implémentés, testés et intégrés.** Une interface factice, un bouton inerte, un adaptateur simulé ou une fonction `TODO` ne constituent pas une livraison.

## 2. OBJECTIF UTILISATEUR ET EXPÉRIENCE ATTENDUE

L'application doit convenir autant à un débutant absolu qu'à un scripteur expérimenté :

- Le débutant crée un Warp, Shop, Healer, Buffer, Quest NPC, Event NPC ou système avancé à travers des assistants et des blocs visuels, sans devoir apprendre la syntaxe.
- L'expert dispose d'un véritable IDE : langage reconnu, coloration, autocomplétion, signature help, diagnostics, recherche de références, navigation, refactoring sûr, diff et templates.
- L'utilisateur peut importer un script existant et le transformer **autant que possible** en graphe éditable, tout en conservant fidèlement les segments non convertibles.
- Les différences réelles entre rAthena et Hercules sont explicites ; les variantes et forks personnalisés peuvent étendre les commandes, les bases de données et les règles.
- Le produit fonctionne hors ligne pour ses fonctions essentielles ; l'IA et les services distants restent facultatifs.
- Toute action susceptible d'écraser des fichiers, d'exécuter des commandes, de modifier un serveur ou de transmettre des données nécessite une autorisation explicite.
- Les textes de l'application doivent exister en **français et en anglais**.

L'interface doit être propre, moderne, accessible, réactive et cohérente, avec thèmes sombre/clair, palette de commandes, panneaux redimensionnables, raccourcis clavier, états vides utiles, erreurs compréhensibles et assistant d'accueil.

## 3. STACK ET PRINCIPES DE CONCEPTION

Utilise de préférence :

- **Desktop :** Tauri 2 et Rust.
- **UI :** React, TypeScript, Vite.
- **Édition :** Monaco Editor.
- **Langage :** lexer/parser TypeScript tolérant aux erreurs, CST préservant le texte, AST, analyse sémantique, service LSP et indexation des symboles.
- **Graphe :** React Flow (après vérification des licences et versions).
- **Données locales :** SQLite et index de recherche si cela apporte un bénéfice concret ; indexes mémoire pour les opérations sensibles à la latence.
- **Monorepo :** pnpm workspaces, Cargo workspace pour les crates Rust.
- **Tests :** tests unitaires, intégration, corpus réels, golden tests, tests de propriétés/fuzzing ciblés, E2E multiplateforme, CI.
- **IA :** abstraction de fournisseur, endpoint local configurable compatible avec les API usuelles (p. ex. vLLM sur NVIDIA DGX Spark), plus adaptateurs cloud facultatifs.

Tu peux proposer et documenter une modification technologique **uniquement si elle offre un gain vérifiable** et ne compromet ni l'interopérabilité ni la maintenabilité. Évite les microservices non nécessaires, la complexité de type SaaS pour le moteur local et les abstractions spéculatives.

**Architecture modulaire :** la logique du langage et la compatibilité émulateur ne doivent jamais dépendre de React ou de Tauri. L'interface ne doit jamais contenir de logique propre à un émulateur qui devrait vivre dans un adaptateur.

## 4. MODULES OBLIGATOIRES DU PRODUIT FINAL

### A. Application desktop et expérience utilisateur

Implémente une application installable Windows/Linux avec assistant de premier lancement, ouverture/création des projets, explorateur de fichiers, éditeur multi-onglets, panneaux de diagnostics, recherche globale, palette de commandes, navigation, paramètres, sélection de profil d'émulateur, thèmes clair/sombre, traduction FR/EN, restauration de sessions, gestion d'erreurs et historique/annulation. Assure une sauvegarde fiable qui préserve l'encodage, les fins de ligne et les modifications utilisateur.

### B. Éditeur de code de niveau professionnel

Implémente Monaco et un service de langage intégrant coloration syntaxique, suggestions contextuelles, documentation au survol, signature help, diagnostics hiérarchisés, complétion des commandes/constantes/maps/items/monstres/symboles, navigation définition/références, recherche dans le projet, document symbols, renommage sécurisé lorsque possible, snippets, corrections rapides, mise en forme non destructive et refactorisations prudentes. Affiche clairement les constructions inconnues et la confiance des diagnostics.

### C. RuneScript Language Engine (fondation commune)

Crée un lexer robuste, un CST conservant les espaces/commentaires/positions, un AST explicite et un analyseur sémantique. Prends en charge les déclarations NPC, warp/shop/script/functions, événements, labels, variables, expressions, appels de commandes et structures de contrôle selon les références officielles retenues. Le parser doit rester utile sur un document incomplet et ne doit jamais effacer les constructions non reconnues. Il doit produire des plages de source précises, des erreurs récupérables et une représentation exploitable par le LSP, les assistants, les graphes et les validations.

### D. Compatibilité rAthena/Hercules/forks

Crée des adaptateurs et catalogues **versionnés**, avec signatures et disponibilité des commandes, règles syntaxiques, préfixes/portées des variables, conventions de fichiers, schémas de bases et paramètres d'intégration. Permets les commandes/constantes/fonctions personnalisées. N'invente pas d'équivalences. Indique lorsqu'une commande est inconnue plutôt qu'erronée avec certitude. Ajoute des tests de compatibilité sur des corpus identifiés par branche/version/révision.

### E. Explorateurs de ressources et bases du serveur

Charge et indexe les ressources locales légalement disponibles : items, monstres, cartes, constantes, NPC, scripts, fonctions, labels, compétences et quêtes selon les formats présents. Ajoute une recherche rapide, filtres, prévisualisation et insertion dans l'éditeur. Gère les données personnalisées, surcharges, doublons, variations de format et erreurs de lecture. Ne distribue aucune ressource propriétaire sans droit.

### F. Assistants de création de NPC

Développe des assistants guidés **fonctionnels**, pas seulement des formulaires : Warp, Shop, Healer, Buffer, Job/Quest NPC, dialogues interactifs, récompenses, contrôles de niveau, inventaire, monnaies, conditions, événements et modèles extensibles. Affiche le code généré, ses prérequis et les diagnostics. Chaque générateur doit avoir des tests démontrant que les scripts générés correspondent au profil de l'émulateur cible. Un assistant complexe peut combiner des composants réutilisables.

### G. Éditeur visuel drag-and-drop complet

Développe un canvas par nœuds avec palette de blocs, recherche, glisser-déposer, connexions typées, validation des ports, conditions, boucles, variables, menus, dialogues, actions joueur/NPC, récompenses, événements, fonctions, sous-graphes, navigation, zoom, annulation/rétablissement, copier/coller et sérialisation des graphes. Permets les **blocs personnalisés** et les segments `Raw Script`. Prévoyez le débogage des flux lorsque la simulation le permet. Un graphe doit générer des scripts réellement exécutables sur la cible supportée, et non un pseudo-langage.

### H. Importation et édition bidirectionnelle code ↔ visuel

Implémente les pipelines graph-to-code et code-to-graph **avec sécurité des transformations**. Classifie les sections importées : convertible, partiellement convertible, non convertible. Utilise des patches ciblés basés sur CST/plages source/versions de document ; préserve intégralement les sections non reconnues. Lors d'une ambiguïté, refuse de transformer automatiquement et affiche un diff. Interdis tout écrasement silencieux. Ajoute des tests round-trip, de propriétés et de conservation des commentaires/encodages.

Ne prétends jamais que « n'importe quel script » peut toujours être converti parfaitement en blocs. La promesse produit est : **tout script peut être édité en code, les portions représentables peuvent être éditées visuellement, et le reste reste éditable sans perte**.

### I. Simulation et prévisualisation

Développe d'abord un simulateur déterministe des dialogues, conditions et parcours couverts : variables de test, niveau, Zeny, inventaire et choix utilisateur. Affiche quelles fonctions sont simulées et lesquelles ne le sont pas. Ensuite, ajoute une prévisualisation graphique **uniquement avec des ressources autorisées ou importées légalement**, et enfin la validation sur un **vrai serveur de test isolé** lorsque configurable. La simulation ne doit jamais être présentée comme équivalente au moteur rAthena/Hercules.

### J. Intégrations serveur, Git et déploiement

Supporte l'ouverture des fichiers locaux, l'exportation, le lien avec un projet serveur, les opérations Git utiles (statut/diff/commits seulement sur demande), les connexions SSH/SFTP sécurisées, dry-run, comparaison distante, sauvegarde des originaux, transfert prudent, journalisation, vérification et possibilité de retour arrière. N'exécute pas de rechargement sur serveur de production par défaut. L'utilisateur doit configurer lui-même sa cible, son accès et autoriser chaque opération potentiellement dangereuse.

### K. Assistance IA locale et cloud

Ajoute un assistant qui explique, génère, améliore et débogue les scripts et propose des graphes. Fais passer les sorties IA par le parser, les diagnostics, les profils de compatibilité et un écran de diff/approbation avant application. Un utilisateur doit pouvoir configurer un serveur d'inférence local (dont DGX Spark/vLLM si disponible) et des API cloud optionnelles. Les clés et secrets vont dans un stockage sécurisé. Aucune transmission de code à un fournisseur cloud sans consentement clair. L'IA ne doit pas être obligatoire pour l'autocomplétion de base.

### L. Extensions, catalogues et modèles personnalisés

Fournis une API de plugins versionnée pour les définitions déclaratives, nouveaux modèles, validateurs et blocs. Les extensions exécutables seront isolées et dotées d'autorisations précises ; ne charge pas de JavaScript tiers arbitraire dans le contexte privilégié. Prévois import/export de collections de blocs et modèles. Une marketplace pourra être ajoutée si un mécanisme sûr et un modèle commercial viable sont établis.

### M. Fonctionnalités commerciales, installation et mises à jour

Prépare distributions Windows/Linux, paquetage, signatures, mises à jour vérifiées, identification des versions, crash reports opt-in, politique de confidentialité, documentation et support. Crée une architecture de licence qui respecte un fonctionnement hors ligne raisonnable ; réalise les composants contrôlables localement et marque les dépendances externes (compte marchand, clés de signature, serveur de paiement, conseiller juridique) comme **étapes bloquées par le propriétaire**, sans inventer de contrats, clés, paiements ou conformité. Ne publie rien sans autorisation.

## 5. ARCHITECTURE ET ORGANISATION DU DÉPÔT

Respecte la structure modulaire définie dans `CLAUDE.md`. À titre indicatif :

```text
apps/desktop/
  src/
  src-tauri/
packages/
  runescript-lexer/
  runescript-parser/
  runescript-ast/
  runescript-analysis/
  runescript-language-server/
  runescript-formatter/
  emulator-core/
  emulator-rathena/
  emulator-hercules/
  project-core/
  database-indexer/
  npc-templates/
  visual-core/
  visual-editor/
  ai-core/
  plugin-sdk/
  shared-types/
  ui/
crates/
  filesystem/
  remote-transport/
  secure-storage/
  deployment/
tests/
  fixtures/
  corpus/
  compatibility/
  integration/
  e2e/
docs/
  STATUS.md
  ROADMAP.md
  DECISIONS.md
  TEST_MATRIX.md
  RELEASE_CHECKLIST.md
```

Ne crée pas des dizaines de packages vides pour « simuler l'avancement ». Crée chaque module au moment où un morceau fonctionnel et testé le nécessite.

Fais des contrats TypeScript stricts et documentés entre les modules : `EmulatorAdapter`, `LanguageProfile`, `CommandRegistry`, `ProjectContext`, `DatabaseProvider`, `AIProvider`, `VisualNodeDefinition`, `TransformResult`, `DeploymentStrategy` et autres selon besoin réel. Réduis les dépendances circulaires et garde les adaptateurs isolés.

## 6. EXÉCUTION DE M0 À M9 — NE T'ARRÊTE PAS VOLONTAIREMENT À LA V1

Ordre de construction **obligatoire**, avec jalons validés, sans sauter le cœur technique :

**M0 — Fondations :** auditer le dépôt, préparer le monorepo, Tauri/React/TypeScript/Rust, conventions, documentation, corpus de scripts, CI de base et POC du parser. Livrer un build desktop minimal et un premier test.

**M1 — IDE desktop :** interface utilisable, explorateur, onglets, Monaco, ouverture/sauvegarde sûre, préférences, gestion de projet et tests E2E initiaux.

**M2 — Moteur de langage :** lexer, parser CST/AST, récupération sur erreurs, catalogue de commandes, symboles et premiers diagnostics, testés avec un corpus réel.

**M3 — IntelliSense/LSP :** complétion contextuelle, hover, signatures, diagnostics, navigation, recherche, code actions, snippets et références.

**M4 — Émulateurs et bases :** adaptateurs rAthena/Hercules versionnés, bases de données, constantes, overrides, ressources, commandes personnalisées et validation croisée.

**M5 — Première release commerciale stable :** UX, localisation FR/EN, optimisation, sûreté, tests, docs, packaging et préparation des licences/updates. Préserver un jalon V1 exploitable ; **enchaîner ensuite M6 sans considérer la mission complète**.

**M6 — Assistants et serveur :** générateurs guidés, templates avancés, Git, SSH/SFTP, dry-run, sauvegardes distantes, tests de déploiement sûr.

**M7 — Studio visuel :** graph editor, blocs configurables et personnalisés, système de graphes, import code→graphe, génération graphe→code, diff et transformations non destructives, tests round-trip.

**M8 — Simulation + IA :** simulateur de dialogues/logique, états de joueur, preview sous contraintes de droits, IA locale/cloud configurables, propositions structurées, validation et approbation.

**M9 — Studio avancé et finalisation :** intégration à un vrai serveur de test, extensions, catalogue de templates, protections de sécurité, revue d'architecture, docs finales, installateurs Windows/Linux, audit des dépendances, processus commercial réalisable et checklist complète de livraison.

**Important :** les jalons décrivent un ordre de travail et des checkpoints, pas une permission de laisser M6–M9 comme des promesses. La cible est le produit final. Si les contraintes d'environnement ou de session empêchent la fin, inscris précisément ce qui reste à faire et reprends à la prochaine exécution.

## 7. PROTOCOLE DE TRAVAIL EN CONTINU

**Commence immédiatement**, sans demander au préalable d'écrire un autre plan. Au début de chaque session :

1. Lis entièrement `CLAUDE.md`, ce prompt et la documentation d'état si elle existe.
2. Inspecte les vrais fichiers, la configuration du dépôt, les dépendances et les scripts disponibles. Ne suppose pas que le dépôt est vide ni que les modules sont terminés.
3. Exécute les validations de référence applicables et identifie les régressions existantes.
4. Consulte la matrice de jalons et sélectionne la **plus petite tranche verticale utile** du premier jalon non terminé.
5. Implémente réellement le code, les tests et la documentation nécessaires à cette tranche.
6. Exécute les tests pertinents, le typecheck, le lint et le build accessibles, puis corrige les problèmes introduits.
7. Mets à jour l'état du projet, les décisions, les tests, les limites et la prochaine tranche.
8. **Continue avec la tranche suivante** tant que la session, le contexte, les outils et la sûreté le permettent : ne termine pas volontairement dès qu'un fichier de plan ou un premier prototype existe.
9. À la fin de la session, remets un bilan factuel et un point de reprise exact. À la prochaine session, reprends à partir de cet état sans réécrire les fichiers déjà sains.

Interdictions :

- Ne reste pas bloqué en « mode plan » ou en production de documents.
- N'écris pas l'intégralité de l'application dans un seul fichier géant.
- Ne remplis pas le dépôt de squelettes, fonctions factices ou `TODO` présentés comme des fonctions livrées.
- N'utilise pas de mocks dans la version de production pour prétendre à une intégration réelle.
- N'efface, ne reformate ni ne réorganise massivement du code utilisateur sans preuve d'équivalence et accord approprié.
- Ne modifie pas des données de serveur de production, ne publie pas de release, ne paie pas de service, ne crée pas de compte et n'effectue pas de push/commit sans autorisation explicite ou consigne déjà autorisée dans le dépôt.
- Ne déclare jamais « 100 % terminé » sur la seule base d'une compilation réussie.

Si la demande nécessite des secrets, accès à un vrai serveur, ressources propriétaires, signatures de code, infrastructure commerciale ou décisions juridiques indisponibles, **construis ce qui peut être vérifié localement**, isole les intégrations et consigne la dépendance sous `BLOCKED_EXTERNAL` avec instructions de validation. N'invente pas le résultat de vérifications impossibles.

## 8. DOCUMENTS DE PILOTAGE OBLIGATOIRES

Crée et maintiens ces fichiers en plus du `CLAUDE.md` existant :

- `docs/STATUS.md` : état réel de chaque jalon (NOT_STARTED, IN_PROGRESS, VERIFIED, BLOCKED), preuves et dernier test réussi.
- `docs/ROADMAP.md` : tâches, dépendances, ordre de réalisation et prochaine étape exécutable.
- `docs/DECISIONS.md` : décisions d'architecture datées et leur justification.
- `docs/TEST_MATRIX.md` : couverture par fonctionnalité, émulateur, version, OS, jeu de données et limites.
- `docs/RELEASE_CHECKLIST.md` : critères de distribution Windows/Linux, sécurité, signatures et conformité.
- `docs/KNOWN_LIMITATIONS.md` : ce qui n'est pas compris, simulé, implémenté ou vérifié.
- `docs/DEV_SETUP.md` : prérequis, installation, exécution, tests et builds.
- `CHANGELOG.md` : modifications significatives et compatibilité.

Relie exigences → modules → tests → statut. Ne remplace jamais l'avancement vérifiable par un pourcentage inventé.

## 9. TESTS ET DEFINITION OF DONE

Un module est `VERIFIED` seulement si :

1. Son interface est réellement utilisable et connectée à une implémentation non factice.
2. Les scénarios nominaux et les échecs attendus ont des tests pertinents.
3. Les opérations destructives sont sûres, explicites et réversibles lorsque possible.
4. Les commandes de lint, typecheck et build concernées passent dans l'environnement disponible.
5. Les scripts générés ont été validés par analyse ; leur compatibilité à l'exécution serveur n'est revendiquée que si elle a été effectivement testée.
6. Les ressources non reconnues et les erreurs de parsing n'entraînent pas de corruption silencieuse.
7. Les différences rAthena/Hercules sont testées sur les profils réellement supportés.
8. La documentation utilisateur et développeur est cohérente avec l'état du code.
9. Les contrôles de sécurité, consentement cloud et secrets sont vérifiés si le module y touche.
10. Les limitations sont inscrites sans embellissement.

Prévois des golden tests sur scripts réels, tests de non-régression pour sauvegarde et round-trip, tests de charge et corpus volumineux, tests multiplateformes, tests d'intégration serveur avec environnement isolé et E2E des parcours débutants/expert. Si une machine Windows n'est pas disponible, prépare la CI Windows et marque les tests non exécutés comme tels, pas comme réussis.

**Scénarios de réception finaux** :

- Un novice génère un Warp NPC avec coût, niveau minimal et confirmation, l'inspecte, le valide puis l'exporte dans un projet rAthena.
- Le même parcours fonctionne sur un profil Hercules approprié, avec différences de comportement expliquées lorsqu'elles existent.
- Un utilisateur importe un NPC complexe existant, le modifie dans Monaco et le sauvegarde sans perte de commentaires, encodage ni instructions inconnues.
- Un NPC compatible s'affiche en graphe, une condition est modifiée visuellement et un diff exact et acceptable est proposé.
- Une portion non convertible reste dans `Raw Script` ou en code, sans destruction du script original.
- L'utilisateur retrouve une constante ou un item dans les bases d'un serveur personnalisé et bénéficie de la complétion.
- Un projet est exporté localement, puis un déploiement SFTP est simulé en dry-run ; le transfert réel exige validation explicite et possède une sauvegarde.
- L'IA locale configurée propose une correction, analysée et montrée en diff, sans modifier le fichier avant approbation.
- Un service IA cloud n'est contacté que lorsqu'il est explicitement choisi et autorisé.
- La simulation démontre les flux pris en charge et annonce ses limites ; un vrai serveur de test reste le seul arbitre de l'exécution réelle.
- L'application est construite et testée sur Windows et Linux, avec installateurs vérifiés, sous réserve des éléments externes de signature et de licence identifiés.

## 10. DROITS, SÉCURITÉ ET LIMITES RÉELLES

RuneForge est un produit **non officiel**. Ne fais aucune affirmation d'affiliation à Gravity ni n'utilise de marque/logo/ressource propriétaire d'une façon susceptible de créer une confusion ou d'enfreindre les droits. Vérifie les licences de tous les composants, de la documentation et des exemples avant inclusion dans un produit propriétaire. Évite l'incorporation de code rAthena/Hercules GPL dans le code propriétaire sans revue juridique. Les scripts tests doivent être originaux ou réutilisables sous licence compatible.

L'éditeur ne doit pas envoyer de scripts, de statistiques d'usage ou d'informations serveur à des services cloud par défaut. Protège les secrets, valide les clés SSH, limite les permissions Tauri, surveille les injections dans les commandes externes et ne donne pas à l'IA de capacité d'exécution shell distante par défaut.

Garde les capacités bloquées par des tierces parties clairement distinguées des fonctionnalités réellement livrées : connectivité à un serveur réel, infrastructure de paiement, compte de signature Windows, approbations de marques et ressources graphiques légalement obtenues.

## 11. RAPPORT APRÈS CHAQUE TRANCHE

À la fin de chaque tranche, réponds en français avec :

```text
Jalon / tranche :
État : NOT_STARTED | IN_PROGRESS | VERIFIED | BLOCKED

Réalisations concrètes :
- ...

Fichiers créés/modifiés :
- ...

Tests réellement exécutés :
- commande → résultat

Fonctionnalités démontrables :
- ...

Limites et dépendances :
- ...

Prochaine tranche :
- ...
```

Ne remplace pas l'implémentation par ce rapport ; celui-ci doit simplement clôturer une véritable tranche de travail. Si des tâches supplémentaires peuvent être réalisées dans la session, **enchaîne-les avant de terminer**.

## 12. DÉMARRAGE IMMÉDIAT

Exécute maintenant, dans cet ordre :

1. Analyse le dépôt, les fichiers de référence et `CLAUDE.md`.
2. Identifie le dernier jalon réellement vérifié, sans faire confiance aveuglément aux statuts historiques.
3. Vérifie que les outils nécessaires à la compilation et aux tests sont installés.
4. Crée ou mets à jour le suivi d'état et la matrice de tests.
5. **Commence immédiatement à coder et tester la prochaine tranche du premier jalon incomplet.**
6. Une fois le jalon vérifié, continue au suivant, jusqu'à M9 dans la mesure des sessions disponibles.
7. Ne demande pas « veux-tu que je continue ? » à chaque jalon ; le mandat de réalisation complète est déjà donné. Demande confirmation uniquement quand une décision ou une action possède des conséquences irréversibles, juridiques, financières, destructives ou implique un service externe.

**Critère de réussite ultime :** une personne peut installer RuneForge Studio sur Windows ou Linux, éditer et générer des scripts Ragnarok pour rAthena/Hercules, utiliser le constructeur visuel sur les cas supportés, simuler les interactions couvertes, exploiter l'IA facultative, gérer des projets et réaliser des déploiements contrôlés. Les fonctions réellement démontrées sont testées, documentées et distinguées explicitement des limitations et dépendances externes.

**Tu n'as pas pour mission de décrire cette application : tu as pour mission de la construire progressivement, complètement et correctement. Commence.**
