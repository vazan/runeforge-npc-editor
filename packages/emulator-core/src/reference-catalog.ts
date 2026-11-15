/**
 * Catalogue de references d'un serveur : les objets, monstres, competences, cartes et constantes que ses scripts peuvent nommer.
 *
 * Comme le registre de commandes (DEC-025), il est **construit a l'execution** a partir des fichiers de l'utilisateur et ne
 * contient que des enregistrements sources (chacun garde `fichier:ligne`). Rien n'est embarque (DEC-012). Les regles de
 * fusion propres a un emulateur (surcharges, doublons) sont appliquees par son adaptateur : le catalogue recoit le resultat
 * final et ne fait que le rechercher.
 *
 * Regles de correspondance reprises du serveur rAthena local (`itemdb.cpp`, `mob.cpp`, `mapindex.cpp`, `script.cpp`) :
 * - objet : `searchname` cherche l'AegisName puis le nom d'affichage, sans tenir compte de la casse ; un nombre est un identifiant ;
 * - monstre : `mobdb_search_aegisname` ne connait que l'AegisName ; `mobdb_searchname` accepte aussi les noms d'affichage ;
 * - competence : `skill_name2id` cherche le nom interne, sans tenir compte de la casse ;
 * - carte : nom exact (sensible a la casse), extension `.gat` retiree ;
 * - constante : insensible a la casse (`add_str` compare sans casse, comme les commandes).
 */

/** Nature d'une reference nommee dans un script. */
export type ReferenceKind = "item" | "mob" | "skill" | "map" | "constant";

export interface ItemRecord {
  readonly id: number;
  /** Nom du serveur pour reference l'objet dans les scripts (`Red_Potion`). */
  readonly aegisName: string;
  /** Nom d'affichage en anglais (`Red Potion`). */
  readonly name: string;
  /** Type (`Healing`, `Weapon`...) ; `null` s'il n'est pas ecrit. */
  readonly type: string | null;
  /** Fichier et ligne de l'entree (`db/re/item_db_usable.yml:99`). */
  readonly source: string;
}

export interface MobRecord {
  readonly id: number;
  readonly aegisName: string;
  readonly name: string;
  readonly japaneseName: string | null;
  readonly level: number | null;
  readonly source: string;
}

export interface SkillRecord {
  readonly id: number;
  /** Nom du serveur ecrit dans les scripts (`NV_BASIC`). */
  readonly name: string;
  readonly description: string;
  readonly maxLevel: number;
  readonly source: string;
}

export interface MapRecord {
  readonly name: string;
  /** Index inter-serveurs de la carte (`db/map_index.txt`). */
  readonly index: number;
  readonly source: string;
}

export interface ConstantRecord {
  readonly name: string;
  /** Valeur quand elle s'ecrit en clair (`db/const.yml`, `export_constant2("X", 5)`) ; `null` si elle depend du code du serveur. */
  readonly value: number | null;
  /** Parametre du joueur (`BaseLevel`, `Zeny`) plutot que constante. */
  readonly parameter: boolean;
  readonly deprecated: boolean;
  /** `fichier:ligne`, ou `.runeforge/project.json` pour une constante du projet. */
  readonly source: string;
  /** Declaree par le projet et non lue dans le serveur : le serveur ne la connait pas forcement (ne sert pas a juger un nom). */
  readonly custom?: boolean;
}

export interface ReferenceCatalogParts {
  readonly items?: Iterable<ItemRecord>;
  readonly mobs?: Iterable<MobRecord>;
  readonly skills?: Iterable<SkillRecord>;
  readonly maps?: Iterable<MapRecord>;
  readonly constants?: Iterable<ConstantRecord>;
  /**
   * Cartes que le serveur charge (`map:` de `conf/map_athena.conf` et de ses imports), par opposition aux cartes de l'index
   * (`maps`). Absent, `null` ou vide : on ne sait pas lesquelles sont chargees (configuration absente ou illisible), et
   * aucune carte n'est alors dite « non chargee ».
   */
  readonly loadedMaps?: readonly string[] | null;
}

export interface CatalogStats {
  readonly items: number;
  readonly mobs: number;
  readonly skills: number;
  readonly maps: number;
  readonly constants: number;
}

/** Un resultat de recherche, toutes natures confondues. */
export interface ReferenceHit {
  readonly kind: ReferenceKind;
  /** Texte a ecrire dans un script pour designer l'enregistrement (AegisName, nom de carte, nom de constante). */
  readonly name: string;
  /** Identifiant (objet, monstre), index (carte) ou valeur (constante) ; `null` s'il n'est pas connu. */
  readonly id: number | null;
  /** Nom d'affichage, quand il differe du nom ecrit dans les scripts. */
  readonly displayName: string | null;
  /** Type de l'objet, niveau du monstre, constante ou parametre... : un complement bref. */
  readonly detail: string | null;
  readonly source: string;
  /** Plus il est grand, mieux l'enregistrement correspond a la recherche. */
  readonly score: number;
}

const lower = (text: string): string => text.toLowerCase();

interface Indexed<T> {
  readonly record: T;
  /** Texte de recherche en minuscules : identifiant, noms. */
  readonly haystack: string;
}

/** Cle de comparaison d'un nom de constante. */
export function constantKey(name: string): string {
  return lower(name);
}

/** Retire l'extension `.gat` d'un nom de carte (`mapindex_getmapname`). */
export function normalizeMapName(name: string): string {
  return name.length >= 4 && lower(name.slice(-4)) === ".gat" ? name.slice(0, -4) : name;
}

/**
 * Note la correspondance d'une requete avec un enregistrement ; 0 = aucune. Chaque mot de la requete doit correspondre
 * (identifiant en prefixe, ou texte en prefixe d'un mot, ou contenu) : la note est celle du moins bon mot.
 */
function scoreMatch(words: readonly string[], key: string, id: number | null, names: readonly string[]): number {
  let worst = Number.POSITIVE_INFINITY;
  for (const word of words) {
    let best = 0;
    if (id !== null && /^\d+$/.test(word)) {
      const digits = String(id);
      if (digits === word) best = 1000;
      else if (digits.startsWith(word)) best = 600;
    }
    for (const name of names) {
      if (name === word) best = Math.max(best, 900);
      else if (name.startsWith(word)) best = Math.max(best, 700);
    }
    if (best === 0) {
      const at = key.indexOf(word);
      if (at !== -1) {
        // Debut de mot (apres un espace, un `_`, un tiret) ou simple contenu.
        const previous = at === 0 ? " " : key.charAt(at - 1);
        best = /[\s_-]/.test(previous) ? 500 : 300;
      }
    }
    if (best === 0) return 0;
    worst = Math.min(worst, best);
  }
  return worst === Number.POSITIVE_INFINITY ? 0 : worst;
}

/**
 * Ensemble immuable de references connues d'un serveur. Les recherches par nom ou identifiant sont des tables ; la recherche
 * libre (`search`) parcourt les enregistrements (quelques dizaines de milliers : de l'ordre de la milliseconde).
 */
export class ReferenceCatalog {
  private readonly itemsById = new Map<number, ItemRecord>();
  private readonly itemsByAegis = new Map<string, ItemRecord>();
  private readonly itemsByName = new Map<string, ItemRecord>();
  private readonly mobsById = new Map<number, MobRecord>();
  private readonly mobsByAegis = new Map<string, MobRecord>();
  private readonly mobsByAnyName = new Map<string, MobRecord>();
  private readonly skillsById = new Map<number, SkillRecord>();
  private readonly skillsByName = new Map<string, SkillRecord | null>();
  private readonly mapsByName = new Map<string, MapRecord>();
  private readonly constantsByKey = new Map<string, ConstantRecord>();
  private loadedMaps: ReadonlySet<string> | null = null;
  private readonly indexed: { readonly [K in ReferenceKind]: Indexed<unknown>[] } = { item: [], mob: [], skill: [], map: [], constant: [] };

  private constructor(
    /** Nom du profil pour les messages (« rAthena »). */
    readonly profileLabel: string,
  ) {}

  static create(parts: ReferenceCatalogParts, profileLabel: string): ReferenceCatalog {
    const catalog = new ReferenceCatalog(profileLabel);
    for (const item of parts.items ?? []) catalog.addItem(item);
    for (const mob of parts.mobs ?? []) catalog.addMob(mob);
    for (const skill of parts.skills ?? []) catalog.addSkill(skill);
    for (const map of parts.maps ?? []) catalog.addMap(map);
    for (const constant of parts.constants ?? []) catalog.addConstant(constant);
    if (parts.loadedMaps != null && parts.loadedMaps.length > 0) catalog.loadedMaps = new Set(parts.loadedMaps.map(normalizeMapName));
    return catalog;
  }

  private addItem(item: ItemRecord): void {
    this.itemsById.set(item.id, item);
    this.itemsByAegis.set(lower(item.aegisName), item);
    this.itemsByName.set(lower(item.name), item);
    this.indexed.item.push({ record: item, haystack: lower(`${item.id} ${item.aegisName} ${item.name}`) });
  }

  private addMob(mob: MobRecord): void {
    this.mobsById.set(mob.id, mob);
    // Premier arrive, premier servi (le serveur parcourt les monstres par identifiant croissant).
    const aegis = lower(mob.aegisName);
    if (!this.mobsByAegis.has(aegis)) this.mobsByAegis.set(aegis, mob);
    for (const name of [mob.aegisName, mob.name, mob.japaneseName]) {
      if (name === null) continue;
      const key = lower(name);
      if (!this.mobsByAnyName.has(key)) this.mobsByAnyName.set(key, mob);
    }
    this.indexed.mob.push({ record: mob, haystack: lower(`${mob.id} ${mob.aegisName} ${mob.name} ${mob.japaneseName ?? ""}`) });
  }

  private addMap(map: MapRecord): void {
    this.mapsByName.set(map.name, map);
    this.indexed.map.push({ record: map, haystack: lower(`${map.name} ${map.index}`) });
  }

  private addSkill(skill: SkillRecord): void {
    this.skillsById.set(skill.id, skill);
    const name = lower(skill.name);
    this.skillsByName.set(name, this.skillsByName.has(name) ? null : skill);
    this.indexed.skill.push({ record: skill, haystack: lower(`${skill.id} ${skill.name} ${skill.description}`) });
  }

  private addConstant(constant: ConstantRecord): void {
    this.constantsByKey.set(constantKey(constant.name), constant);
    this.indexed.constant.push({ record: constant, haystack: lower(constant.name) });
  }

  stats(): CatalogStats {
    return { items: this.itemsById.size, mobs: this.mobsById.size, skills: this.skillsById.size, maps: this.mapsByName.size, constants: this.constantsByKey.size };
  }

  /** Vrai si le catalogue ne connait rien : aucune alerte ne doit alors en etre tiree. */
  get isEmpty(): boolean {
    const stats = this.stats();
    return stats.items + stats.mobs + stats.skills + stats.maps + stats.constants === 0;
  }

  itemById(id: number): ItemRecord | undefined {
    return this.itemsById.get(id);
  }

  itemByAegisName(name: string): ItemRecord | undefined {
    return this.itemsByAegis.get(lower(name));
  }

  /** Comme `item_db.searchname` : l'AegisName d'abord, puis le nom d'affichage. */
  itemByName(name: string): ItemRecord | undefined {
    const key = lower(name);
    return this.itemsByAegis.get(key) ?? this.itemsByName.get(key);
  }

  mobById(id: number): MobRecord | undefined {
    return this.mobsById.get(id);
  }

  mobByAegisName(name: string): MobRecord | undefined {
    return this.mobsByAegis.get(lower(name));
  }

  /** AegisName, nom d'affichage ou nom japonais (`mobdb_searchname`). */
  mobByName(name: string): MobRecord | undefined {
    return this.mobsByAnyName.get(lower(name));
  }

  skillById(id: number): SkillRecord | undefined {
    return this.skillsById.get(id);
  }

  /** Ne choisit pas entre plusieurs identifiants portant le meme nom interne. */
  skillByName(name: string): SkillRecord | undefined {
    return this.skillsByName.get(lower(name)) ?? undefined;
  }

  mapByName(name: string): MapRecord | undefined {
    return this.mapsByName.get(normalizeMapName(name));
  }

  /** Vrai si l'index des cartes contient au moins une carte : sans cela, aucune carte ne peut etre dite « introuvable ». */
  get hasMaps(): boolean {
    return this.mapsByName.size > 0;
  }

  /** Nombre de cartes que le serveur charge ; `null` quand la liste n'est pas connue. */
  get loadedMapCount(): number | null {
    return this.loadedMaps === null ? null : this.loadedMaps.size;
  }

  /**
   * Le serveur charge-t-il cette carte (`map:` de `conf/maps_athena.conf`) ? Comparaison exacte, comme `map_mapname2mapid`
   * (majuscules et minuscules sont distinguees). `null` : la liste des cartes chargees n'est pas connue.
   */
  mapIsLoaded(name: string): boolean | null {
    return this.loadedMaps === null ? null : this.loadedMaps.has(normalizeMapName(name));
  }

  constantByName(name: string): ConstantRecord | undefined {
    return this.constantsByKey.get(constantKey(name));
  }

  /**
   * Recherche libre dans une nature de references. Sans requete, les premiers enregistrements (par identifiant, puis par nom).
   * Les mots de la requete sont tous exiges ; les meilleurs resultats d'abord, a note egale par identifiant puis par nom.
   */
  search(kind: ReferenceKind, query: string, limit: number): ReferenceHit[] {
    const words = lower(query).split(/\s+/).filter((word) => word !== "");
    const hits: ReferenceHit[] = [];
    for (const entry of this.indexed[kind]) {
      const hit = this.hitOf(kind, entry, words);
      if (hit !== null) hits.push(hit);
    }
    hits.sort((a, b) => b.score - a.score || (a.id ?? 0) - (b.id ?? 0) || a.name.localeCompare(b.name));
    return hits.slice(0, Math.max(0, limit));
  }

  private hitOf(kind: ReferenceKind, entry: Indexed<unknown>, words: readonly string[]): ReferenceHit | null {
    switch (kind) {
      case "item": {
        const item = entry.record as ItemRecord;
        const score = words.length === 0 ? 1 : scoreMatch(words, entry.haystack, item.id, [lower(item.aegisName), lower(item.name)]);
        return score === 0 ? null : { kind, name: item.aegisName, id: item.id, displayName: item.name, detail: item.type, source: item.source, score };
      }
      case "mob": {
        const mob = entry.record as MobRecord;
        const names = [lower(mob.aegisName), lower(mob.name), ...(mob.japaneseName === null ? [] : [lower(mob.japaneseName)])];
        const score = words.length === 0 ? 1 : scoreMatch(words, entry.haystack, mob.id, names);
        return score === 0
          ? null
          : { kind, name: mob.aegisName, id: mob.id, displayName: mob.name, detail: mob.level === null ? null : `Lv ${mob.level}`, source: mob.source, score };
      }
      case "skill": {
        const skill = entry.record as SkillRecord;
        const score = words.length === 0 ? 1 : scoreMatch(words, entry.haystack, skill.id, [lower(skill.name), lower(skill.description)]);
        return score === 0 ? null : { kind, name: skill.name, id: skill.id, displayName: skill.description, detail: null, source: skill.source, score };
      }
      case "map": {
        const map = entry.record as MapRecord;
        const score = words.length === 0 ? 1 : scoreMatch(words, entry.haystack, map.index, [lower(map.name)]);
        return score === 0 ? null : { kind, name: map.name, id: map.index, displayName: null, detail: null, source: map.source, score };
      }
      case "constant": {
        const constant = entry.record as ConstantRecord;
        const score = words.length === 0 ? 1 : scoreMatch(words, entry.haystack, null, [lower(constant.name)]);
        return score === 0
          ? null
          : { kind, name: constant.name, id: constant.value, displayName: null, detail: constant.parameter ? "parameter" : null, source: constant.source, score };
      }
    }
  }
}
