import type { BackendApi } from "../services/backend";
import { toBackendError, type UpdateProgress } from "../services/types";
import type { AppStore, AvailableUpdate, UpdateFailure } from "../state/store";
import { isUpdateToken, updateFailureCode, updateLogCode } from "./update-text";

export interface UpdateControllerDeps {
  readonly backend: BackendApi;
  readonly store: AppStore;
  /** Des documents ont des modifications non enregistrees : l'application ne peut pas redemarrer. */
  readonly hasUnsavedChanges: () => boolean;
  /** Journal de diagnostic local (le coeur natif n'ecrit que si l'utilisateur l'a active) : des codes seulement. */
  readonly log: (level: "info" | "warn" | "error", code: string, detail?: string) => void;
}

function failureOf(error: unknown): UpdateFailure {
  const { code, payload } = toBackendError(error);
  return { code: updateFailureCode(code), minimum: payload.minimum, reason: payload.reason };
}

/**
 * Mises a jour signees (DEC-046). Chaque controle et chaque installation est lance par l'utilisateur : rien n'est contacte au
 * demarrage ni en arriere-plan. Le coeur natif decide de tout (signature du manifeste, empreinte, remplacement) ; ici, seulement
 * l'etat affiche et le jeton d'acces d'un depot prive.
 */
export class UpdateController {
  /** Jeton d'acces en lecture : en memoire seulement, jamais dans le store, les reglages ni le journal. */
  private token: string | null = null;

  constructor(private readonly deps: UpdateControllerDeps) {}

  /**
   * Retient le jeton d'acces (vide : il est oublie). Un jeton mal forme n'est pas retenu (`false`) : il ne partirait dans aucune
   * requete.
   */
  setToken(value: string): boolean {
    const trimmed = value.trim();
    if (trimmed !== "" && !isUpdateToken(trimmed)) {
      this.token = null;
      return false;
    }
    this.token = trimmed === "" ? null : trimmed;
    return true;
  }

  hasToken(): boolean {
    return this.token !== null;
  }

  private get busy(): boolean {
    const { status } = this.deps.store.getState().update;
    return status === "checking" || status === "installing" || status === "restarting";
  }

  /** Cherche une mise a jour dans les releases du depot choisi dans les reglages. */
  async check(): Promise<void> {
    if (this.busy) return;
    const { repository, channel } = this.deps.store.getState().settings.updates;
    this.deps.store.setState({ update: { status: "checking" } });
    try {
      const result = await this.deps.backend.updateCheck({ repository, channel, token: this.token });
      if (result.kind === "upToDate") {
        this.deps.store.setState({ update: { status: "up-to-date", current: result.current } });
        this.deps.log("info", "UPDATE_CHECK", "result=up_to_date");
      } else {
        this.deps.store.setState({ update: { status: "available", update: result, failure: null } });
        this.deps.log("info", "UPDATE_CHECK", "result=available");
      }
    } catch (error) {
      const failure = failureOf(error);
      this.deps.store.setState({ update: { status: "error", failure } });
      this.deps.log("error", "UPDATE_FAILED", `code=${updateLogCode(failure.code)}`);
    }
  }

  private onProgress(update: AvailableUpdate, progress: UpdateProgress): void {
    const current = this.deps.store.getState().update;
    if (current.status !== "installing" || current.update !== update) return;
    // Jamais en arriere : un evenement tardif ne fait pas reculer la barre.
    this.deps.store.setState({ update: { ...current, received: Math.max(current.received, progress.received), total: progress.total } });
  }

  /**
   * Telecharge puis installe la mise a jour trouvee par le dernier controle. Le coeur natif demande l'accord de l'utilisateur dans une
   * boite de dialogue du systeme, verifie l'empreinte du fichier, remplace l'executable puis redemarre l'application. Refuse tant que
   * des modifications ne sont pas enregistrees.
   */
  async install(): Promise<void> {
    const current = this.deps.store.getState().update;
    if (current.status !== "available") return;
    const update = current.update;
    if (this.deps.hasUnsavedChanges()) {
      this.deps.store.setState({ update: { status: "available", update, failure: { code: "unsaved_changes" } } });
      return;
    }
    let unsubscribe: (() => void) | null = null;
    try {
      unsubscribe = await this.deps.backend.onUpdateProgress((progress) => this.onProgress(update, progress));
    } catch {
      // Sans avancement la mise a jour fonctionne : seule la barre reste a zero.
    }
    this.deps.store.setState({ update: { status: "installing", update, received: 0, total: update.size } });
    this.deps.log("info", "UPDATE_INSTALL");
    try {
      await this.deps.backend.updateInstall({ token: this.token, locale: this.deps.store.getState().language });
      this.deps.store.setState({ update: { status: "restarting", update } });
    } catch (error) {
      const failure = failureOf(error);
      if (failure.code === "install_failed" && failure.reason === "cancelled") {
        // L'utilisateur a refuse dans la boite de dialogue du systeme : rien a signaler.
        this.deps.store.setState({ update: { status: "available", update, failure: null } });
      } else {
        this.deps.store.setState({ update: { status: "available", update, failure } });
        this.deps.log("error", "UPDATE_FAILED", `code=${updateLogCode(failure.code)}`);
      }
    } finally {
      unsubscribe?.();
    }
  }
}
