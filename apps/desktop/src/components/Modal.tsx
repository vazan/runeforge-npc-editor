import { useEffect, useId, useRef, type ReactNode } from "react";

/**
 * Les controles que Tab atteint : un controle a `tabindex="-1"` n'en fait pas partie (l'onglet inactif d'un jeu d'onglets a tabindex
 * mobile, par exemple). Sans cette exclusion le « premier » controle du dialogue pouvait etre un onglet que Tab saute, et Maj+Tab depuis
 * l'onglet actif sortait du piege (trouve par l'audit d'accessibilite sur l'onglet « Mises a jour » des parametres).
 */
const NOT_SKIPPED = ':not([tabindex="-1"])';
const FOCUSABLE = [
  `a[href]${NOT_SKIPPED}`,
  `button:not([disabled])${NOT_SKIPPED}`,
  `input:not([disabled])${NOT_SKIPPED}`,
  `select:not([disabled])${NOT_SKIPPED}`,
  `textarea:not([disabled])${NOT_SKIPPED}`,
  `summary${NOT_SKIPPED}`,
  `[tabindex]${NOT_SKIPPED}`,
].join(", ");

/**
 * Tab n'atteint pas le contenu d'un `<details>` ferme, seulement son resume. Sans ce tri, le « premier » controle du dialogue
 * pouvait etre un champ invisible : le focus initial n'entrait pas dans le dialogue et Maj+Tab sortait du piege.
 */
function reachable(element: HTMLElement): boolean {
  for (let node = element.parentElement; node !== null; node = node.parentElement) {
    if (node instanceof HTMLDetailsElement && !node.open && !(element.tagName === "SUMMARY" && element.parentElement === node)) return false;
  }
  return true;
}

const focusableIn = (root: HTMLElement | null): HTMLElement[] => [...(root?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])].filter(reachable);

interface ModalProps {
  readonly title: string;
  readonly children: ReactNode;
  /** Boutons d'action (alignes a droite). */
  readonly actions: ReactNode;
  /** Appele par Echap ; `undefined` rend le dialogue impossible a fermer sans choisir une action. */
  readonly onDismiss?: (() => void) | undefined;
  readonly wide?: boolean;
  /** Plus large encore (un canevas de noeuds) ; implique `wide`. */
  readonly extraWide?: boolean;
}

/**
 * Dialogue modal accessible : `role="dialog"`, titre associe, focus pris a l'ouverture, Tab pieges dans le dialogue,
 * focus rendu a l'element precedent a la fermeture.
 */
export function Modal({ title, children, actions, onDismiss, wide = false, extraWide = false }: ModalProps) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = dialogRef.current;
    const first = dialog?.querySelector<HTMLElement>("[data-autofocus]") ?? focusableIn(dialog)[0];
    (first ?? dialog)?.focus();
    return () => previous?.focus();
  }, []);

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === "Escape" && onDismiss !== undefined) {
      event.stopPropagation();
      onDismiss();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = focusableIn(dialogRef.current);
    if (focusable.length === 0) return;
    const first = focusable[0] as HTMLElement;
    const last = focusable[focusable.length - 1] as HTMLElement;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <div className="modal-backdrop">
      <div
        ref={dialogRef}
        className={extraWide ? "modal modal-wide modal-xwide" : wide ? "modal modal-wide" : "modal"}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        <h2 id={titleId} className="modal-title">
          {title}
        </h2>
        <div className="modal-body">{children}</div>
        <div className="modal-actions">{actions}</div>
      </div>
    </div>
  );
}
