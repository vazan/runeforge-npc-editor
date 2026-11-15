import { useEffect } from "react";

/**
 * Rend le focus a l'element qui l'avait avant l'affichage du composant, quand celui-ci disparait (WCAG 2.4.3) — sauf si le focus a
 * ete place ailleurs entre-temps, par exemple par l'action choisie dans une palette : il n'est alors pas repris.
 *
 * A appeler avant tout effet du composant qui prend le focus, pour que l'element d'origine soit celui d'avant l'affichage.
 */
export function useRestoreFocus(): void {
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return () => {
      const active = document.activeElement;
      if (active === null || active === document.body) previous?.focus();
    };
  }, []);
}
