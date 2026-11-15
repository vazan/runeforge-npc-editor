import { createContext, useContext, useMemo, type ComponentType, type ReactNode } from "react";
import { useStore } from "zustand";
import { translate, type MessageKey } from "../i18n/messages";
import type { AppState, AppStore } from "../state/store";
import type { AppController } from "./controller";

export interface EditorSurfaceProps {
  readonly path: string;
}

export interface DiffSurfaceProps {
  readonly original: string;
  readonly modified: string;
  readonly originalLabel: string;
  readonly modifiedLabel: string;
}

/**
 * Surfaces d'edition injectees : Monaco en production, doublures simples dans les tests de composants
 * (Monaco ne s'execute pas dans jsdom).
 */
export interface Surfaces {
  readonly Editor: ComponentType<EditorSurfaceProps>;
  readonly Diff: ComponentType<DiffSurfaceProps>;
}

export interface AppServices {
  readonly controller: AppController;
  readonly store: AppStore;
  readonly surfaces: Surfaces;
}

const ServicesContext = createContext<AppServices | null>(null);

export function ServicesProvider({ services, children }: { readonly services: AppServices; readonly children: ReactNode }) {
  return <ServicesContext.Provider value={services}>{children}</ServicesContext.Provider>;
}

export function useServices(): AppServices {
  const services = useContext(ServicesContext);
  if (services === null) throw new Error("ServicesProvider manquant");
  return services;
}

export function useController(): AppController {
  return useServices().controller;
}

/** Lit une partie de l'etat ; le composant ne se re-rend que si la valeur selectionnee change. */
export function useAppState<T>(selector: (state: AppState) => T): T {
  return useStore(useServices().store, selector);
}

export type Translate = (key: MessageKey, params?: Readonly<Record<string, string | number>>) => string;

export function useT(): Translate {
  const language = useAppState((state) => state.language);
  return useMemo<Translate>(() => (key, params) => translate(language, key, params), [language]);
}
