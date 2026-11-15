/**
 * Client minimal du protocole de debogage Chrome (CDP) pour piloter la fenetre WebView2 de l'application reelle.
 * Windows uniquement (WebView2 expose CDP via `--remote-debugging-port`). Aucune dependance externe.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { writeFileSync } from "node:fs";

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export interface LaunchOptions {
  readonly exe: string;
  readonly port: number;
  readonly webviewDataDir: string;
  readonly env: Record<string, string>;
}

export class AppProcess {
  private exitCode: number | null = null;

  constructor(private readonly child: ChildProcess) {
    child.on("exit", (code) => {
      this.exitCode = code ?? -1;
    });
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  get running(): boolean {
    return this.exitCode === null;
  }

  /** Arret brutal de l'arbre de processus (simule un plantage : aucun gestionnaire de fermeture n'est execute). */
  kill(): void {
    if (this.child.pid !== undefined && this.exitCode === null) {
      spawnSync("taskkill", ["/PID", String(this.child.pid), "/T", "/F"], { stdio: "ignore" });
    }
  }
}

export function launch(options: LaunchOptions): AppProcess {
  const child = spawn(options.exe, [], {
    env: {
      ...process.env,
      ...options.env,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${options.port}`,
      WEBVIEW2_USER_DATA_FOLDER: options.webviewDataDir,
    },
    stdio: "ignore",
  });
  return new AppProcess(child);
}

export class Cdp {
  private nextId = 1;
  private readonly pending = new Map<number, (message: { result?: unknown; error?: { message: string } }) => void>();
  readonly consoleErrors: string[] = [];

  private constructor(private readonly socket: WebSocket) {
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as {
        id?: number;
        method?: string;
        result?: unknown;
        error?: { message: string };
        params?: { entry?: { level: string; text: string }; exceptionDetails?: { text: string; exception?: { description?: string } } };
      };
      if (message.id !== undefined) {
        this.pending.get(message.id)?.(message);
        this.pending.delete(message.id);
      } else if (message.method === "Log.entryAdded" && message.params?.entry?.level === "error") {
        this.consoleErrors.push(message.params.entry.text);
      } else if (message.method === "Runtime.exceptionThrown") {
        this.consoleErrors.push(message.params?.exceptionDetails?.exception?.description ?? message.params?.exceptionDetails?.text ?? "exception");
      }
    });
  }

  static async connect(port: number, timeoutMs = 40_000, pollMs = 400): Promise<Cdp> {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      try {
        const targets = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()) as { type: string; webSocketDebuggerUrl: string }[];
        const page = targets.find((target) => target.type === "page");
        if (page !== undefined) {
          const socket = new WebSocket(page.webSocketDebuggerUrl);
          await new Promise<void>((resolve, reject) => {
            socket.addEventListener("open", () => resolve(), { once: true });
            socket.addEventListener("error", () => reject(new Error("echec de connexion CDP")), { once: true });
          });
          const cdp = new Cdp(socket);
          await cdp.send("Runtime.enable");
          await cdp.send("Log.enable");
          await cdp.send("Page.enable");
          return cdp;
        }
      } catch {
        // WebView2 pas encore pret
      }
      await sleep(pollMs);
    }
    throw new Error(`aucune fenetre WebView2 sur le port ${port} apres ${timeoutMs} ms`);
  }

  /**
   * Envoie une commande CDP. Sans reponse au bout de `timeoutMs`, la commande echoue : une promesse de la page qui ne se resout
   * jamais (par exemple `navigator.clipboard.readText()` qui attend une autorisation) ne doit pas suspendre tout le scenario.
   */
  send<T = unknown>(method: string, params: Record<string, unknown> = {}, timeoutMs = 90_000): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method}: aucune reponse apres ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.set(id, (message) => {
        clearTimeout(timer);
        if (message.error !== undefined) reject(new Error(`${method}: ${message.error.message}`));
        else resolve(message.result as T);
      });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  /** Evalue une expression dans la page (les promesses sont attendues). */
  async evaluate<T = unknown>(expression: string): Promise<T> {
    const response = await this.send<{ result: { value?: T }; exceptionDetails?: { text: string; exception?: { description?: string } } }>("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (response.exceptionDetails !== undefined) {
      throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text);
    }
    return response.result.value as T;
  }

  /** Attend qu'une expression devienne vraie. */
  async waitFor(expression: string, description: string, timeoutMs = 15_000): Promise<void> {
    const started = Date.now();
    let last: unknown;
    while (Date.now() - started < timeoutMs) {
      try {
        last = await this.evaluate(expression);
        if (last) return;
      } catch (error) {
        last = error instanceof Error ? error.message : String(error);
      }
      await sleep(150);
    }
    throw new Error(`delai depasse : ${description} (derniere valeur : ${JSON.stringify(last)})`);
  }

  /** Saisie reelle de texte dans l'element qui a le focus (chemin identique a une frappe utilisateur). */
  async insertText(text: string): Promise<void> {
    await this.send("Input.insertText", { text });
  }

  /** Raccourci clavier reel. `modifiers` : 1 Alt, 2 Ctrl, 4 Meta, 8 Maj. */
  async press(key: string, code: string, modifiers = 0): Promise<void> {
    const common = { key, code, modifiers, windowsVirtualKeyCode: key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0 };
    await this.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...common });
    await this.send("Input.dispatchKeyEvent", { type: "keyUp", ...common });
  }

  async screenshot(path: string): Promise<void> {
    const shot = await this.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
    writeFileSync(path, Buffer.from(shot.data, "base64"));
  }

  close(): void {
    this.socket.close();
  }
}
