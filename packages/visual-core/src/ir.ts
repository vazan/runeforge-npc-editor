import type { SourceRange } from "@runeforge/runescript-core";

/**
 * Representation intermediaire d'un NPC pour l'edition visuelle (CLAUDE.md 11) : le corps d'un `script` lu en **blocs**.
 *
 * Le contrat n'est pas « tout convertir » mais « ne jamais rien perdre » : ce qui n'a pas de bloc (labels, `select`, boucles, appels de
 * fonction, expressions...) devient un bloc **brut** qui garde son texte source tel quel, verrouille, et chaque bloc connait sa plage dans le
 * texte. Une modification est donc une liste de remplacements de plages — jamais une regeneration du fichier.
 */

interface BlockBase {
  /** Chemin du bloc dans l'arbre : `2` (troisieme du corps), `1.t.0` (premier du « alors » du deuxieme), `1.e.0` (du « sinon »). */
  readonly id: string;
  /** Plage de l'instruction entiere dans le texte (`mes "a";`, ou `if (...) { ... }`). */
  readonly range: SourceRange;
}

/** `mes "texte";` — un seul argument, une chaine sans caractere de controle. */
export interface MesBlock extends BlockBase {
  readonly kind: "mes";
  readonly text: string;
  /** Plage du litteral de chaine, guillemets compris : la seule partie que l'edition remplace. */
  readonly textRange: SourceRange;
}

export interface NextBlock extends BlockBase {
  readonly kind: "next";
}

export interface CloseBlock extends BlockBase {
  readonly kind: "close";
}

/** `if (condition) { ... } else { ... }` dont les deux branches sont entre accolades. */
export interface IfBlock extends BlockBase {
  readonly kind: "if";
  /** Texte de la condition, sans les parentheses. */
  readonly condition: string;
  readonly conditionRange: SourceRange;
  /** Plages des branches, accolades comprises. */
  readonly thenRange: SourceRange;
  readonly elseRange: SourceRange | null;
  readonly then: readonly VisualBlock[];
  /** `null` : pas de « sinon ». */
  readonly else: readonly VisualBlock[] | null;
}

/** Tout le reste, verbatim : jamais modifie, deplace ni supprime par l'edition visuelle. */
export interface RawBlock extends BlockBase {
  readonly kind: "raw";
  readonly text: string;
}

export type VisualBlock = MesBlock | NextBlock | CloseBlock | IfBlock | RawBlock;

/** Tout est en blocs / une partie est brute / rien n'est en blocs (CLAUDE.md 11.4). */
export type ConversionStatus = "full" | "partial" | "unsupported";

export interface VisualNpc {
  /** Nom d'affichage du NPC. */
  readonly name: string;
  /** Debut de la declaration dans le texte : sert a retrouver le meme NPC apres une modification de son corps. */
  readonly declarationStart: number;
  readonly bodyRange: SourceRange;
  readonly blocks: readonly VisualBlock[];
  readonly status: ConversionStatus;
  /** Blocs convertis et blocs bruts, imbriques compris. */
  readonly counts: { readonly convertible: number; readonly raw: number };
}

/** Vrai si `text` contient un caractere de controle (code inferieur a 32) : saut de ligne, tabulation et le reste. */
export function hasControlCharacter(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) < 32) return true;
  }
  return false;
}

/** Toutes les listes de blocs d'un arbre, de la racine aux branches. */
export function walkBlocks(blocks: readonly VisualBlock[], visit: (block: VisualBlock, list: readonly VisualBlock[], index: number) => void): void {
  blocks.forEach((block, index) => {
    visit(block, blocks, index);
    if (block.kind === "if") {
      walkBlocks(block.then, visit);
      if (block.else !== null) walkBlocks(block.else, visit);
    }
  });
}

/** Le bloc d'identifiant `id`, avec la liste qui le contient et sa place dans cette liste. */
export function findBlock(blocks: readonly VisualBlock[], id: string): { block: VisualBlock; list: readonly VisualBlock[]; index: number } | null {
  let found: { block: VisualBlock; list: readonly VisualBlock[]; index: number } | null = null;
  walkBlocks(blocks, (block, list, index) => {
    if (block.id === id) found = { block, list, index };
  });
  return found;
}
