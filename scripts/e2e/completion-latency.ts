/**
 * Mesure de la latence percue de la completion dans l'application reelle (E2E). Partagee par `run.ts` (registre de test, trois
 * commandes) et `real-server-smoke.ts` (registre complet d'un vrai serveur).
 */
import type { Cdp } from "./cdp";

export interface CompletionLatency {
  /** Une ligne (contenant le libelle demande, s'il y en a un) est presente dans la liste. */
  rows: number;
  /** Cette ligne a une taille et n'est ni masquee (`visibility`) ni transparente : la liste est affichee. */
  shown: number;
  /** Classe `visible` du widget, que Monaco ajoute apres un delai fixe de 100 ms (`suggestWidget.js`, `_show`). */
  visible: number;
}

/** Une vraie touche, envoyee par le protocole de debogage (`modifiers` : 1 Alt, 2 Ctrl, 4 Meta, 8 Maj). */
export async function press(client: Cdp, key: string, code: string, virtualKey: number, modifiers = 0): Promise<void> {
  const common = { key, code, modifiers, windowsVirtualKeyCode: virtualKey };
  await client.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...common });
  await client.send("Input.dispatchKeyEvent", { type: "keyUp", ...common });
}

/** Ferme la liste de completion (Echap) et attend qu'elle ne soit plus visible. */
export async function closeCompletion(client: Cdp): Promise<void> {
  await press(client, "Escape", "Escape", 27);
  await client.waitFor(`![...document.querySelectorAll('.suggest-widget')].some((widget) => widget.classList.contains('visible'))`, "liste de completion fermee");
}

/**
 * Latence percue d'une completion, de l'evenement `keydown` de Ctrl+Espace (capture dans la page) jusqu'a trois etats de la liste
 * (fournisseur Monaco + Worker + service + construction de la liste). Mesures sur mutation du DOM, hors peinture (au plus une
 * image de plus). La liste doit etre fermee au depart ; sans `label`, n'importe quelle ligne convient.
 */
export async function measureCompletion(client: Cdp, label: string | null): Promise<CompletionLatency> {
  await client.evaluate(
    `(() => {
      const lat = { start: 0, rows: 0, shown: 0, visible: 0 };
      window.__latency = lat;
      const onKey = (event) => { if (event.code === 'Space' && event.ctrlKey && lat.start === 0) lat.start = performance.now(); };
      document.addEventListener('keydown', onKey, true);
      const label = ${JSON.stringify(label)};
      const rowOf = (selector) => [...document.querySelectorAll(selector)].find((row) => label === null || row.textContent.includes(label));
      const shown = (row) => {
        const rect = row.getBoundingClientRect();
        const style = getComputedStyle(row);
        return rect.width > 0 && rect.height > 0 && style.visibility === 'visible' && style.opacity !== '0';
      };
      const observer = new MutationObserver(() => {
        if (lat.start === 0) return;
        const row = rowOf('.suggest-widget .monaco-list-row');
        if (row === undefined) return;
        const now = performance.now();
        if (lat.rows === 0) lat.rows = now;
        if (lat.shown === 0 && shown(row)) lat.shown = now;
        if (lat.visible === 0 && rowOf('.suggest-widget.visible .monaco-list-row') !== undefined) lat.visible = now;
        if (lat.shown !== 0 && lat.visible !== 0) {
          observer.disconnect();
          document.removeEventListener('keydown', onKey, true);
        }
      });
      observer.observe(document.body, { childList: true, subtree: true, attributes: true, characterData: true });
    })()`,
  );
  await press(client, " ", "Space", 32, 2);
  await client.waitFor("window.__latency.shown > 0 && window.__latency.visible > 0", `liste de completion${label === null ? "" : ` avec ${label}`}`, 15_000);
  return await client.evaluate<CompletionLatency>(
    "({ rows: window.__latency.rows - window.__latency.start, shown: window.__latency.shown - window.__latency.start, visible: window.__latency.visible - window.__latency.start })",
  );
}

export const summarize = (values: readonly number[]): { min: number; median: number; max: number } => {
  const sorted = [...values].sort((a, b) => a - b);
  return { min: sorted[0] ?? 0, median: sorted[Math.floor(sorted.length / 2)] ?? 0, max: sorted[sorted.length - 1] ?? 0 };
};

export const ms = (value: number): string => (value < 10 ? value.toFixed(1) : value.toFixed(0));

export interface LatencyReport {
  first: CompletionLatency;
  warm: CompletionLatency[];
  /** Controleur -> Worker -> service -> reponse (sans Monaco). */
  roundTrips: number[];
}

/** Mesure une premiere liste puis `warmCount` autres ; chacune est refermee avant la suivante. */
export async function measureSeries(client: Cdp, label: string | null, warmCount: number): Promise<{ first: CompletionLatency; warm: CompletionLatency[] }> {
  const first = await measureCompletion(client, label);
  await closeCompletion(client);
  const warm: CompletionLatency[] = [];
  for (let index = 0; index < warmCount; index += 1) {
    warm.push(await measureCompletion(client, label));
    await closeCompletion(client);
  }
  return { first, warm };
}

/** Texte des deux lignes de compte rendu d'une serie (les valeurs sont en millisecondes). */
export function describeSeries(first: CompletionLatency, warm: readonly CompletionLatency[]): string[] {
  const rows = summarize(warm.map((sample) => sample.rows));
  const shown = summarize(warm.map((sample) => sample.shown));
  const visible = summarize(warm.map((sample) => sample.visible));
  return [
    `latence percue (Ctrl+Espace -> ...), 1re a froid : lignes ${ms(first.rows)} / affichee ${ms(first.shown)} / classe visible ${ms(first.visible)} ms`,
    `${warm.length} suivantes (min / mediane / max) : lignes ${ms(rows.min)} / ${ms(rows.median)} / ${ms(rows.max)} ; affichee ${ms(shown.min)} / ${ms(shown.median)} / ${ms(shown.max)} ; classe visible ${ms(visible.min)} / ${ms(visible.median)} / ${ms(visible.max)} ms`,
  ];
}

/** Controleur -> Worker -> service -> reponse, sans Monaco, pour une completion explicite (mot vide) a la position donnee. */
export async function measureRoundTrips(client: Cdp, controller: string, path: string, line: number, column: number, count: number): Promise<{ times: number[]; items: number }> {
  return await client.evaluate<{ times: number[]; items: number }>(
    `(async () => { const times = []; let items = 0; for (let i = 0; i < ${count}; i++) { const t0 = performance.now(); const result = await ${controller}.completionAt(${JSON.stringify(path)}, ${line}, ${column}, true); times.push(performance.now() - t0); items = result.length; } return { times, items }; })()`,
  );
}
