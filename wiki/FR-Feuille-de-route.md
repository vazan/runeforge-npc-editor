# Feuille de route

*🇬🇧 [English version](EN-Roadmap)*

Le projet se construit par **tranches verticales** (code + tests + documentation), dans un ordre fixe **M0 → M9**. Aucune durée n'est estimée, volontairement. Le registre vivant et prouvé est [`docs/STATUS.md`](https://github.com/vazan/runeforge-npc-editor/blob/HEAD/docs/STATUS.md) ; le plan exécutable est [`docs/ROADMAP.md`](https://github.com/vazan/runeforge-npc-editor/blob/HEAD/docs/ROADMAP.md). État au **2026-11-15** :

| Jalon | Thème | État | Ce qui reste |
|---|---|---|---|
| **M0** | Fondations : monorepo, application Tauri, lexer/analyseur mesurés sur de vrais scripts | ✅ Vérifié | Exécuter le CI sur des runners GitHub |
| **M1** | IDE de bureau : explorateur, onglets, Monaco, enregistrement sûr, récupération, FR/EN, thèmes | ✅ Vérifié (Windows) | Bout en bout sous Linux ; changer l'encodage depuis la barre d'état |
| **M2** | Moteur de langage : portées, références, index du projet, diagnostics sémantiques | ✅ Vérifié (Windows) | Hercules non vérifié |
| **M3** | IntelliSense : navigation, complétion, survol, aide de signature, renommage sûr, commandes, modèles | ✅ Vérifié (Windows, rAthena) | Hercules ; complétion des arguments d'autres natures |
| **M4** | Émulateurs et bases : adaptateur rAthena, objets/monstres/cartes/constantes, rapport de projet, règles de cartes et d'ordre de chargement | 🔶 En cours (M4-S1 à S3d vérifiés) | Adaptateur Hercules ; `RC0001`–`RC0003` (compatibilité entre profils) ; autres natures d'arguments (compétences, quêtes, groupes d'objets) |
| **M5** | Version V1 : budget de démarrage, audit d'accessibilité, documentation, journal de diagnostic, mises à jour signées (Windows + Linux) | 🔶 En cours | Clé de signature de production et première vraie release ; installateur ; signature de code ; fenêtre et paquets Linux ; essai au lecteur d'écran ; audits de dépendances |
| **M6** | Assistants et serveur : assistants, Git en lecture seule, déploiement local | 🔶 En cours | Assistants supplémentaires (buffer, quête) ; transfert SFTP et validation sur un serveur de test |
| **M7** | Studio visuel : blocs de dialogue, constructeur en nœuds, extensions JSON | 🔶 En cours | Relire un script existant en graphe modifiable ; `select`/`menu` à plusieurs sorties, `goto`, boucles ; annuler/rétablir dans le dialogue |
| **M8** | Simulation et IA | 🔶 En cours | Déclenchement des événements (`OnTimer`, `OnTouch`, `donpcevent`) ; vérification avec de vrais fournisseurs d'IA ; revue indépendante de la surface réseau |
| **M9** | Studio avancé | 🔶 En cours | Extensions persistantes et gestion des permissions ; serveur de test réellement isolé ; audit des dépendances |

## Livré récemment

- Un simulateur de dialogues qui **ne s'arrête jamais sur une erreur**, exécute les fonctions d'autres fichiers du projet et choisit la classe du personnage de test par son nom.
- Un constructeur de NPC en graphe de nœuds.
- Des mises à jour signées dans l'application depuis les releases GitHub, pour Windows et Linux.
- La vérification de l'ordre de chargement des fonctions (`RA0016`), du chargement des cartes (`RA0015`) et des labels réservés (`RA0014`).
- Un chemin de construction Linux (`pnpm build:linux`) avec un AppImage.

## Ce qui aiderait le plus

- **Tester sur un poste Linux** et dire ce que la fenêtre fait réellement.
- **Une installation Hercules** pour débloquer un adaptateur.
- **Des forks rAthena réels** : fausses alertes et problèmes manqués (utilisez le modèle de ticket *Diagnostic report*).
- Une revue de l'interface **au lecteur d'écran**.
- Des relectures de traduction et de formulation pour les deux langues d'interface.

Voir [Développement](FR-Developpement) pour commencer.
