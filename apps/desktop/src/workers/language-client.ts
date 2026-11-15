import type { LanguageService } from "../app/controller";
import type { IndexFileInput, LanguageMethod, LanguageMethods, LanguageRequest, LanguageResponse } from "./protocol";

interface WorkerLike {
  postMessage(message: LanguageRequest): void;
  onmessage: ((event: MessageEvent<LanguageResponse>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  terminate(): void;
}

/**
 * Client du worker de langage (cree a la premiere requete). Les requetes sont independantes et resolues par
 * identifiant ; une panne du worker rejette toutes les requetes en attente et le worker est recree a la suivante.
 */
export class LanguageClient implements LanguageService {
  private worker: WorkerLike | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();

  constructor(private readonly createWorker: () => WorkerLike) {}

  private ensureWorker(): WorkerLike {
    if (this.worker !== null) return this.worker;
    const worker = this.createWorker();
    worker.onmessage = (event) => {
      const response = event.data;
      const entry = this.pending.get(response.id);
      if (entry === undefined) return;
      this.pending.delete(response.id);
      if (response.ok) entry.resolve(response.result);
      else entry.reject(new Error(response.error));
    };
    worker.onerror = () => {
      for (const entry of this.pending.values()) entry.reject(new Error("language worker failed"));
      this.pending.clear();
      worker.terminate();
      this.worker = null;
    };
    this.worker = worker;
    return worker;
  }

  request<M extends LanguageMethod>(method: M, params: LanguageMethods[M]["params"]): Promise<LanguageMethods[M]["result"]> {
    const worker = this.ensureWorker();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      worker.postMessage({ id, method, params } as LanguageRequest);
    });
  }

  analyze(path: string, version: number, text: string) {
    return this.request("analyze", { uri: path, version, text });
  }

  closeDocument(path: string) {
    return this.request("closeDocument", { uri: path }).then(() => undefined);
  }

  definition(path: string, position: { line: number; character: number }) {
    return this.request("definition", { uri: path, position });
  }

  references(path: string, position: { line: number; character: number }, includeDeclaration: boolean) {
    return this.request("references", { uri: path, position, includeDeclaration });
  }

  documentSymbols(path: string) {
    return this.request("documentSymbols", { uri: path });
  }

  completion(path: string, position: { line: number; character: number }, explicit = false) {
    return this.request("completion", { uri: path, position, explicit });
  }

  signatureHelp(path: string, position: { line: number; character: number }) {
    return this.request("signatureHelp", { uri: path, position });
  }

  commandInfo(name: string) {
    return this.request("commandInfo", { name });
  }

  hover(path: string, position: { line: number; character: number }) {
    return this.request("hover", { uri: path, position });
  }

  prepareRename(path: string, position: { line: number; character: number }) {
    return this.request("prepareRename", { uri: path, position });
  }

  rename(path: string, position: { line: number; character: number }, newName: string) {
    return this.request("rename", { uri: path, position, newName });
  }

  workspaceSymbols(query: string, limit: number) {
    return this.request("workspaceSymbols", { query, limit });
  }

  diagnostics(path: string) {
    return this.request("diagnostics", { uri: path });
  }

  projectDiagnostics() {
    return this.request("projectDiagnostics", {});
  }

  previewDiagnostics(text: string) {
    return this.request("previewDiagnostics", { text });
  }

  projectReport(options: { only?: string[] | null } = {}) {
    return this.request("projectReport", options);
  }

  indexFiles(files: IndexFileInput[], legacyEncoding: string) {
    return this.request("indexFiles", { files, legacyEncoding });
  }

  removeFiles(paths: string[]) {
    return this.request("removeFiles", { uris: paths }).then(() => undefined);
  }

  clearIndex() {
    return this.request("clearIndex", {}).then(() => undefined);
  }

  setOptions(options: LanguageMethods["setOptions"]["params"]) {
    return this.request("setOptions", options).then(() => undefined);
  }

  setLoadOrder(files: readonly string[] | null) {
    return this.request("setLoadOrder", { files: files === null ? null : [...files] }).then(() => undefined);
  }

  setCommandSources(sources: LanguageMethods["setCommandSources"]["params"]) {
    return this.request("setCommandSources", sources);
  }

  setReferenceSources(sources: LanguageMethods["setReferenceSources"]["params"]) {
    return this.request("setReferenceSources", sources);
  }

  searchReferences(kind: LanguageMethods["searchReferences"]["params"]["kind"], query: string, limit: number) {
    return this.request("searchReferences", { kind, query, limit });
  }

  stats() {
    return this.request("stats", {});
  }

  dispose(): void {
    this.worker?.terminate();
    this.worker = null;
    this.pending.clear();
  }
}
