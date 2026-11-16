# Mises à jour

*🇬🇧 [English version](EN-Updates)*

RuneForge peut se mettre à jour depuis les **releases d'un dépôt GitHub** — mais seulement quand vous le demandez, et seulement avec une version signée par l'éditeur.

> **État actuel :** le mécanisme est implémenté et testé contre un faux serveur GitHub local, mais **aucune clé de signature n'existe et aucune vraie release n'a encore été publiée**. Tant que le mainteneur n'a pas créé la clé et publié une première release, l'application répond « cette version ne peut pas vérifier les mises à jour » (`not_configured`). Voir [Publier une release](#pour-les-mainteneurs--publier-une-release).

## Pour les utilisateurs : mettre à jour

**Aide › Mises à jour…** (ou **Paramètres › Mises à jour**).

**Rien n'est contacté avant que vous appuyiez sur « Rechercher des mises à jour »** : l'application ne vérifie rien au démarrage et ne se met jamais à jour seule.

1. **Dépôt** — `propriétaire/nom` du dépôt qui publie les versions. Seul GitHub est contacté.
2. **Canal** — « Versions stables seulement » (par défaut) ou « Versions stables et bêta ».
3. **Jeton d'accès** — seulement si le dépôt est **privé**. Sur GitHub, créez un *jeton à granularité fine* limité à **ce dépôt**, avec **Contents : Read-only** et une date d'expiration. Il reste en mémoire jusqu'à la fermeture de l'application, n'est jamais enregistré et n'est envoyé qu'à GitHub. Notez qu'un tel jeton permet aussi de lire le code source du dépôt.
4. **Rechercher des mises à jour** — si une version plus récente existe, vous voyez sa version, sa date, sa taille et ses notes (du texte brut).
5. **Installer et redémarrer** — enregistrez d'abord votre travail (l'application redémarre). Une boîte de dialogue du système vous demande de confirmer ; puis l'exécutable est téléchargé (barre de progression), son empreinte vérifiée, l'exécutable en cours remplacé, et l'application redémarre. L'installation est **refusée tant que vous avez des modifications non enregistrées**.

### Pourquoi c'est sûr

GitHub et le réseau sont traités comme des transports non fiables. L'éditeur **signe un manifeste** avec une clé privée ; l'application embarque la clé publique correspondante et n'installe **que ce que cette signature garantit** — y compris la taille et le SHA-256 de l'exécutable. Une release falsifiée, un dépôt détourné ou un homme du milieu peuvent bloquer une mise à jour, jamais en imposer une. Seule une version strictement plus récente est proposée (jamais un retour en arrière), et un manifeste signé doit s'accorder avec l'étiquette et le canal de la release.

### En cas d'échec

Un échec laisse l'ancienne version en place.

| Système | Comportement |
|---|---|
| **Windows** | Exécutable remplacé par renommages dans le dossier de l'application, avec retour arrière. Si le message dit que l'ancienne version n'a pas pu être remise en place, renommez `runeforge-studio.exe.old` en `runeforge-studio.exe` |
| **Linux** | Un seul `rename` atomique. L'ancienne version reste sous le nom `runeforge-studio.old` jusqu'au prochain lancement réussi ; retour arrière à la main avec `mv runeforge-studio.old runeforge-studio` |

Le dossier de l'application doit être **modifiable par vous** : un exécutable sous `C:\Program Files`, ou installé par un gestionnaire de paquets dans `/usr/bin`, ne peut pas se mettre à jour seul (`not_writable`). Sur tout autre système, le bouton explique que l'installation n'est pas disponible.

## Limites

- **Windows et Linux (x86_64) seulement.** Ni macOS, ni binaire ARM.
- Jamais automatique ; pas de mise à jour différentielle ; pas de reprise d'un téléchargement interrompu.
- **Non vérifiés** : le vrai TLS vers `api.github.com`, les redirections de téléchargement d'un dépôt privé, les limites de débit, le comportement des antivirus ; la mise à jour dans la fenêtre sous Linux.
- Pas de signature de code Windows : SmartScreen peut avertir au premier lancement d'un exécutable téléchargé à la main.
- Changer ou perdre la clé de signature coupe les mises à jour de tous les exemplaires déjà distribués.

## Pour les mainteneurs : publier une release

La procédure complète est dans [`docs/RELEASE.md`](https://github.com/vazan/runeforge-npc-editor/blob/HEAD/docs/RELEASE.md). En résumé :

```bash
# une fois — crée la paire de clés HORS du dépôt et copie la clé publique
pnpm release:keygen --out <chemin-hors-du-depot>/runeforge-update.key

# à chaque release : changer la version dans apps/desktop/src-tauri/tauri.conf.json, mettre à jour CHANGELOG.md, puis
pnpm check:all
pnpm --filter @runeforge/desktop tauri build --no-bundle      # sur chaque système livré
pnpm release:prepare --version X.Y.Z --notes notes.txt \
    --artifact windows-x86_64=<exe> --artifact linux-x86_64=<elf>
pnpm release:publish --repo proprietaire/depot --dir release-out/X.Y.Z        # aperçu seulement
pnpm release:publish --repo proprietaire/depot --dir release-out/X.Y.Z --yes  # crée une release BROUILLON
```

Points clés :

- **Un seul manifeste signé décrit toutes les plateformes** d'une release.
- `release:prepare` refuse une mauvaise version, un exécutable qui embarque la clé de test ou n'a pas la clé de production, un en-tête d'exécutable d'un autre système, ou un dossier de sortie non vide.
- La clé privée est le secret le plus sensible du produit : sauvegardez-la avec son mot de passe en deux lieux sûrs et **ne la commitez jamais** (`*.key` est ignoré par Git, sauf les *clés de test* publiques des fixtures).
- Relisez le brouillon sur GitHub et **publiez-le** — un brouillon est invisible pour l'application.
- Avant de vous y fier, publiez une **release de test** et vérifiez toute la boucle contre le vrai GitHub.
