/**
 * Worker de langage : analyse les documents et indexe le projet hors du fil de l'interface (CLAUDE.md 8.1). Pur : il ne
 * fait que parser et analyser du texte recu par messages (aucune execution, aucun acces reseau ni fichier).
 */
import { createDispatcher } from "./dispatch";
import type { LanguageRequest, LanguageResponse } from "./protocol";

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<LanguageRequest>) => void) | null;
  postMessage(message: LanguageResponse): void;
};

const dispatcher = createDispatcher(undefined, { includeRathenaLibrary: true });

scope.onmessage = (event) => {
  scope.postMessage(dispatcher.handle(event.data));
};
