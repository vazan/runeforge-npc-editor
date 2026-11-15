import type { MessageKey } from "../i18n/messages";
import type { GitStatus } from "../services/types";
import type { GitUnavailable } from "../state/store";

/**
 * Lecture des deux lettres de Git par fichier (`x` : l'index, ce qui sera valide ; `y` : le dossier de travail) et textes de l'onglet Git.
 * Partie pure : l'interface n'y met que de l'affichage.
 */

export type GitKind = "conflict" | "untracked" | "deleted" | "added" | "renamed" | "typechange" | "modified";

/** La nature d'un fichier modifie : un conflit passe avant tout, puis non suivi, supprime, ajoute, renomme, type change, et sinon modifie. */
export function gitKind(entry: { readonly x: string; readonly y: string }): GitKind {
  const { x, y } = entry;
  if (x === "U" || y === "U") return "conflict";
  if (x === "?") return "untracked";
  if (x === "D" || y === "D") return "deleted";
  if (x === "A") return "added";
  if (x === "R" || x === "C") return "renamed";
  if (x === "T" || y === "T") return "typechange";
  return "modified";
}

export const GIT_LETTER: Readonly<Record<GitKind, string>> = {
  modified: "M",
  added: "A",
  deleted: "D",
  untracked: "?",
  conflict: "U",
  typechange: "T",
  renamed: "R",
};

export const GIT_KIND_MESSAGE: Readonly<Record<GitKind, MessageKey>> = {
  modified: "git.kind.modified",
  added: "git.kind.added",
  deleted: "git.kind.deleted",
  untracked: "git.kind.untracked",
  conflict: "git.kind.conflict",
  typechange: "git.kind.typechange",
  renamed: "git.kind.renamed",
};

export const GIT_UNAVAILABLE_MESSAGE: Readonly<Record<GitUnavailable, MessageKey>> = {
  not_trusted: "git.unavailable.not_trusted",
  git_unavailable: "git.unavailable.git_unavailable",
  not_a_repository: "git.unavailable.not_a_repository",
  unsafe_repository: "git.unavailable.unsafe_repository",
  timeout: "git.unavailable.timeout",
  too_large: "git.unavailable.too_large",
  failed: "git.unavailable.failed",
};

/** Une partie de la modification est deja dans l'index (sera validee au prochain commit). */
export const isStaged = (entry: { readonly x: string }): boolean => entry.x !== "." && entry.x !== "?" && entry.x !== "U";

/** Le fichier existe dans le dossier de travail (on peut l'ouvrir et le comparer). */
export const isOnDisk = (entry: { readonly x: string; readonly y: string }): boolean => gitKind(entry) !== "deleted";

/** Ce qui se dit de la branche : son nom, « sans commit », ou le commit d'un `HEAD` detache. */
export function branchSummary(status: GitStatus): { readonly key: "git.branch" | "git.branchUnborn" | "git.detached"; readonly params: Readonly<Record<string, string>> } {
  if (status.detached) return { key: "git.detached", params: { head: status.head ?? "?" } };
  const branch = status.branch ?? "?";
  return { key: status.unborn ? "git.branchUnborn" : "git.branch", params: { branch } };
}

/** Le nom court affiche dans la barre d'etat : la branche, ou le debut du commit en `HEAD` detache. */
export const shortBranch = (status: GitStatus): string => (status.detached ? (status.head ?? "?") : (status.branch ?? "?"));
