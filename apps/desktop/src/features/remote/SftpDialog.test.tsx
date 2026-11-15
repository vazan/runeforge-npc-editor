// @vitest-environment jsdom
import { act, cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { COMMANDS } from "../../app/commands";
import { renderApp } from "../../test/render-app";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
afterEach(() => { cleanup(); vi.resetAllMocks(); });

async function open() {
  const h = renderApp({ files: { "npc/test.txt": "script on disk" } });
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: /open a project folder/i }));
  await screen.findByRole("tree");
  act(() => { COMMANDS.find((entry) => entry.id === "sftpPreview")?.run(h.controller); });
  return { h, user, dialog: await screen.findByRole("dialog", { name: "SFTP preview…" }) };
}

async function fill(dialog: HTMLElement, user: ReturnType<typeof userEvent.setup>) {
  await user.type(within(dialog).getByLabelText("Host"), "server.example");
  await user.type(within(dialog).getByLabelText("Username"), "preview-user");
  await user.type(within(dialog).getByLabelText("Pinned host public key (ssh-ed25519)"), "ssh-ed25519 TEST_PUBLIC_KEY");
  await user.type(within(dialog).getByLabelText("Remote directory"), "/server/npc");
  await user.type(within(dialog).getByLabelText("Saved script paths (one per line)"), "npc/test.txt");
}

describe("SFTP preview through DialogHost", () => {
  it("connects only on explicit action and displays the read-only comparison", async () => {
    const { h, user, dialog } = await open();
    expect(invoke).not.toHaveBeenCalled();
    const compare = within(dialog).getByRole("button", { name: "Compare saved files" });
    expect((compare as HTMLButtonElement).disabled).toBe(true);
    await fill(dialog, user);
    expect(invoke).not.toHaveBeenCalled();
    invoke.mockResolvedValue({ files: [
      { path: "npc/test.txt", local: { size: 14, sha256: "local" }, remote: null },
      { path: "npc/same.txt", local: { size: 4, sha256: "same" }, remote: { size: 4, sha256: "same" } },
      { path: "npc/changed.txt", local: { size: 7, sha256: "new" }, remote: { size: 3, sha256: "old" } },
    ] });
    await user.click(compare);
    expect(invoke).toHaveBeenCalledExactlyOnceWith("sftp_dry_run", {
      rootId: h.backend.root.id, locale: "en", paths: ["npc/test.txt"],
      target: { host: "server.example", port: 22, username: "preview-user", hostKey: "ssh-ed25519 TEST_PUBLIC_KEY", directory: "/server/npc" },
    });
    expect(await within(dialog).findByText("Missing remotely")).toBeTruthy();
    expect(within(dialog).getByText("Identical")).toBeTruthy();
    expect(within(dialog).getByText("Different")).toBeTruthy();
    expect(h.backend.textOf("npc/test.txt")).toBe("script on disk");
    await user.click(within(dialog).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it.each(["cancelled", "connection_failed"])("reports %s without leaking backend details or stale results", async (code) => {
    const { user, dialog } = await open();
    await fill(dialog, user);
    invoke.mockResolvedValueOnce({ files: [{ path: "npc/test.txt", local: { size: 14, sha256: "local" }, remote: null }] });
    const compare = within(dialog).getByRole("button", { name: "Compare saved files" });
    await user.click(compare);
    await within(dialog).findByText("Missing remotely");
    invoke.mockRejectedValueOnce({ code, message: "PRIVATE_BACKEND_DETAIL" });
    await user.click(compare);
    expect(await within(dialog).findByRole("alert")).toBeTruthy();
    expect(within(dialog).queryByText("Missing remotely")).toBeNull();
    expect(dialog.textContent).not.toContain("PRIVATE_BACKEND_DETAIL");
    expect(invoke).toHaveBeenCalledTimes(2);
  });
});
