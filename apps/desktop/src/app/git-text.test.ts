import { describe, expect, it } from "vitest";
import { MESSAGES } from "../i18n/messages";
import type { GitStatus } from "../services/types";
import { GIT_UNAVAILABLE_REASONS } from "../state/store";
import { branchSummary, GIT_KIND_MESSAGE, GIT_LETTER, GIT_UNAVAILABLE_MESSAGE, gitKind, isOnDisk, isStaged, shortBranch, type GitKind } from "./git-text";

const status = (overrides: Partial<GitStatus> = {}): GitStatus => ({ branch: "main", detached: false, unborn: false, head: "0123456789ab", entries: [], truncated: false, ...overrides });

describe("Git : nature d'un fichier modifie", () => {
  it.each([
    [".", "M", "modified"],
    ["M", ".", "modified"],
    ["M", "M", "modified"],
    ["A", ".", "added"],
    ["A", "M", "added"],
    [".", "D", "deleted"],
    ["D", ".", "deleted"],
    ["?", "?", "untracked"],
    ["U", "U", "conflict"],
    ["R", ".", "renamed"],
    ["C", ".", "renamed"],
    ["R", "M", "renamed"],
    [".", "T", "typechange"],
    ["T", ".", "typechange"],
  ] as const)("x=%s y=%s -> %s", (x, y, kind) => {
    expect(gitKind({ x, y })).toBe(kind);
  });

  it("donne la priorite a un conflit, puis a un fichier non suivi, puis a une suppression", () => {
    expect(gitKind({ x: "U", y: "D" })).toBe("conflict");
    expect(gitKind({ x: ".", y: "U" })).toBe("conflict");
    expect(gitKind({ x: "?", y: "D" })).toBe("untracked");
    expect(gitKind({ x: "A", y: "D" })).toBe("deleted");
    expect(gitKind({ x: "R", y: "T" })).toBe("renamed");
    // Git ne signale jamais un renommage cote dossier de travail (`--no-renames`) : une lettre R ou C y est une modification ordinaire.
    expect(gitKind({ x: ".", y: "R" })).toBe("modified");
  });

  it("a une lettre et un texte, dans les deux langues, pour chaque nature", () => {
    const kinds: GitKind[] = ["modified", "added", "deleted", "untracked", "conflict", "typechange", "renamed"];
    expect(Object.keys(GIT_LETTER).sort()).toEqual([...kinds].sort());
    expect(new Set(Object.values(GIT_LETTER)).size).toBe(kinds.length);
    for (const kind of kinds) {
      expect(GIT_KIND_MESSAGE[kind]).toBe(`git.kind.${kind}`);
      expect(MESSAGES.en[GIT_KIND_MESSAGE[kind]].length).toBeGreaterThan(0);
      expect(MESSAGES.fr[GIT_KIND_MESSAGE[kind]].length).toBeGreaterThan(0);
    }
    expect(GIT_LETTER).toMatchObject({ modified: "M", added: "A", deleted: "D", untracked: "?", conflict: "U" });
  });

  it("dit pourquoi Git n'est pas disponible pour chaque cause connue, dans les deux langues", () => {
    expect(Object.keys(GIT_UNAVAILABLE_MESSAGE).sort()).toEqual([...GIT_UNAVAILABLE_REASONS].sort());
    for (const reason of GIT_UNAVAILABLE_REASONS) {
      expect(GIT_UNAVAILABLE_MESSAGE[reason]).toBe(`git.unavailable.${reason}`);
      expect(MESSAGES.en[GIT_UNAVAILABLE_MESSAGE[reason]].length).toBeGreaterThan(10);
      expect(MESSAGES.fr[GIT_UNAVAILABLE_MESSAGE[reason]].length).toBeGreaterThan(10);
    }
  });

  it("sait ce qui est dans l'index et ce qui existe sur le disque", () => {
    expect(isStaged({ x: "A" })).toBe(true);
    expect(isStaged({ x: "M" })).toBe(true);
    expect(isStaged({ x: "D" })).toBe(true);
    expect(isStaged({ x: "." })).toBe(false);
    expect(isStaged({ x: "?" })).toBe(false);
    expect(isStaged({ x: "U" })).toBe(false);
    expect(isOnDisk({ x: ".", y: "M" })).toBe(true);
    expect(isOnDisk({ x: "?", y: "?" })).toBe(true);
    expect(isOnDisk({ x: ".", y: "D" })).toBe(false);
    expect(isOnDisk({ x: "D", y: "." })).toBe(false);
  });
});

describe("Git : branche", () => {
  it("resume la branche, une branche sans commit et un HEAD detache", () => {
    expect(branchSummary(status())).toEqual({ key: "git.branch", params: { branch: "main" } });
    expect(branchSummary(status({ unborn: true, head: null }))).toEqual({ key: "git.branchUnborn", params: { branch: "main" } });
    expect(branchSummary(status({ branch: null, detached: true }))).toEqual({ key: "git.detached", params: { head: "0123456789ab" } });
    expect(branchSummary(status({ branch: null, detached: true, head: null }))).toEqual({ key: "git.detached", params: { head: "?" } });
  });

  it("donne le nom court de la barre d'etat", () => {
    expect(shortBranch(status())).toBe("main");
    expect(shortBranch(status({ branch: null, detached: true }))).toBe("0123456789ab");
    expect(shortBranch(status({ branch: null, detached: false, head: null }))).toBe("?");
    expect(shortBranch(status({ branch: null, detached: true, head: null }))).toBe("?");
  });
});
