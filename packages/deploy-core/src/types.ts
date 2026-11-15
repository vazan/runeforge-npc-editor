/**
 * Deploiement de scripts (RF-018, CLAUDE.md 14.3) : copier des fichiers du projet vers une destination.
 *
 *   fichiers locaux + etat de la destination + dernier deploiement connu → plan (dry-run) → confirmation explicite
 *     → sauvegarde de ce qui sera remplace → ecriture verifiee → rapport → restauration possible
 *
 * « Deployer » ne veut dire que **copier**. Ajouter un script aux fichiers de chargement du serveur (`scripts_*.conf`) et recharger le
 * serveur sont deux autres operations, que ce module ne fait jamais (CLAUDE.md 14.3 : « ce sont des operations differentes »).
 */

/** Une destination est marquee : la production est affichee comme telle et demande une confirmation plus appuyee. */
export type Environment = "development" | "staging" | "production";

/** Un fichier tel que le plan le voit : son contenu n'y figure pas, seulement son empreinte. */
export interface FileEntry {
  /** Chemin relatif, avec des `/`, identique cote projet et cote destination. */
  readonly path: string;
  readonly size: number;
  /** SHA-256 du contenu, en hexadecimal minuscule. */
  readonly sha256: string;
}

export type ActionKind =
  /** Le fichier n'existe pas a la destination. */
  | "create"
  /** Il existe, differe, et il est exactement tel que le dernier deploiement l'a laisse : on peut le remplacer sans rien perdre d'autrui. */
  | "update"
  /** Identique des deux cotes : rien a transferer. */
  | "unchanged"
  /** Il existe, differe, et la destination a change depuis le dernier deploiement (ou n'a jamais recu ce fichier de nous) : jamais ecrase sans decision. */
  | "conflict";

export type ConflictReason =
  /** Le fichier de la destination n'est plus celui que le dernier deploiement y a laisse (modifie ailleurs). */
  | "remote-changed"
  /** Aucun deploiement n'a encore envoye ce fichier : on ne sait pas d'ou vient celui de la destination. */
  | "never-deployed";

export interface PlanAction {
  readonly kind: ActionKind;
  readonly path: string;
  /** Taille du fichier local. */
  readonly size: number;
  /** Empreinte du fichier local. */
  readonly sha256: string;
  /** Etat de la destination au moment du plan (`null` : absent). */
  readonly remote: FileEntry | null;
  /** Pourquoi c'est un conflit (seulement pour `conflict`). */
  readonly reason?: ConflictReason;
}

export interface DeployPlan {
  /** Une action par fichier local, rangees par chemin. */
  readonly actions: readonly PlanAction[];
  readonly counts: Readonly<Record<ActionKind, number>>;
  /** Octets que le deploiement enverrait (creations et mises a jour ; les conflits seulement si on les ecrase). */
  readonly bytes: number;
}
