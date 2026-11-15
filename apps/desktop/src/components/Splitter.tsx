import { useRef } from "react";

interface SplitterProps {
  /** `vertical` : barre verticale qui redimensionne une largeur ; `horizontal` : barre horizontale qui redimensionne une hauteur. */
  readonly orientation: "vertical" | "horizontal";
  readonly value: number;
  readonly min: number;
  readonly max: number;
  readonly onChange: (value: number) => void;
  readonly label: string;
  /** Vrai si agrandir le panneau correspond a un deplacement vers la gauche/le haut (panneau du bas, par exemple). */
  readonly inverted?: boolean;
}

const KEY_STEP = 16;
const KEY_STEP_LARGE = 64;

/** Poignee de redimensionnement : souris/tactile (capture du pointeur) et clavier (fleches, Maj pour de grands pas). */
export function Splitter({ orientation, value, min, max, onChange, label, inverted = false }: SplitterProps) {
  const start = useRef<{ pointer: number; value: number } | null>(null);
  const vertical = orientation === "vertical";
  const clamp = (next: number): number => Math.min(max, Math.max(min, Math.round(next)));

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    event.currentTarget.setPointerCapture(event.pointerId);
    start.current = { pointer: vertical ? event.clientX : event.clientY, value };
  };
  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (start.current === null) return;
    const delta = (vertical ? event.clientX : event.clientY) - start.current.pointer;
    onChange(clamp(start.current.value + (inverted ? -delta : delta)));
  };
  const onPointerUp = (event: React.PointerEvent<HTMLDivElement>): void => {
    start.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    const step = event.shiftKey ? KEY_STEP_LARGE : KEY_STEP;
    const grow = vertical ? "ArrowRight" : "ArrowDown";
    const shrink = vertical ? "ArrowLeft" : "ArrowUp";
    let direction = 0;
    if (event.key === grow) direction = 1;
    else if (event.key === shrink) direction = -1;
    else if (event.key === "Home") return void onChange(min);
    else if (event.key === "End") return void onChange(max);
    if (direction === 0) return;
    event.preventDefault();
    onChange(clamp(value + (inverted ? -direction : direction) * step));
  };

  return (
    <div
      className={`splitter splitter-${orientation}`}
      role="separator"
      aria-orientation={vertical ? "vertical" : "horizontal"}
      aria-label={label}
      aria-valuenow={value}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onKeyDown={onKeyDown}
    />
  );
}
