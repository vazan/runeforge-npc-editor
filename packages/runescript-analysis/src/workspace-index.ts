import { createDiagnostic } from "@runeforge/runescript-core";
import type { DiagnosticSeverity, ParseDiagnostic, RelatedLocation, SourceRange } from "@runeforge/runescript-core";
import { npcKey } from "./symbols";
import type { FileAnalysis, NpcType } from "./symbols";

/** Une definition de fonction globale (`function<TAB>script<TAB>Nom<TAB>{`) dans un fichier du projet. */
export interface IndexedFunction {
  readonly name: string;
  readonly uri: string;
  readonly nameRange: SourceRange;
  readonly range: SourceRange;
}

/** Un NPC (script, warp, boutique ou duplicate) declare dans un fichier du projet. */
export interface IndexedNpc {
  /** Nom unique tronque comme le fait le serveur : cle d'unicite, sensible a la casse. */
  readonly key: string;
  readonly uniqueName: string;
  readonly displayName: string;
  readonly npcType: NpcType;
  readonly uri: string;
  readonly nameRange: SourceRange;
  readonly range: SourceRange;
  readonly map: string | null;
}

/** Une reference (`callfunc "F"` ou `duplicate(N)`) a un symbole global, dans un fichier du projet. */
export interface IndexedReference {
  readonly uri: string;
  readonly range: SourceRange;
}

export interface CrossFileOptions {
  /**
   * Signaler les `callfunc` et `duplicate` dont la cible est introuvable dans l'index (RA0004, RA0013).
   * A activer seulement quand l'index couvre tous les fichiers charges par le serveur : dans un index partiel, presque
   * toutes les references seraient « non resolues ».
   */
  readonly reportUnresolved: boolean;
  /** Nombre maximal d'emplacements lies attaches a un diagnostic de doublon. */
  readonly maxRelated?: number;
}

export interface UnknownCommandOptions {
  /** Gravite des alertes `RA0001` (la politique `validation.unknownCommands` du projet ; `off` n'appelle pas la methode). */
  readonly severity: DiagnosticSeverity;
  /** Nom du profil d'emulateur pour le message (« rAthena »). */
  readonly profile: string;
}

const DEFAULT_MAX_RELATED = 5;

function sameEntry(a: { readonly uri: string; readonly nameRange: SourceRange }, uri: string, range: SourceRange): boolean {
  return a.uri === uri && a.nameRange.start === range.start && a.nameRange.end === range.end;
}

function related(
  entries: readonly { readonly uri: string; readonly nameRange: SourceRange }[],
  self: { readonly uri: string; readonly nameRange: SourceRange },
  max: number,
): RelatedLocation[] {
  const result: RelatedLocation[] = [];
  for (const entry of entries) {
    if (sameEntry(entry, self.uri, self.nameRange)) continue;
    result.push({ uri: entry.uri, range: entry.nameRange });
    if (result.length >= max) break;
  }
  return result;
}

/**
 * Index des symboles de plusieurs fichiers : fonctions globales et noms de NPC. Il tient a jour ses tables
 * de facon incrementale (un fichier modifie remplace uniquement ses propres entrees) et en deduit les diagnostics
 * qui exigent la vue d'ensemble du projet.
 *
 * Sensibilite a la casse : `callfunc` et `duplicate` cherchent leur cible par nom exact (les bases de donnees du serveur
 * sont des `strdb`, sensibles a la casse), contrairement aux labels d'un script.
 *
 * L'index ne connait l'ordre de chargement des fichiers (fichiers `scripts_*.conf`) que si on le lui donne (`setLoadOrder`) :
 * sans lui, pour un doublon il ne peut pas dire lequel le serveur gardera, il les signale donc tous, et il ne peut pas dire
 * qu'une fonction est appelee avant d'etre chargee (`RA0016`).
 */
export class WorkspaceIndex {
  private readonly files = new Map<string, FileAnalysis>();
  private readonly functions = new Map<string, IndexedFunction[]>();
  private readonly npcs = new Map<string, IndexedNpc[]>();
  private readonly functionRefs = new Map<string, IndexedReference[]>();
  private readonly npcRefs = new Map<string, IndexedReference[]>();
  /** Rang de chaque fichier dans l'ordre de chargement du serveur ; `null` : ordre inconnu. */
  private loadOrder: ReadonlyMap<string, number> | null = null;

  get fileCount(): number {
    return this.files.size;
  }

  has(uri: string): boolean {
    return this.files.has(uri);
  }

  getFile(uri: string): FileAnalysis | undefined {
    return this.files.get(uri);
  }

  uris(): string[] {
    return [...this.files.keys()];
  }

  /** Ajoute ou remplace l'analyse d'un fichier. */
  set(analysis: FileAnalysis): void {
    this.delete(analysis.uri);
    this.files.set(analysis.uri, analysis);
    for (const reference of analysis.functionReferences) {
      const entry: IndexedReference = { uri: analysis.uri, range: reference.range };
      const list = this.functionRefs.get(reference.name);
      if (list === undefined) this.functionRefs.set(reference.name, [entry]);
      else list.push(entry);
    }
    for (const declaration of analysis.declarations) {
      if (declaration.kind === "npc" && declaration.duplicateOf !== null) {
        const key = npcKey(declaration.duplicateOf.name);
        const entry: IndexedReference = { uri: analysis.uri, range: declaration.duplicateOf.range };
        const list = this.npcRefs.get(key);
        if (list === undefined) this.npcRefs.set(key, [entry]);
        else list.push(entry);
      }
      if (declaration.kind === "function") {
        const entry: IndexedFunction = {
          name: declaration.name,
          uri: analysis.uri,
          nameRange: declaration.nameRange,
          range: declaration.range,
        };
        const list = this.functions.get(declaration.name);
        if (list === undefined) this.functions.set(declaration.name, [entry]);
        else list.push(entry);
      } else {
        const key = npcKey(declaration.uniqueName);
        if (key === "") continue;
        const entry: IndexedNpc = {
          key,
          uniqueName: declaration.uniqueName,
          displayName: declaration.displayName,
          npcType: declaration.npcType,
          uri: analysis.uri,
          nameRange: declaration.nameRange,
          range: declaration.range,
          map: declaration.map,
        };
        const list = this.npcs.get(key);
        if (list === undefined) this.npcs.set(key, [entry]);
        else list.push(entry);
      }
    }
  }

  /** Retire un fichier de l'index. Retourne `false` s'il n'y etait pas. */
  delete(uri: string): boolean {
    const previous = this.files.get(uri);
    if (previous === undefined) return false;
    this.files.delete(uri);
    for (const reference of previous.functionReferences) this.removeFrom(this.functionRefs, reference.name, uri);
    for (const declaration of previous.declarations) {
      if (declaration.kind === "function") {
        this.removeFrom(this.functions, declaration.name, uri);
      } else {
        const key = npcKey(declaration.uniqueName);
        if (key !== "") this.removeFrom(this.npcs, key, uri);
        if (declaration.duplicateOf !== null) this.removeFrom(this.npcRefs, npcKey(declaration.duplicateOf.name), uri);
      }
    }
    return true;
  }

  clear(): void {
    this.files.clear();
    this.functions.clear();
    this.npcs.clear();
    this.functionRefs.clear();
    this.npcRefs.clear();
  }

  private removeFrom<T extends { readonly uri: string }>(map: Map<string, T[]>, key: string, uri: string): void {
    const list = map.get(key);
    if (list === undefined) return;
    const remaining = list.filter((entry) => entry.uri !== uri);
    if (remaining.length === 0) map.delete(key);
    else map.set(key, remaining);
  }

  /** Definitions d'une fonction globale (nom exact, sensible a la casse). */
  findFunctions(name: string): readonly IndexedFunction[] {
    return this.functions.get(name) ?? [];
  }

  /** NPC portant ce nom unique (nom exact, sensible a la casse, tronque comme sur le serveur). */
  findNpcs(uniqueName: string): readonly IndexedNpc[] {
    return this.npcs.get(npcKey(uniqueName)) ?? [];
  }

  /** Appels `callfunc "nom"` d'une fonction globale, dans tous les fichiers (nom exact). */
  findFunctionReferences(name: string): readonly IndexedReference[] {
    return this.functionRefs.get(name) ?? [];
  }

  /** Declarations `duplicate(nom)` qui pointent vers ce NPC. */
  findNpcReferences(uniqueName: string): readonly IndexedReference[] {
    return this.npcRefs.get(npcKey(uniqueName)) ?? [];
  }

  /** Parcourt toutes les fonctions globales indexees (ordre d'insertion). */
  forEachFunction(visit: (entry: IndexedFunction) => void): void {
    for (const list of this.functions.values()) for (const entry of list) visit(entry);
  }

  /** Parcourt tous les NPC indexes (ordre d'insertion). */
  forEachNpc(visit: (entry: IndexedNpc) => void): void {
    for (const list of this.npcs.values()) for (const entry of list) visit(entry);
  }

  functionNames(): string[] {
    return [...this.functions.keys()].sort();
  }

  npcNames(): string[] {
    return [...this.npcs.keys()].sort();
  }

  get functionCount(): number {
    return this.functions.size;
  }

  get npcCount(): number {
    return this.npcs.size;
  }

  /**
   * Diagnostics d'un fichier qui dependent des autres fichiers : fonctions en double (RA0011), noms uniques de NPC
   * en double (RA0005) et, si `reportUnresolved`, `callfunc` / `duplicate` sans cible (RA0004, RA0013).
   * Complementaires de `FileAnalysis.diagnostics`, jamais redondants avec eux.
   */
  crossFileDiagnostics(uri: string, options: CrossFileOptions): ParseDiagnostic[] {
    const analysis = this.files.get(uri);
    if (analysis === undefined) return [];
    const maxRelated = options.maxRelated ?? DEFAULT_MAX_RELATED;
    const diagnostics: ParseDiagnostic[] = [];

    for (const declaration of analysis.declarations) {
      if (declaration.kind === "function") {
        const definitions = this.functions.get(declaration.name);
        if (definitions !== undefined && definitions.length > 1) {
          diagnostics.push(
            createDiagnostic("RA0011", declaration.nameRange, { name: declaration.name }, {
              related: related(definitions, { uri, nameRange: declaration.nameRange }, maxRelated),
            }),
          );
        }
        continue;
      }
      const key = npcKey(declaration.uniqueName);
      if (key !== "") {
        const sameName = this.npcs.get(key);
        if (sameName !== undefined && sameName.length > 1) {
          diagnostics.push(
            createDiagnostic("RA0005", declaration.nameRange, { name: declaration.uniqueName }, {
              related: related(sameName, { uri, nameRange: declaration.nameRange }, maxRelated),
            }),
          );
        }
      }
      if (options.reportUnresolved && declaration.duplicateOf !== null) {
        const source = declaration.duplicateOf;
        if (this.findNpcs(source.name).length === 0) {
          diagnostics.push(createDiagnostic("RA0013", source.range, { name: source.name }));
        }
      }
    }

    if (options.reportUnresolved) {
      for (const reference of analysis.functionReferences) {
        if (!this.functions.has(reference.name)) {
          diagnostics.push(createDiagnostic("RA0004", reference.range, { name: reference.name }));
        }
      }
    }

    return diagnostics.sort((a, b) => a.range.start - b.range.start || a.range.end - b.range.end);
  }

  /**
   * Donne l'ordre dans lequel le serveur charge les fichiers (les plus tot charges d'abord) ; `null` : ordre inconnu. Un fichier
   * absent de la liste n'est pas charge par le serveur.
   */
  setLoadOrder(files: readonly string[] | null): void {
    if (files === null) {
      this.loadOrder = null;
      return;
    }
    // Un fichier cite plusieurs fois est analyse par le serveur des sa premiere occurrence : c'est ce rang qui compte.
    const ranks = new Map<string, number>();
    files.forEach((uri, rank) => {
      if (!ranks.has(uri)) ranks.set(uri, rank);
    });
    this.loadOrder = ranks;
  }

  /**
   * Appels par nom d'une fonction globale que le serveur ne connait pas encore a cet endroit (`RA0016`). `parse_callfunc`
   * (`script.cpp`) n'accepte `Nom arg;` ou `Nom(arg)` que si `Nom` est deja dans `userfunc_db`, rempli par `npc_parse_function`
   * **apres** l'analyse de la fonction, au fur et a mesure du chargement : une fonction definie dans un fichier charge plus tard, plus
   * bas dans le meme fichier, ou dans le corps de l'appelant lui-meme (recursion) n'existe pas encore, et le script ne se charge pas
   * (`callfunc "Nom"`, lui, est resolu a l'execution). Seuls les appels dont le nom est defini quelque part sont concernes : un
   * nom defini nulle part est une commande inconnue (`RA0001`).
   *
   * Sans ordre de chargement, ou pour un fichier que le serveur ne charge pas, rien n'est signale. Une definition situee dans un
   * fichier non charge ne compte pas : le serveur ne la connaitra jamais.
   */
  loadOrderDiagnostics(uri: string): ParseDiagnostic[] {
    const analysis = this.files.get(uri);
    const order = this.loadOrder;
    if (analysis === undefined || order === null) return [];
    const callerRank = order.get(uri);
    if (callerRank === undefined) return [];
    const diagnostics: ParseDiagnostic[] = [];
    for (const call of analysis.unknownCalls) {
      const definitions = this.functions.get(call.name);
      if (definitions === undefined) continue;
      const known = definitions.some((definition) => {
        // Dans le meme fichier, une fonction n'est connue qu'une fois sa definition lue en entier : elle doit finir avant l'appel.
        // Les declarations ne se chevauchent pas : une definition situee apres l'appelant finit apres l'appel, et la fonction qui
        // s'appelle elle-meme finit apres l'appel (il est dans son corps).
        if (definition.uri === uri) return definition.range.end <= call.range.start;
        const rank = order.get(definition.uri);
        return rank !== undefined && rank < callerRank;
      });
      if (!known) diagnostics.push(createDiagnostic("RA0016", call.range, { name: call.name }));
    }
    return diagnostics;
  }

  /**
   * Commandes inconnues (`RA0001`) d'un fichier : appels dont le nom n'est ni une commande du registre, ni une fonction
   * locale du script (deja ecartees a l'analyse), ni une fonction globale de l'index. Le serveur accepte en effet d'appeler
   * par son seul nom une fonction globale deja chargee (`Nom arg;` equivaut a `callfunc "Nom", arg;`), avec la meme
   * sensibilite a la casse que `callfunc`.
   *
   * Un index partiel donnerait de fausses alertes pour les fonctions definies dans un fichier non indexe : l'appelant ne
   * doit l'utiliser qu'une fois l'indexation du projet terminee.
   */
  unknownCommandDiagnostics(uri: string, options: UnknownCommandOptions): ParseDiagnostic[] {
    const analysis = this.files.get(uri);
    return analysis === undefined ? [] : this.unknownCommandsOf(analysis, options);
  }

  /** Comme `unknownCommandDiagnostics`, pour une analyse qui n'est pas dans l'index (l'apercu d'un texte, par exemple). */
  unknownCommandsOf(analysis: FileAnalysis, options: UnknownCommandOptions): ParseDiagnostic[] {
    const diagnostics: ParseDiagnostic[] = [];
    for (const call of analysis.unknownCalls) {
      if (this.functions.has(call.name)) continue;
      diagnostics.push(createDiagnostic("RA0001", call.range, { name: call.name, profile: options.profile }, { severity: options.severity }));
    }
    return diagnostics;
  }

  /** Diagnostics locaux + inter-fichiers d'un fichier, tries par position. */
  diagnosticsFor(uri: string, options: CrossFileOptions): ParseDiagnostic[] {
    const analysis = this.files.get(uri);
    if (analysis === undefined) return [];
    return [...analysis.diagnostics, ...this.crossFileDiagnostics(uri, options)].sort(
      (a, b) => a.range.start - b.range.start || a.range.end - b.range.end,
    );
  }
}
