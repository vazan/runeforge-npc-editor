import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { en, fr } from "../i18n/messages";
import { UPDATE_ERROR_CODES } from "../services/types";
import {
  SELF_UPDATE_PLATFORMS,
  UPDATE_ERROR_MESSAGE,
  canInstallOn,
  formatMebibytes,
  isUpdateToken,
  releaseDate,
  updateFailureCode,
  updateFailureText,
  updateLogCode,
  updateProgressPercent,
} from "./update-text";

const rust = (relative: string): string => readFileSync(fileURLToPath(new URL(`../../../../${relative}`, import.meta.url)), "utf8");

describe("codes d'erreur des mises a jour", () => {
  it("suivent exactement ceux du coeur de mise a jour (crates/updater) et ceux du journal local (crates/filesystem)", () => {
    const updaterSource = rust("crates/updater/src/error.rs");
    const body = updaterSource.slice(updaterSource.indexOf("pub fn code(&self)"), updaterSource.indexOf("pub fn bad_manifest"));
    const updaterCodes = [...body.matchAll(/UpdateError::\w+(?:\s*\{[^}]*\})?\s*=>\s*"([a-z_]+)"/g)].map((match) => match[1] ?? "");
    expect(updaterCodes.length).toBeGreaterThan(20);
    expect([...updaterCodes].sort()).toEqual([...UPDATE_ERROR_CODES].sort());

    const logSource = rust("crates/filesystem/src/log.rs");
    const list = /const UPDATE_CODES: &\[&str\] = &\[([^\]]*)\];/.exec(logSource)?.[1] ?? "";
    const logCodes = [...list.matchAll(/"([a-z_]+)"/g)].map((match) => match[1] ?? "");
    expect([...logCodes].sort()).toEqual(["unknown", ...UPDATE_ERROR_CODES].sort());
  });

  it("ont un texte dans les deux langues, plus un texte pour tout echec inconnu", () => {
    for (const code of [...UPDATE_ERROR_CODES, "failed"] as const) {
      const key = UPDATE_ERROR_MESSAGE[code];
      expect(en[key].length, `en.${key}`).toBeGreaterThan(10);
      expect(fr[key].length, `fr.${key}`).toBeGreaterThan(10);
    }
    expect(Object.keys(UPDATE_ERROR_MESSAGE).sort()).toEqual([...UPDATE_ERROR_CODES, "failed"].sort());
  });

  it("transforme un code inconnu en `failed` et choisit un code accepte par le journal", () => {
    expect(updateFailureCode("hash_mismatch")).toBe("hash_mismatch");
    expect(updateFailureCode("something_new")).toBe("failed");
    expect(updateFailureCode("")).toBe("failed");
    expect(updateLogCode("failed")).toBe("unknown");
    expect(updateLogCode("network")).toBe("network");
  });

  it("n'affiche le detail d'installation que quand l'utilisateur doit agir", () => {
    expect(updateFailureText({ code: "install_failed", reason: "replace_kept_backup" }).key).toBe("update.error.install_failed.kept_backup");
    for (const reason of ["stage", "backup", "replace_rolled_back", "backup_in_use", "cancelled", undefined]) {
      expect(updateFailureText({ code: "install_failed", reason }).key, String(reason)).toBe("update.error.install_failed");
    }
    expect(updateFailureText({ code: "manual_update_required", minimum: "0.3.0" }).params).toEqual({ minimum: "0.3.0" });
    expect(updateFailureText({ code: "manual_update_required" }).params).toEqual({ minimum: "?" });
  });
});

describe("systemes ou l'application se met a jour seule", () => {
  it("sont Windows et Linux, comme `supports_install` du coeur de mise a jour (lu dans le code Rust)", () => {
    const source = rust("crates/updater/src/platform.rs");
    const list = /pub fn supports_install\(os: &str\) -> bool \{\s*matches!\(os, ([^)]*)\)/.exec(source)?.[1] ?? "";
    const systems = [...list.matchAll(/"([a-z]+)"/g)].map((match) => match[1] ?? "");
    expect([...systems].sort()).toEqual([...SELF_UPDATE_PLATFORMS].sort());
    expect(SELF_UPDATE_PLATFORMS).toEqual(["windows", "linux"]);
  });

  it("n'en reconnait aucun autre, et ne confond ni la casse ni une cle de plateforme avec un systeme", () => {
    expect(canInstallOn("windows") && canInstallOn("linux")).toBe(true);
    for (const other of ["macos", "freebsd", "test", "", "Windows", "Linux", "linux-x86_64"]) expect(canInstallOn(other), JSON.stringify(other)).toBe(false);
  });
});

describe("petites regles d'affichage", () => {
  it("reconnait un jeton d'acces comme le fait le coeur natif", () => {
    for (const good of ["ghp_abc123", "github_pat_11AAA_bbb-ccc", "a", "A".repeat(255)]) expect(isUpdateToken(good), good).toBe(true);
    for (const bad of ["", " ", "a b", "a\nb", "a;b", "é", "a".repeat(256), "ghp_x\r\nX-Evil: 1"]) expect(isUpdateToken(bad), JSON.stringify(bad)).toBe(false);
  });

  it("calcule un pourcentage borne", () => {
    expect(updateProgressPercent(0, 1000)).toBe(0);
    expect(updateProgressPercent(499, 1000)).toBe(49);
    expect(updateProgressPercent(1000, 1000)).toBe(100);
    expect(updateProgressPercent(5000, 1000)).toBe(100);
    expect(updateProgressPercent(-5, 1000)).toBe(0);
    expect(updateProgressPercent(5, 0)).toBe(0);
  });

  it("affiche une taille en Mio et une date de publication", () => {
    expect(formatMebibytes(12_345_678, "en")).toBe("11.8");
    expect(formatMebibytes(12_345_678, "fr").replace(/\s/g, "")).toBe("11,8");
    expect(releaseDate("2026-11-15T10:00:00Z")).toBe("2026-11-15");
  });
});
