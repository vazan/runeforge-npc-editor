/** Arbre de fichiers de l'explorateur, construit a partir d'un parcours de projet (entrees `/`-separees). */

export interface ScanEntryLike {
  readonly path: string;
  readonly kind: "file" | "directory";
  readonly size?: number;
  readonly modifiedMs?: number;
}

export interface TreeNode {
  readonly name: string;
  /** Chemin relatif a la racine (`""` pour la racine). */
  readonly path: string;
  readonly kind: "file" | "directory";
  readonly size: number;
  readonly children: TreeNode[];
}

export interface FlatRow {
  readonly node: TreeNode;
  readonly depth: number;
  readonly expanded: boolean;
}

const collator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

function compareNodes(a: TreeNode, b: TreeNode): number {
  if (a.kind !== b.kind) return a.kind === "directory" ? -1 : 1;
  return collator.compare(a.name, b.name) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
}

/** Construit l'arbre : dossiers d'abord, puis fichiers, tri naturel insensible a la casse. Les parents manquants sont crees. */
export function buildTree(entries: readonly ScanEntryLike[]): TreeNode {
  const root: TreeNode = { name: "", path: "", kind: "directory", size: 0, children: [] };
  const directories = new Map<string, TreeNode>([["", root]]);

  const ensureDirectory = (path: string): TreeNode => {
    const existing = directories.get(path);
    if (existing !== undefined) return existing;
    const slash = path.lastIndexOf("/");
    const parent = ensureDirectory(slash === -1 ? "" : path.slice(0, slash));
    const node: TreeNode = { name: path.slice(slash + 1), path, kind: "directory", size: 0, children: [] };
    parent.children.push(node);
    directories.set(path, node);
    return node;
  };

  for (const entry of entries) {
    if (entry.path === "") continue;
    if (entry.kind === "directory") {
      ensureDirectory(entry.path);
      continue;
    }
    const slash = entry.path.lastIndexOf("/");
    const parent = ensureDirectory(slash === -1 ? "" : entry.path.slice(0, slash));
    parent.children.push({ name: entry.path.slice(slash + 1), path: entry.path, kind: "file", size: entry.size ?? 0, children: [] });
  }

  const sortAll = (node: TreeNode): void => {
    node.children.sort(compareNodes);
    for (const child of node.children) if (child.kind === "directory") sortAll(child);
  };
  sortAll(root);
  return root;
}

/**
 * Lignes visibles (ordre d'affichage) pour un ensemble de dossiers deplies. Avec `filter`, seuls les noeuds dont le
 * nom correspond (ou dont un descendant correspond) sont affiches, et leurs parents sont consideres comme deplies.
 */
export function flattenVisible(root: TreeNode, expanded: ReadonlySet<string>, filter?: string): FlatRow[] {
  const needle = filter?.trim().toLowerCase() ?? "";
  const rows: FlatRow[] = [];

  const matches = (node: TreeNode): boolean => {
    if (needle === "") return true;
    if (node.name.toLowerCase().includes(needle)) return true;
    return node.kind === "directory" && node.children.some(matches);
  };

  const visit = (node: TreeNode, depth: number): void => {
    for (const child of node.children) {
      if (!matches(child)) continue;
      const isOpen = child.kind === "directory" && (needle !== "" || expanded.has(child.path));
      rows.push({ node: child, depth, expanded: isOpen });
      if (isOpen) visit(child, depth + 1);
    }
  };
  visit(root, 0);
  return rows;
}

/** Chemins des dossiers parents d'un fichier (utile pour deplier l'arbre jusqu'a un fichier ouvert). */
export function ancestorDirectories(path: string): string[] {
  const parts = path.split("/");
  parts.pop();
  const result: string[] = [];
  let current = "";
  for (const part of parts) {
    current = current === "" ? part : `${current}/${part}`;
    result.push(current);
  }
  return result;
}
