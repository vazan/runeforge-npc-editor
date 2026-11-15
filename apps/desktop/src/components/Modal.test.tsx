// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Modal } from "./Modal";

afterEach(() => {
  cleanup();
});

/** Un dialogue entre deux boutons de la page : si le piege laisse sortir le focus, il atterrit sur l'un d'eux. */
function renderWithTabs(onDismiss?: () => void) {
  return render(
    <>
      <button type="button">Before</button>
      <Modal title="Settings" onDismiss={onDismiss} actions={<button type="button">Close</button>}>
        <div role="tablist" aria-label="Sections">
          <button type="button" role="tab" tabIndex={-1} aria-selected={false}>
            One
          </button>
          <button type="button" role="tab" tabIndex={0} aria-selected>
            Two
          </button>
          <button type="button" role="tab" tabIndex={-1} aria-selected={false}>
            Three
          </button>
        </div>
        <input aria-label="Field" />
      </Modal>
      <button type="button">After</button>
    </>,
  );
}

describe("Modal : piege du focus", () => {
  it("Maj+Tab depuis l'onglet actif, qui n'est pas le premier bouton, reste dans le dialogue (tabindex mobile)", async () => {
    renderWithTabs();
    const user = userEvent.setup();
    screen.getByRole("tab", { name: "Two" }).focus();
    await user.tab({ shift: true });
    // Le premier controle que Tab atteint est l'onglet actif lui-meme : le piege revient au dernier, jamais « Before ».
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Close" }));
  });

  it("Tab depuis le dernier controle revient au premier controle atteignable, pas a la page", async () => {
    renderWithTabs();
    const user = userEvent.setup();
    screen.getByRole("button", { name: "Close" }).focus();
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: "Two" }));
  });

  it("parcourt les onglets inactifs sans les compter comme des arrets", async () => {
    renderWithTabs();
    const user = userEvent.setup();
    screen.getByRole("tab", { name: "Two" }).focus();
    const visited: string[] = [];
    for (let press = 0; press < 6; press += 1) {
      await user.tab();
      visited.push((document.activeElement as HTMLElement).getAttribute("aria-label") ?? document.activeElement?.textContent ?? "?");
    }
    expect(visited).toEqual(["Field", "Close", "Two", "Field", "Close", "Two"]);
  });

  it("prend le focus a l'ouverture, sur le premier controle atteignable, et le rend a la fermeture", () => {
    const before = document.createElement("button");
    document.body.append(before);
    before.focus();
    const { unmount } = renderWithTabs();
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: "Two" }));
    unmount();
    expect(document.activeElement).toBe(before);
    before.remove();
  });

  it("Echap appelle la fermeture, et ne fait rien sans elle", async () => {
    const onDismiss = vi.fn();
    const { unmount } = renderWithTabs(onDismiss);
    const user = userEvent.setup();
    screen.getByRole("tab", { name: "Two" }).focus();
    await user.keyboard("{Escape}");
    expect(onDismiss).toHaveBeenCalledTimes(1);
    unmount();
    renderWithTabs();
    screen.getByRole("tab", { name: "Two" }).focus();
    await user.keyboard("{Escape}");
    expect(screen.getByRole("dialog")).toBeTruthy();
  });
});
