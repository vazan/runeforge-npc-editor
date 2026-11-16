import { mkdtempSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { argumentsForRelease, buildRelease, checkAppImage, stepCommand, withoutSigningSecrets, type ReleaseOptions } from "./build";

const head = "a".repeat(40);
const options: ReleaseOptions = { root: "C:\\project", version: "0.1.0-beta.2", notes: "notes.txt", repository: "owner/repo", allowDownload: false };

describe("release builder", () => {
  it("exige les confirmations WSL et licences avant de lancer les commandes", () => {
    const args = ["--notes", "notes.txt", "--repo", "owner/repo"];
    expect(() => argumentsForRelease(args)).toThrow("--confirm-wsl-sync");
    expect(() => argumentsForRelease([...args, "--confirm-wsl-sync"])).toThrow("--confirm-appimage-licenses");
    expect(argumentsForRelease([...args, "--confirm-wsl-sync", "--confirm-appimage-licenses"])).toEqual({
      notes: "notes.txt", repository: "owner/repo", allowDownload: false,
    });
    expect(() => argumentsForRelease(["--notes", "notes.txt", "--repo", "invalid"])).toThrow("--repo");
  });

  it("verifie, construit, signe et ajoute l'AppImage au brouillon du commit verifie", () => {
    const steps: string[] = [];
    buildRelease({
      checkGit: () => { steps.push("git"); return head; },
      run: (step, commit) => { expect(commit).toBe(head); steps.push(step); },
      checkAppImage: () => { steps.push("appimage"); },
    });
    expect(steps).toEqual(["git", "checks", "e2e", "windows", "linux", "appimage", "prepare", "git", "draft", "upload"]);
    expect(stepCommand("prepare", options, head).args).toContain(`linux-x86_64=${join(options.root, "target", "release", "runeforge-studio-linux-x86_64")}`);
    expect(stepCommand("draft", options, head).args).toContain(head);
    expect(stepCommand("upload", options, head).args).toContain(`${join(options.root, "target", "release", "runeforge-studio-linux-x86_64")}.AppImage`);
  });

  it("s'arrete avant signature et publication si la construction echoue", () => {
    const steps: string[] = [];
    expect(() => buildRelease({
      checkGit: () => head,
      run: (step) => { steps.push(step); if (step === "linux") throw new Error("build failed"); },
      checkAppImage: () => { steps.push("appimage"); },
    })).toThrow("build failed");
    expect(steps).toEqual(["checks", "e2e", "windows", "linux"]);
  });

  it("ne cree pas de brouillon si HEAD change pendant la construction", () => {
    const steps: string[] = [];
    let checks = 0;
    expect(() => buildRelease({
      checkGit: () => checks++ === 0 ? head : "b".repeat(40),
      run: (step) => { steps.push(step); },
      checkAppImage: () => {},
    })).toThrow("HEAD a change");
    expect(steps).not.toContain("draft");
  });

  it("signale le brouillon partiel si l'ajout de l'AppImage echoue", () => {
    expect(() => buildRelease({
      checkGit: () => head,
      run: (step) => { if (step === "upload") throw new Error("upload failed"); },
      checkAppImage: () => {},
    })).toThrow("Le brouillon existe");
  });

  it("ne permet les telechargements de build Linux que sur demande", () => {
    expect(stepCommand("linux", options, head).args).not.toContain("--allow-download");
    expect(stepCommand("linux", { ...options, allowDownload: true }, head).args).toContain("--allow-download");
  });

  it("ne transmet pas les variables de signature aux autres commandes, quelle que soit leur casse", () => {
    expect(withoutSigningSecrets({
      tauri_signing_private_key_path: "private",
      TAURI_SIGNING_PRIVATE_KEY_PASSWORD: "password",
      PATH: "path",
    })).toEqual({ PATH: "path" });
  });

  it("refuse un ELF ordinaire ou un fichier tronque comme AppImage", () => {
    const dir = mkdtempSync(join(tmpdir(), "runeforge-appimage-test-"));
    const path = join(dir, "test.AppImage");
    try {
      writeFileSync(path, Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
      expect(() => checkAppImage(path)).toThrow("AppImage de type 2");
      writeFileSync(path, Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 0, 0, 0, 0x41, 0x49, 0x02]));
      expect(() => checkAppImage(path)).not.toThrow();
    } finally {
      unlinkSync(path);
      rmdirSync(dir);
    }
  });
});
