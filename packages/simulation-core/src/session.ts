import type { NpcDeclaration } from "@runeforge/runescript-parser";
import { SHOWN_ELSEWHERE } from "./parameters";
import { Runtime } from "./runtime";
import type { Outcome, Pause, Script, SimValue, SimulationContext, SimulationView, SimulationWorld, State } from "./types";

/** Longueur maximale d'un texte saisi : au-delà, la saisie est refusée. */
export const MAX_INPUT_LENGTH = 255;

function accepts(pause: Extract<Pause, { kind: "input" }>, response: SimValue | undefined): boolean {
  return pause.numeric
    ? typeof response === "number" && Number.isSafeInteger(response)
    : typeof response === "string" && response.length <= MAX_INPUT_LENGTH;
}

/** Environnement isolé. Une session ne touche ni les fichiers ni le serveur. */
export class SimulationSession {
  private readonly runtime: Runtime;
  private readonly execution: Script<Outcome>;
  private state: State = { kind: "ready" };

  constructor(npc: NpcDeclaration, context: SimulationContext, world: SimulationWorld = {}) {
    this.runtime = new Runtime(npc, context, world);
    this.execution = this.runtime.run();
  }

  /**
   * Avance jusqu'à la prochaine attente du joueur. `response` répond à l'attente en cours : le numéro d'une option, ou la
   * valeur saisie. Une réponse que l'attente n'accepte pas est ignorée.
   */
  advance(response?: SimValue): SimulationView {
    const state = this.state;
    if (
      state.kind === "ready" ||
      state.kind === "page" ||
      (state.kind === "choice" && state.options.some((option) => option.value === response)) ||
      (state.kind === "input" && accepts(state, response))
    ) {
      this.state = this.execution.next(response).value;
    }
    return this.view();
  }

  view(): SimulationView {
    const transcript = [...this.runtime.transcript];
    return {
      state: this.state,
      messages: transcript.flatMap((entry) => (entry.kind === "mes" ? [entry.text] : [])),
      transcript,
      variables: new Map([...this.runtime.variables()].filter(([name]) => !SHOWN_ELSEWHERE.has(name))),
      zeny: this.runtime.zeny,
      items: new Map([...this.runtime.items].filter(([, quantity]) => quantity > 0)),
      quests: new Map(this.runtime.quests),
    };
  }

  /** Mots nus lus sans valeur connue (variables non écrites ou constantes absentes du catalogue) : sert aux mesures. */
  unresolvedNames(): ReadonlySet<string> {
    return this.runtime.unresolved;
  }
}
