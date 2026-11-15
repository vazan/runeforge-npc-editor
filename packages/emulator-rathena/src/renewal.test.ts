import { describe, expect, it } from "vitest";
import { detectRenewal } from "./renewal";

describe("detectRenewal", () => {
  it("suppose le mode renewal (defaut de rAthena) quand le fichier est absent, en le disant", () => {
    expect(detectRenewal(null)).toEqual({ renewal: true, evidence: "default" });
  });

  it("lit #define RENEWAL actif", () => {
    const header = ["#ifndef CONFIG_RENEWAL_HPP", "#define CONFIG_RENEWAL_HPP", "//#define PRERE", "#ifndef PRERE", "/// Laisser cette ligne", "#define RENEWAL", "#endif", "#endif"].join("\n");
    expect(detectRenewal(header)).toEqual({ renewal: true, evidence: "header" });
  });

  it("reconnait un define avec espaces, tabulations et commentaire de fin", () => {
    expect(detectRenewal("  #  define\tRENEWAL   // actif\n").renewal).toBe(true);
    expect(detectRenewal("#define RENEWAL\r\n").renewal).toBe(true);
  });

  it("est en pre-renewal quand RENEWAL est commente", () => {
    expect(detectRenewal("//#define RENEWAL\n")).toEqual({ renewal: false, evidence: "header" });
    expect(detectRenewal("/* #define RENEWAL */\n").renewal).toBe(false);
    expect(detectRenewal("/*\n#define RENEWAL\n*/\n").renewal).toBe(false);
  });

  it("est en pre-renewal quand PRERE est defini (ecrit par ./configure)", () => {
    expect(detectRenewal("#define PRERE\n#ifndef PRERE\n#define RENEWAL\n#endif\n").renewal).toBe(false);
  });

  it("ne confond pas RENEWAL avec RENEWAL_CAST ou une autre macro", () => {
    expect(detectRenewal("#define RENEWAL_CAST\n#define RENEWAL_DROP\n").renewal).toBe(false);
  });
});
