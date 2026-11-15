import { initialValues, NPC_WIZARDS, validateWizard, type WizardProblem, type WizardProblemCode } from "@runeforge/npc-templates";
import type { TreeNode } from "@runeforge/project-core";
import { describe, expect, it } from "vitest";
import { MESSAGES, translate } from "../../i18n/messages";
import { DIRECTION_LABEL, fieldHintKey, fieldLabelKey, PROBLEM_MESSAGE, problemParams, suggestFileName, WIZARD_DESCRIPTION, WIZARD_NAME } from "./wizard-ui";

const node = (name: string, kind: "file" | "directory", children: TreeNode[] = []): TreeNode => ({ name, path: name, kind, size: 0, children });
const tree = (...names: string[]): TreeNode => node("", "directory", names.map((name) => node(name, "directory")));

describe("assistants de NPC : textes de l'interface", () => {
  it("donne un nom et une description a chaque assistant, dans les deux langues", () => {
    for (const wizard of NPC_WIZARDS) {
      for (const key of [WIZARD_NAME[wizard.id], WIZARD_DESCRIPTION[wizard.id]]) {
        expect(MESSAGES.en[key].length).toBeGreaterThan(0);
        expect(MESSAGES.fr[key].length).toBeGreaterThan(0);
      }
    }
  });

  it("donne un libelle a chaque champ de chaque assistant (un champ sans libelle afficherait sa cle)", () => {
    for (const wizard of NPC_WIZARDS) {
      for (const field of wizard.fields) {
        const key = fieldLabelKey(field.key);
        expect(key, `${wizard.id}.${field.key}`).toBeDefined();
        if (key !== undefined) {
          expect(MESSAGES.en[key].length).toBeGreaterThan(0);
          expect(MESSAGES.fr[key].length).toBeGreaterThan(0);
        }
      }
    }
  });

  it("n'ajoute une aide qu'aux champs qui en ont une, et elle est traduite", () => {
    expect(fieldHintKey("name")).toBe("wizard.hint.name");
    expect(fieldHintKey("sprite")).toBe("wizard.hint.sprite");
    expect(fieldHintKey("items")).toBe("wizard.hint.items");
    expect(fieldHintKey("x")).toBeUndefined();
    expect(fieldHintKey("inconnu")).toBeUndefined();
    expect(fieldLabelKey("inconnu")).toBeUndefined();
  });

  it("nomme chaque message d'apres son code, son champ, son assistant ou son orientation (un echange de cles passerait inapercu sinon)", () => {
    for (const code of Object.keys(PROBLEM_MESSAGE) as WizardProblemCode[]) expect(PROBLEM_MESSAGE[code]).toBe(`wizard.problem.${code}`);
    for (const wizard of NPC_WIZARDS) {
      expect(WIZARD_NAME[wizard.id]).toBe(`wizard.name.${wizard.id}`);
      expect(WIZARD_DESCRIPTION[wizard.id]).toBe(`wizard.desc.${wizard.id}`);
      for (const field of wizard.fields) expect(fieldLabelKey(field.key)).toBe(`wizard.field.${field.key}`);
    }
    for (const key of ["name", "sprite", "items"]) expect(fieldHintKey(key)).toBe(`wizard.hint.${key}`);
    DIRECTION_LABEL.forEach((key, index) => expect(key).toBe(`wizard.direction.${index}`));
  });

  it("nomme les huit orientations dans l'ordre du serveur, du nord vers le sud-est en tournant a gauche", () => {
    expect(DIRECTION_LABEL).toHaveLength(8);
    const names = DIRECTION_LABEL.map((key) => MESSAGES.en[key]);
    expect(names[0]).toBe("North (0)");
    expect(names[2]).toBe("West (2)");
    expect(names[4]).toBe("South (4)");
    expect(names[5]).toBe("South-east (5)");
    expect(names[6]).toBe("East (6)");
    names.forEach((name, index) => expect(name).toContain(`(${index})`));
    DIRECTION_LABEL.forEach((key, index) => expect(MESSAGES.fr[key]).toContain(`(${index})`));
  });
});

describe("assistants de NPC : messages des problemes de saisie", () => {
  /** Des saisies qui font produire au coeur chacun de ses codes de probleme. */
  function everyProblem(): WizardProblem[] {
    const shop = initialValues("shop");
    const warp = initialValues("warp-npc");
    return [
      ...validateWizard("shop", { ...shop, name: "", x: "abc", y: "9999", map: "carte invalide", sprite: "sprite invalide!", items: "x\n0 5\n501 99999999999\n502 0\n503 2000000000\n504 5\n504 6" }),
      ...validateWizard("shop", { ...shop, name: "N".repeat(51), items: "" }),
      ...validateWizard("shop", { ...shop, name: "Un nom d'affichage vraiment trop long" }),
      ...validateWizard("warp-npc", { ...warp, greeting: "deux\tcolonnes", yes: "a:b" }),
    ];
  }

  it("couvre tous les codes du coeur (si l'assistant en gagne un, ce test echoue avec la compilation)", () => {
    const codes = new Set(everyProblem().map((problem) => problem.code));
    expect([...codes].sort()).toEqual(Object.keys(PROBLEM_MESSAGE).sort());
  });

  it("produit un message complet, sans parametre manquant, pour chaque probleme et dans chaque langue", () => {
    for (const problem of everyProblem()) {
      for (const language of ["en", "fr"] as const) {
        const text = translate(language, PROBLEM_MESSAGE[problem.code], problemParams(problem, language));
        expect(text, `${language}:${problem.code}`).not.toMatch(/[{}]/);
        expect(text.length).toBeGreaterThan(5);
      }
    }
  });

  it("ajoute les bornes du coeur, mises en forme pour la langue, aux parametres du probleme", () => {
    const problem: WizardProblem = { field: "items", severity: "warning", code: "itemDuplicate", params: { line: 2, id: 501 } };
    expect(problemParams(problem, "en")).toEqual({ line: 2, id: 501, itemIdMax: "4,294,967,295", priceMax: "2,147,483,647", threshold: "1,000,000,000" });
    expect(problemParams(problem, "fr")["priceMax"]).toBe(new Intl.NumberFormat("fr").format(2_147_483_647));
    expect(problemParams({ field: "x", severity: "error", code: "required" }, "en")).toEqual({ itemIdMax: "4,294,967,295", priceMax: "2,147,483,647", threshold: "1,000,000,000" });
  });
});

describe("assistants de NPC : nom de fichier propose", () => {
  it("met le nom affiche en minuscules ASCII, sans accents ni ponctuation", () => {
    expect(suggestFileName("Merchant", null, null)).toBe("merchant.txt");
    expect(suggestFileName("Marchand d'armes", null, null)).toBe("marchand_d_armes.txt");
    expect(suggestFileName("Éric le Forgeron", null, null)).toBe("eric_le_forgeron.txt");
    expect(suggestFileName("  --Healer--  ", null, null)).toBe("healer.txt");
  });

  it("n'utilise que le nom affiche : ce qui suit # ou :: identifie le NPC mais ne le nomme pas", () => {
    expect(suggestFileName("Kafra#prt01", null, null)).toBe("kafra.txt");
    expect(suggestFileName("Kafra::KafraPrt", null, null)).toBe("kafra.txt");
  });

  it("retombe sur npc.txt quand le nom ne contient aucun caractere utilisable", () => {
    expect(suggestFileName("", null, null)).toBe("npc.txt");
    expect(suggestFileName("???", null, null)).toBe("npc.txt");
    expect(suggestFileName("日本語", null, null)).toBe("npc.txt");
  });

  it("se place a cote du fichier de script ouvert", () => {
    expect(suggestFileName("Merchant", "npc/custom/a.txt", tree("npc"))).toBe("npc/custom/merchant.txt");
    expect(suggestFileName("Merchant", "scripts/quests/b.txt", null)).toBe("scripts/quests/merchant.txt");
    expect(suggestFileName("Merchant", "c.txt", tree("npc"))).toBe("merchant.txt");
  });

  it("ignore un fichier ouvert qui n'est pas un script (configuration, base de donnees)", () => {
    expect(suggestFileName("Merchant", "conf/scripts_custom.conf", tree("npc"))).toBe("npc/custom/merchant.txt");
    expect(suggestFileName("Merchant", "db/item_db.yml", null)).toBe("merchant.txt");
  });

  it("sans fichier ouvert, propose npc/custom/ si le projet a un dossier npc a sa racine, sinon la racine", () => {
    expect(suggestFileName("Merchant", null, tree("npc", "db"))).toBe("npc/custom/merchant.txt");
    expect(suggestFileName("Merchant", null, tree("db", "conf"))).toBe("merchant.txt");
    expect(suggestFileName("Merchant", null, null)).toBe("merchant.txt");
    // Un fichier nomme npc n'est pas un dossier.
    expect(suggestFileName("Merchant", null, node("", "directory", [node("npc", "file")]))).toBe("merchant.txt");
  });
});
