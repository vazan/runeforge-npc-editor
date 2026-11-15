/**
 * Editeur visuel de dialogues (M7, RF-020 a RF-023) confronte a un corpus reel de scripts : la lecture en blocs et les modifications
 * ciblees ne perdent-elles, ne deplacent-elles et ne reecrivent-elles rien ?
 *
 * Usage : node --import tsx scripts/visual-report.ts --server-root <racine du serveur> --entry npc/re/scripts_main.conf [--blocks N] [--npcs N]
 *         node --import tsx scripts/visual-report.ts <dossier> [--blocks N] [--npcs N]
 *
 * Lecture seule (les textes sont modifies en memoire, jamais ecrits). Pour chaque NPC a corps ferme :
 * 1. **lecture** : les plages des blocs sont dans le corps, ordonnees, sans chevauchement ; un bloc brut porte exactement son texte
 *    source ; le texte d'un `mes` est un litteral de chaine entre guillemets ;
 * 2. **identite** : redonner a un `mes` son texte, ou a un `if` sa condition, ne modifie rien ;
 * 3. **insertion puis suppression** du bloc insere (apres / avant chaque bloc echantillonne) : le texte revient a l'octet pres ;
 * 4. **deplacement puis retour** : idem ;
 * 5. **modification du texte puis retour** d'un `mes` : idem quand le litteral d'origine est ecrit comme l'editeur l'ecrirait ;
 * 6. **suppression directe et confinement** : chaque modification reussie ne touche que le corps de son NPC et garde les blocs bruts
 *    et commentaires intacts au caractere pres.
 * Un refus (`not-alone-on-line`, `locked`...) n'est pas un defaut : c'est le contrat. Une violation d'un des points ci-dessus l'est.
 *
 * Chaque modification relit le fichier entier (deux analyses) : tous les NPC sont LUS (point 1) mais seuls `--npcs` NPC par fichier
 * (le premier, ceux du milieu, le dernier ; 3 par defaut) et `--blocks` blocs par NPC (6 par defaut) sont MODIFIES (points 2 a 6).
 */
import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { normalizeToLf, tokenize } from "@runeforge/runescript-core";
import { parse } from "@runeforge/runescript-parser";
import {
  applyAction,
  generateBlock,
  importNpc,
  planEdit,
  quote,
  scriptNpcs,
  walkBlocks,
  type ApplyResult,
  type EditFailure,
  type NewBlock,
  type VisualAction,
  type VisualBlock,
  type VisualNpc,
} from "@runeforge/visual-core";
import { loadCorpus, parseCommandLine, CORPUS_USAGE } from "./lib/corpus";

const cli = parseCommandLine(process.argv.slice(2), ["--blocks", "--npcs"]);
const corpus = loadCorpus(cli);
if (corpus === undefined) {
  console.error(`Usage : node --import tsx scripts/visual-report.ts <dossier> | --server-root <racine> --entry <conf> [--blocks N]\n${CORPUS_USAGE}`);
  process.exit(2);
}
/** Blocs echantillonnes par NPC (les premiers, les derniers et quelques-uns du milieu) : borne le cout des gros NPC. */
const blockBudget = Math.max(2, Math.floor(Number(cli.value("--blocks")) || 6));
/** NPC modifies par fichier. */
const npcBudget = Math.max(1, Math.floor(Number(cli.value("--npcs")) || 3));

const NEW_BLOCKS: readonly NewBlock[] = [{ kind: "mes", text: "Inserted" }, { kind: "next" }, { kind: "close" }];

interface Violation {
  readonly file: string;
  readonly npc: string;
  readonly check: string;
  readonly detail: string;
}

const violations: Violation[] = [];
const violate = (file: string, npc: string, check: string, detail: string): void => {
  violations.push({ file, npc, check, detail });
};

const refused = new Map<EditFailure, number>();
const note = (reason: EditFailure): void => {
  refused.set(reason, (refused.get(reason) ?? 0) + 1);
};

const totals = {
  files: 0,
  npcs: 0,
  noBody: 0,
  full: 0,
  partial: 0,
  unsupported: 0,
  blocks: new Map<string, number>(),
  literals: 0,
  mutatedNpcs: 0,
  nonCanonicalLiterals: 0,
  inserts: 0,
  moves: 0,
  texts: 0,
  removals: 0,
  applied: 0,
};
const bump = (map: Map<string, number>, key: string): void => {
  map.set(key, (map.get(key) ?? 0) + 1);
};

const rawTexts = (npc: VisualNpc): string[] => {
  const texts: string[] = [];
  walkBlocks(npc.blocks, (block) => {
    if (block.kind === "raw") texts.push(block.text);
  });
  return texts;
};

/** L'ordre des commentaires peut changer quand ils se deplacent avec un bloc. */
function comments(text: string, npc: VisualNpc): string[] {
  return tokenize(text.slice(npc.bodyRange.start, npc.bodyRange.end))
    .filter((token) => token.kind === "BlockComment" || token.kind === "LineComment")
    .map((token) => token.text)
    .sort();
}

/** Les blocs a mettre a l'epreuve : tous quand il y en a peu, sinon les premiers et les derniers. */
function sample(blocks: readonly VisualBlock[]): VisualBlock[] {
  const all: VisualBlock[] = [];
  walkBlocks(blocks, (block) => all.push(block));
  if (all.length <= blockBudget) return all;
  const picked = new Set<number>();
  const half = Math.floor(blockBudget / 2);
  for (let i = 0; i < half; i += 1) picked.add(i);
  for (let i = 0; i < blockBudget - half; i += 1) picked.add(all.length - 1 - i);
  return [...picked].sort((a, b) => a - b).map((index) => all[index] as VisualBlock);
}

const siblingId = (id: string, delta: number): string => {
  const parts = id.split(".");
  parts[parts.length - 1] = String(Number(parts[parts.length - 1]) + delta);
  return parts.join(".");
};

const started = performance.now();

for (const file of corpus.files) {
  const text = normalizeToLf(readFileSync(file.path).toString("latin1"));
  totals.files += 1;
  const parsed = parse(text);
  const declarations = scriptNpcs(parsed);
  // Les NPC dont on essaie les modifications : le premier, le dernier et ceux du milieu, repartis regulierement.
  const mutated = new Set<number>();
  for (let n = 0; n < Math.min(npcBudget, declarations.length); n += 1) {
    mutated.add(npcBudget >= declarations.length ? n : Math.round((n * (declarations.length - 1)) / Math.max(1, npcBudget - 1)));
  }
  if (totals.files % 200 === 0) process.stderr.write(`  ${totals.files} / ${corpus.files.length} fichiers, ${((performance.now() - started) / 1000).toFixed(0)} s\n`);
  for (const [position, declaration] of declarations.entries()) {
    const npc = importNpc(text, declaration);
    const name = declaration.name.display;
    if (npc === null) {
      totals.noBody += 1;
      continue;
    }
    totals.npcs += 1;
    totals[npc.status] += 1;
    const where = (check: string, detail: string): void => violate(file.uri, name, check, detail);

    // 1. Lecture : plages, ordre, texte brut.
    const checkList = (blocks: readonly VisualBlock[], low: number, high: number): void => {
      let previousEnd = low;
      for (const block of blocks) {
        bump(totals.blocks, block.kind);
        if (block.range.start < previousEnd || block.range.end > high || block.range.end < block.range.start) {
          where("lecture", `plage ${block.range.start}-${block.range.end} hors de ${previousEnd}-${high} (bloc ${block.id})`);
        }
        previousEnd = block.range.end;
        if (block.kind === "raw" && text.slice(block.range.start, block.range.end) !== block.text) where("lecture", `bloc brut ${block.id} different du texte source`);
        if (block.kind === "mes") {
          const literal = text.slice(block.textRange.start, block.textRange.end);
          totals.literals += 1;
          if (!literal.startsWith('"') || !literal.endsWith('"')) where("lecture", `litteral de ${block.id} sans guillemets : ${literal.slice(0, 40)}`);
          if (quote(block.text) !== literal) totals.nonCanonicalLiterals += 1;
        }
        if (block.kind === "if") {
          checkList(block.then, block.range.start, block.range.end);
          if (block.else !== null) checkList(block.else, block.range.start, block.range.end);
        }
      }
    };
    checkList(npc.blocks, npc.bodyRange.start, npc.bodyRange.end);
    if (!mutated.has(position)) continue;
    totals.mutatedNpcs += 1;

    // Apres une premiere action, les plages de son resultat remplacent celles de la declaration d'origine.
    const attempt = (label: string, current: string, before: VisualNpc, action: VisualAction): Extract<ApplyResult, { ok: true }> | null => {
      const result = applyAction(current, declaration.range.start, action);
      if (!result.ok) {
        note(result.reason);
        if (result.reason === "new-syntax-error" || result.reason === "unknown-npc" || result.reason === "unknown-block") {
          where(label, `refus inattendu (${result.reason}) pour ${JSON.stringify(action)}`);
        }
        return null;
      }
      totals.applied += 1;
      for (const edit of result.edits) {
        if (edit.start <= before.bodyRange.start || edit.end >= before.bodyRange.end) {
          where(label, `modification hors du corps (${edit.start}-${edit.end} pour ${before.bodyRange.start}-${before.bodyRange.end})`);
        }
      }
      const rawBefore = rawTexts(before);
      const rawAfter = rawTexts(result.npc);
      if (rawBefore.length !== rawAfter.length || rawBefore.some((value, index) => value !== rawAfter[index])) where(label, "un bloc brut a change");
      const commentsBefore = comments(current, before);
      const commentsAfter = comments(result.text, result.npc);
      if (commentsBefore.length !== commentsAfter.length || commentsBefore.some((value, index) => value !== commentsAfter[index])) where(label, "un commentaire a change");
      return result;
    };

    const targets = sample(npc.blocks);
    let kind = 0;
    for (const block of targets) {
      // 2. Identite.
      if (block.kind === "mes") {
        const plan = planEdit(npc, text, { type: "setMesText", id: block.id, text: block.text });
        if (!plan.ok || plan.edits.length !== 0) where("identite", `setMesText identique sur ${block.id} : ${JSON.stringify(plan)}`);
      }
      if (block.kind === "if") {
        const plan = planEdit(npc, text, { type: "setCondition", id: block.id, text: block.condition });
        if (!plan.ok || plan.edits.length !== 0) where("identite", `setCondition identique sur ${block.id} : ${JSON.stringify(plan)}`);
      }

      // 3. Insertion puis suppression.
      for (const type of ["insertAfter", "insertBefore"] as const) {
        const newBlock = NEW_BLOCKS[kind % NEW_BLOCKS.length] as NewBlock;
        kind += 1;
        const inserted = attempt("insertion", text, npc, { type, id: block.id, block: newBlock });
        if (inserted === null) continue;
        totals.inserts += 1;
        const createdId = type === "insertAfter" ? siblingId(block.id, 1) : block.id;
        const restored = attempt("suppression", inserted.text, inserted.npc, { type: "remove", id: createdId });
        if (restored?.text !== text) where("aller-retour insertion", `${type} ${block.id} (${generateBlock(newBlock)}) puis suppression : le texte differe`);
      }

      // 4. Deplacement puis retour.
      for (const direction of ["up", "down"] as const) {
        const moved = attempt("deplacement", text, npc, { type: "move", id: block.id, direction });
        if (moved === null) continue;
        totals.moves += 1;
        const back = attempt("retour", moved.text, moved.npc, { type: "move", id: siblingId(block.id, direction === "up" ? -1 : 1), direction: direction === "up" ? "down" : "up" });
        if (back?.text !== text) where("aller-retour deplacement", `${direction} ${block.id} puis retour : le texte differe`);
      }

      // 5. Modification du texte, puis retour.
      if (block.kind === "mes") {
        const changed = attempt("texte", text, npc, { type: "setMesText", id: block.id, text: `${block.text} (modifie)` });
        if (changed !== null) {
          totals.texts += 1;
          const literal = text.slice(block.textRange.start, block.textRange.end);
          const back = attempt("texte retour", changed.text, changed.npc, { type: "setMesText", id: block.id, text: block.text });
          if (back !== null && quote(block.text) === literal && back.text !== text) where("aller-retour texte", `${block.id} : le texte differe alors que le litteral est canonique`);
        }
      }

      // 6. Les suppressions des blocs existants peuvent rencontrer des commentaires, contrairement aux blocs insérés.
      if (block.kind !== "raw" && attempt("suppression directe", text, npc, { type: "remove", id: block.id }) !== null) totals.removals += 1;
    }
  }
}

const elapsed = performance.now() - started;
const sorted = (map: Map<string, number>): string =>
  [...map.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([key, value]) => `${key} ${value}`)
    .join(", ");

console.log(`Corpus : ${corpus.label.join(" ")}`);
console.log(`${totals.files} fichiers | ${totals.npcs} NPC a corps ferme (${totals.noBody} sans corps ferme, ignores)`);
console.log(`Conversion : ${totals.full} complets | ${totals.partial} partiels | ${totals.unsupported} non pris en charge`);
console.log(`Blocs : ${sorted(totals.blocks)}`);
const statements = [...totals.blocks.values()].reduce((sum, value) => sum + value, 0);
const rawCount = totals.blocks.get("raw") ?? 0;
console.log(`Part de blocs bruts : ${statements === 0 ? 0 : ((100 * rawCount) / statements).toFixed(1)} % des ${statements} blocs`);
console.log(`Litteraux de mes : ${totals.literals} (${totals.nonCanonicalLiterals} que l'editeur ecrirait autrement)`);
console.log(`NPC modifies : ${totals.mutatedNpcs} (au plus ${npcBudget} par fichier, ${blockBudget} blocs chacun)`);
console.log(`Modifications appliquees : ${totals.applied} (insertions ${totals.inserts}, deplacements ${totals.moves}, textes ${totals.texts}, suppressions directes ${totals.removals})`);
console.log(`Refus (contrat, pas un defaut) : ${refused.size === 0 ? "aucun" : sorted(new Map([...refused.entries()].map(([key, value]) => [key, value])))}`);
console.log(`Duree : ${(elapsed / 1000).toFixed(1)} s`);
console.log(`Violations : ${violations.length}`);
for (const violation of violations.slice(0, 20)) console.log(`  ${violation.check} | ${violation.file} | ${violation.npc} | ${violation.detail}`);
process.exit(violations.length === 0 ? 0 : 1);
