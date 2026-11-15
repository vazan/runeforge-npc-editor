import type { ActionKind, ConflictReason, DeployPlan, FileEntry, PlanAction } from "./types";

export interface PlanInput {
  /** Les fichiers a deployer (cote projet). */
  readonly local: readonly FileEntry[];
  /** L'etat de la destination pour ces chemins (un chemin absent de la table n'existe pas a la destination). */
  readonly remote: ReadonlyMap<string, FileEntry>;
  /** Empreinte de chaque fichier tel que le dernier deploiement l'a laisse a la destination (vide : jamais deploye). */
  readonly baseline: ReadonlyMap<string, string>;
}

function classify(local: FileEntry, remote: FileEntry | undefined, baseline: string | undefined): { kind: ActionKind; reason?: ConflictReason } {
  if (remote === undefined) return { kind: "create" };
  if (remote.sha256 === local.sha256) return { kind: "unchanged" };
  if (baseline === undefined) return { kind: "conflict", reason: "never-deployed" };
  // La destination est exactement ce que nous y avons laisse : remplacer ne detruit le travail de personne.
  return baseline === remote.sha256 ? { kind: "update" } : { kind: "conflict", reason: "remote-changed" };
}

/**
 * Le plan d'un deploiement, sans aucun effet (dry-run) : ce que chaque fichier deviendrait. Un fichier different a la destination n'est une
 * simple mise a jour que si la destination est restee telle que le dernier deploiement l'a laissee ; sinon c'est un conflit, que seule une
 * decision explicite de l'utilisateur ecrase.
 */
export function planDeploy(input: PlanInput): DeployPlan {
  // Un chemin n'apparait qu'une fois (le dernier l'emporte) : le plan est une action par fichier.
  const unique = new Map<string, FileEntry>();
  for (const entry of input.local) unique.set(entry.path, entry);
  const actions: PlanAction[] = [...unique.values()]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((local) => {
      const remote = input.remote.get(local.path);
      const { kind, reason } = classify(local, remote, input.baseline.get(local.path));
      const action = { kind, path: local.path, size: local.size, sha256: local.sha256, remote: remote ?? null };
      return reason === undefined ? action : { ...action, reason };
    });
  const counts: Record<ActionKind, number> = { create: 0, update: 0, unchanged: 0, conflict: 0 };
  let bytes = 0;
  for (const action of actions) {
    counts[action.kind] += 1;
    if (action.kind === "create" || action.kind === "update") bytes += action.size;
  }
  return { actions, counts, bytes };
}

/** Octets qu'enverrait le plan si l'utilisateur decide d'ecraser aussi les conflits. */
export function bytesWithConflicts(plan: DeployPlan): number {
  return plan.actions.reduce((total, action) => (action.kind === "unchanged" ? total : total + action.size), 0);
}

/**
 * Les fichiers qui seraient envoyes mais ont des erreurs d'analyse locale (`errorsByPath` : nombre d'erreurs par chemin) : le deploiement
 * les refuse tant que l'utilisateur ne l'a pas decide en connaissance de cause.
 */
export function findBlockers(plan: DeployPlan, errorsByPath: ReadonlyMap<string, number>, overwriteConflicts: boolean): string[] {
  return plan.actions
    .filter((action) => action.kind === "create" || action.kind === "update" || (action.kind === "conflict" && overwriteConflicts))
    .filter((action) => (errorsByPath.get(action.path) ?? 0) > 0)
    .map((action) => action.path);
}
