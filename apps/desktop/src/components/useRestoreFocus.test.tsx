// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useRestoreFocus } from "./useRestoreFocus";

/** Un panneau qui prend le focus a son affichage, comme la palette de commandes. */
function Panel() {
  useRestoreFocus();
  useEffect(() => {
    document.getElementById("inside")?.focus();
  }, []);
  return <input id="inside" aria-label="inside" />;
}

let origin: HTMLButtonElement;
let elsewhere: HTMLButtonElement;

beforeEach(() => {
  origin = document.createElement("button");
  elsewhere = document.createElement("button");
  document.body.append(origin, elsewhere);
  origin.focus();
});

afterEach(() => {
  cleanup();
  origin.remove();
  elsewhere.remove();
});

describe("useRestoreFocus", () => {
  it("rend le focus a l'element qui l'avait avant l'affichage, quand le composant disparait en le laissant perdu", () => {
    const { unmount } = render(<Panel />);
    expect(document.activeElement?.id).toBe("inside");
    unmount();
    expect(document.activeElement).toBe(origin);
  });

  it("ne reprend pas le focus quand il a ete place ailleurs avant la fermeture : l'action choisie l'a decide", () => {
    const { unmount } = render(<Panel />);
    elsewhere.focus();
    unmount();
    expect(document.activeElement).toBe(elsewhere);
  });

  it("ne tente pas de rendre le focus a un element qui n'est plus dans la page", () => {
    const { unmount } = render(<Panel />);
    origin.remove();
    unmount();
    expect(document.activeElement).toBe(document.body);
  });
});
