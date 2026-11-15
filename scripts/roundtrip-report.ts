/**
 * Verifie l'aller-retour octet pour octet du codec de documents sur un corpus reel (RF-014) :
 *   octets -> decodeDocument -> (texte de l'editeur normalise en LF) -> restoreEol -> encodeDocument == octets.
 *
 * Usage : pnpm exec tsx scripts/roundtrip-report.ts <dossier>
 * Lecture seule. Echoue (code 1) si un seul fichier n'est pas restitue a l'identique.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { normalizeToLf } from "@runeforge/runescript-core";
import { decodeDocument, encodeDocument, restoreEol } from "@runeforge/project-core";

const root = process.argv[2];
if (root === undefined) {
  console.error("Usage : tsx scripts/roundtrip-report.ts <dossier>");
  process.exit(2);
}

const files: string[] = [];
(function walk(directory: string): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.name.toLowerCase().endsWith(".txt")) files.push(full);
  }
})(root);

const encodings = new Map<string, number>();
const eols = new Map<string, number>();
const failures: string[] = [];
const unsupported: string[] = [];
let warnings = 0;

for (const file of files) {
  const bytes = new Uint8Array(readFileSync(file));
  const decoded = decodeDocument(bytes);
  const name = relative(root, file);
  if (decoded.kind !== "text") {
    unsupported.push(`${name} (${decoded.reason})`);
    continue;
  }
  encodings.set(decoded.encoding, (encodings.get(decoded.encoding) ?? 0) + 1);
  eols.set(decoded.eol, (eols.get(decoded.eol) ?? 0) + 1);
  warnings += decoded.warnings.length;
  // Ce que l'editeur manipule : texte normalise en LF, puis fins de ligne d'origine restituees a l'enregistrement.
  const editorText = normalizeToLf(decoded.text);
  const restored = restoreEol(editorText, decoded);
  const encoded = encodeDocument(restored, { encoding: decoded.encoding, bom: decoded.bom });
  const identical =
    encoded.ok && encoded.bytes.length === bytes.length && encoded.bytes.every((value, index) => value === bytes[index]);
  if (!identical) failures.push(name);
}

console.log(`Corpus : ${root}`);
console.log(`${files.length} fichiers | non supportes : ${unsupported.length} | avertissements : ${warnings}`);
console.log(`Encodages : ${JSON.stringify(Object.fromEntries(encodings))}`);
console.log(`Fins de ligne : ${JSON.stringify(Object.fromEntries(eols))}`);
console.log(`Aller-retour identique : ${files.length - unsupported.length - failures.length} / ${files.length - unsupported.length}`);
for (const item of unsupported) console.log(`  non supporte : ${item}`);
for (const item of failures) console.log(`  ECHEC : ${item}`);
process.exit(failures.length === 0 ? 0 : 1);
