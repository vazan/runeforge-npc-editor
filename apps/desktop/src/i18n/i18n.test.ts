import { describe, expect, it } from "vitest";
import { en, format, fr, translate, type MessageKey } from "./messages";

function placeholders(text: string): string[] {
  return [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1] ?? "").sort();
}

describe("messages FR/EN", () => {
  const keys = Object.keys(en) as MessageKey[];

  it("ont exactement les memes cles", () => {
    expect(Object.keys(fr).sort()).toEqual([...keys].sort());
  });

  it("n'ont aucune traduction vide", () => {
    for (const key of keys) {
      expect(en[key].trim(), `en.${key}`).not.toBe("");
      expect(fr[key].trim(), `fr.${key}`).not.toBe("");
    }
  });

  it("utilisent les memes parametres {nom} dans les deux langues", () => {
    for (const key of keys) {
      expect(placeholders(fr[key]), key).toEqual(placeholders(en[key]));
    }
  });

  it("n'ont pas de texte francais laisse tel quel pour les commandes courantes", () => {
    expect(fr["cmd.save"]).toBe("Enregistrer");
    expect(en["cmd.save"]).toBe("Save");
  });
});

describe("format / translate", () => {
  it("interpole les parametres et laisse visible un parametre manquant", () => {
    expect(format("Bonjour {nom}, {n} fichiers", { nom: "Ayata", n: 3 })).toBe("Bonjour Ayata, 3 fichiers");
    expect(format("Bonjour {nom}", {})).toBe("Bonjour {nom}");
    expect(format("sans parametre")).toBe("sans parametre");
  });

  it("traduit selon la langue", () => {
    expect(translate("fr", "tabs.close", { name: "a.txt" })).toBe("Fermer a.txt");
    expect(translate("en", "tabs.close", { name: "a.txt" })).toBe("Close a.txt");
  });
});
