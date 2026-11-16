# Licence

*🇬🇧 [English version](EN-License)*

> Cette page résume la situation de licence du projet. C'est un **inventaire, pas un avis juridique**. Aucune revue juridique indépendante avant une distribution ou une vente n'a eu lieu. Détails : [`docs/LEGAL.md`](https://github.com/vazan/runeforge-npc-editor/blob/HEAD/docs/LEGAL.md).

## Le produit

RuneForge Studio est placé sous la **licence publique générale GNU, version 3 uniquement (GPL-3.0-only)**. Le texte complet est dans [`LICENSE`](https://github.com/vazan/runeforge-npc-editor/blob/HEAD/LICENSE) ; les manifestes pnpm et Cargo déclarent la même licence.

Le choix de la GPL-3.0-only est une décision d'implémentation qui permet au projet d'intégrer du contenu dérivé de rAthena (ci-dessous). Ce n'est pas une certification de compatibilité.

## Contenu dérivé de rAthena

- La **bibliothèque de commandes hors ligne intégrée** contient les signatures et le texte d'aide de `script_commands.txt` de rAthena (attribué à l'équipe rAthena Dev Team), générée depuis un checkout local de rAthena et distribuée sous GPL-3.0-only avec ses références de provenance.
- La table des **valeurs de constantes de script** et les **noms de classes** sont générés depuis des sources rAthena (`script_constants.hpp`, `pc.cpp`, `map_msg.conf`). Ils contiennent des noms et des nombres, aucune ligne de code serveur, et sont distribués sous GPL-3.0-only.
- **Aucun code serveur ni base de données rAthena n'est embarqué.** Les fichiers de votre serveur sont lus à l'exécution dans *votre* projet. La révision du checkout qui a servi à générer la bibliothèque est inconnue.
- Les fixtures de test sont rédigées pour ce projet (texte original, même organisation de fichiers que l'émulateur).

## Dépendances

Un inventaire hors ligne (`pnpm exec tsx scripts/licenses-report.ts`) classe chaque dépendance selon son expression SPDX. Au 2026-11-15 :

- **Aucune dépendance GPL, AGPL ni LGPL** et aucune licence inconnue parmi les composants livrés.
- Cinq crates Rust sous **MPL-2.0** (copyleft au niveau du fichier) sont liées par la pile Tauri — utilisées sans modification ; leurs avis et l'emplacement de leurs sources doivent être conservés.
- Tout le reste est permissif (MIT, Apache-2.0, BSD, Zlib, Unicode…).

Listes complètes : [`THIRD_PARTY_LICENSES.md`](https://github.com/vazan/runeforge-npc-editor/blob/HEAD/docs/THIRD_PARTY_LICENSES.md) (Windows) et [`THIRD_PARTY_LICENSES_LINUX.md`](https://github.com/vazan/runeforge-npc-editor/blob/HEAD/docs/THIRD_PARTY_LICENSES_LINUX.md).

Points ouverts avant distribution : un paquet complet de notices tierces avec les textes de licence ; confirmer la licence de la police d'icônes de Monaco (`codicon.ttf`) et livrer le `ThirdPartyNotices.txt` de Monaco ; examiner les bibliothèques LGPL redistribuées dans un AppImage (WebKitGTK, GTK, libsoup).

## Marques et affiliation

- RuneForge Studio est un **outil non officiel, sans lien avec Gravity**. « Ragnarok Online » et « Gravity » appartiennent à leurs titulaires respectifs. La mention figure sur l'écran d'accueil et dans *À propos*.
- **Aucune ressource de Ragnarok Online** (sprites, cartes, musiques, marque) n'est incluse. L'icône actuelle est un placeholder original.
- **« RuneForge Studio » est un nom de travail** ; une recherche d'antériorité et de marque n'a pas été faite.

## Contribuer

Le projet est en GPL-3.0-only : le code et les données contribués doivent donc être compatibles avec cette licence. Ne contribuez pas de matériel que vous n'avez pas le droit de placer sous cette licence, et ne collez pas de contenu propriétaire ou privé de serveur dans les tickets ou les fixtures de test.
