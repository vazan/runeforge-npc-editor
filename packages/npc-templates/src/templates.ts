import { expandSnippet } from "./snippet";

/** Emulateurs pour lesquels un modele peut etre verifie. Un modele n'est jamais suppose valable pour un autre. */
export type TemplateEmulator = "rathena";

export type NpcTemplateId = "npc-script" | "npc-warp" | "npc-shop" | "npc-healer";

export interface NpcTemplate {
  /** Identifiant stable ; c'est aussi le texte que l'on tape dans l'editeur pour le proposer. */
  readonly id: NpcTemplateId;
  /** Emulateurs sur lesquels le modele est verifie (voir `templates.test.ts` et `scripts/registry-report.ts`). */
  readonly emulators: readonly TemplateEmulator[];
  /** Description neutre (anglais) ; l'interface la traduit d'apres l'identifiant. */
  readonly description: string;
  /** Texte au format snippet (voir `snippet.ts`). Les separateurs des en-tetes sont de vraies tabulations. */
  readonly snippet: string;
}

/**
 * Modeles V1 (CLAUDE.md 10.1) : script de NPC minimal, warp statique, boutique standard, soigneur simple. Textes rediges pour
 * ce projet ; la syntaxe est celle des scripts rAthena (en-tete `carte,x,y,direction<TAB>type<TAB>nom<TAB>sprite`).
 * Chaque modele est analyse sans aucun diagnostic et ses commandes sont verifiees contre le registre d'un serveur reel.
 */
export const NPC_TEMPLATES: readonly NpcTemplate[] = [
  {
    id: "npc-script",
    emulators: ["rathena"],
    description: "NPC with a short dialogue",
    snippet: [
      "${1:prontera},${2:155},${3:180},${4:4}\tscript\t${5:NPC name}\t${6:4_M_01},{",
      '\tmes "[${5:NPC name}]";',
      '\tmes "${7:Hello.}";',
      "\tclose;",
      "\\}",
      "$0",
    ].join("\n"),
  },
  {
    id: "npc-warp",
    emulators: ["rathena"],
    description: "Warp portal",
    // Forme documentee du manuel (`carte,x,y,direction`) : celle des 4 152 warps du serveur local, meme si le serveur n'en lit que trois valeurs.
    snippet: ["${1:prontera},${2:155},${3:180},${4:0}\twarp\t${5:warp_name}\t${6:2},${7:2},${8:geffen},${9:120},${10:60}", "$0"].join("\n"),
  },
  {
    id: "npc-shop",
    emulators: ["rathena"],
    description: "Shop with two items",
    snippet: ["${1:prontera},${2:155},${3:180},${4:4}\tshop\t${5:Shop name}\t${6:4_M_01},${7:501}:${8:50},${9:502}:${10:200}", "$0"].join("\n"),
  },
  {
    id: "npc-healer",
    emulators: ["rathena"],
    description: "Healer NPC with a menu",
    snippet: [
      "${1:prontera},${2:155},${3:180},${4:4}\tscript\t${5:Healer}\t${6:4_F_01},{",
      '\tmes "[${5:Healer}]";',
      '\tmes "${7:I can heal you.}";',
      "\tnext;",
      '\tmenu "${8:Heal me}",L_Heal,"${9:No, thanks}",L_End;',
      "L_Heal:",
      "\tpercentheal 100,100;",
      '\tmes "[${5:Healer}]";',
      '\tmes "${10:There you go.}";',
      "\tclose;",
      "L_End:",
      "\tclose;",
      "\\}",
      "$0",
    ].join("\n"),
  },
];

/** Les modeles verifies pour un emulateur ; aucun si l'emulateur est inconnu. */
export function templatesFor(emulator: string | null): readonly NpcTemplate[] {
  return NPC_TEMPLATES.filter((template) => (template.emulators as readonly string[]).includes(emulator ?? ""));
}

/** Le script que produit un modele quand on garde toutes les valeurs par defaut. */
export function renderTemplate(template: NpcTemplate): string {
  return expandSnippet(template.snippet);
}
