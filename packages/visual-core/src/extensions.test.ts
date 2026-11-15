import { describe, expect, it } from "vitest";
import { parseVisualExtensionManifest } from "./extensions";

const manifest = {
  schemaVersion: 1,
  apiVersion: 1,
  id: "local.commands",
  name: "Local commands",
  permissions: [],
  commands: [{
    name: "custom_reward",
    parameterTypes: "is?",
    signatures: ["custom_reward(<item>,<amount>{,<announce>})"],
    documentation: "Awards a server-defined item.",
  }],
};

describe("declarative visual extensions", () => {
  it("parses bounded static command data and derives the argument signature", () => {
    const result = parseVisualExtensionManifest(JSON.stringify(manifest));
    expect(result).toMatchObject({
      ok: true,
      manifest: {
        id: "local.commands",
        permissions: [],
        commands: [{ name: "custom_reward", arity: { min: 2, max: 3 }, parameterTypes: "is?" }],
      },
    });
  });

  it("rejects code, requested privileges, duplicate and reserved commands", () => {
    expect(parseVisualExtensionManifest(JSON.stringify({ ...manifest, entrypoint: "plugin.js" }))).toMatchObject({
      ok: false, code: "invalid-manifest",
    });
    expect(parseVisualExtensionManifest(JSON.stringify({ ...manifest, permissions: ["network"] }))).toMatchObject({
      ok: false, code: "invalid-manifest",
    });
    expect(parseVisualExtensionManifest(JSON.stringify({
      ...manifest,
      commands: [manifest.commands[0], { ...manifest.commands[0], name: "CUSTOM_REWARD" }],
    }))).toMatchObject({ ok: false, code: "duplicate-command" });
    expect(parseVisualExtensionManifest(JSON.stringify(manifest), new Set(["custom_reward"]))).toMatchObject({
      ok: false, code: "reserved-command",
    });
  });

  it("rejects invalid signatures, malformed JSON, and oversized manifests", () => {
    expect(parseVisualExtensionManifest("{")).toMatchObject({ ok: false, code: "invalid-json" });
    expect(parseVisualExtensionManifest(JSON.stringify({
      ...manifest,
      commands: [{ ...manifest.commands[0], parameterTypes: "ix" }],
    }))).toMatchObject({ ok: false, code: "invalid-manifest" });
    expect(parseVisualExtensionManifest(" ".repeat(256 * 1024 + 1))).toMatchObject({ ok: false, code: "too-large" });
  });
});
