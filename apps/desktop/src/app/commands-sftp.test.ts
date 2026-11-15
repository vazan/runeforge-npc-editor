import { describe, expect, it } from "vitest";
import { en, fr, translate } from "../i18n/messages";
import { COMMANDS } from "./commands";

describe("SFTP command messages", () => {
  it.each(["en", "fr"] as const)("has a translated title in %s", (language) => {
    const command = COMMANDS.find((entry) => entry.id === "sftpPreview");
    expect(command).toBeDefined();
    if (command === undefined) throw new Error("Missing SFTP command");
    expect((language === "en" ? en : fr)[command.title]).toEqual(expect.any(String));
    expect(translate(language, command.title)).not.toBe(command.title);
  });
});
