/**
 * Worker de langage « en processus » pour les tests : execute le vrai repartiteur (donc le vrai service de langage) dans
 * le meme fil et repond de facon asynchrone, comme le ferait un Worker. N'est importe que par les tests.
 */
import { createDispatcher } from "../workers/dispatch";
import { LanguageClient } from "../workers/language-client";
import type { LanguageRequest, LanguageResponse } from "../workers/protocol";

export class InProcessWorker {
  onmessage: ((event: MessageEvent<LanguageResponse>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  terminated = false;
  readonly sent: LanguageRequest[] = [];

  constructor(private readonly dispatcher = createDispatcher()) {}

  postMessage(message: LanguageRequest): void {
    this.sent.push(message);
    const response = this.dispatcher.handle(message);
    queueMicrotask(() => this.onmessage?.({ data: response } as MessageEvent<LanguageResponse>));
  }

  terminate(): void {
    this.terminated = true;
  }
}

/** Client de langage branche sur un worker en processus. */
export function inProcessLanguage(): { client: LanguageClient; worker: InProcessWorker } {
  const worker = new InProcessWorker(createDispatcher(undefined, { includeRathenaLibrary: true }));
  return { client: new LanguageClient(() => worker), worker };
}
