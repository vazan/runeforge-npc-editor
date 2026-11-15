// Construit pour Linux dans WSL et depose dans target/release, a cote du .exe Windows :
//   - runeforge-studio-linux-x86_64          l'ELF brut (sans extension : normal sous Linux), celui que prend `release:prepare` ;
//   - runeforge-studio-linux-x86_64.AppImage un AppImage (WebKitGTK et GTK embarques), a rendre executable puis double-cliquer.
// Usage : pnpm build:linux [--distro <nom>] [--no-appimage] [--allow-download]
//   --distro <nom>     distribution WSL (ou variable RUNEFORGE_WSL_DISTRO) ; sans option : la distribution WSL par defaut
//   --no-appimage      ne construit que l'ELF brut (aucun telechargement)
//   --allow-download   autorise le bundler Tauri a TELECHARGER ET EXECUTER ses outils d'AppImage s'ils ne sont pas deja dans
//                      ~/.cache/tauri de WSL : AppRun-x86_64 et linuxdeploy-*-x86_64.AppImage (github.com/tauri-apps/binary-releases),
//                      linuxdeploy-plugin-appimage.AppImage (github.com/linuxdeploy/linuxdeploy-plugin-appimage, version « continuous »).
//                      Sans cette option et sans cache, le script s'arrete AVANT de construire (DEC-048).
//
// Les sources sont COPIEES sur le disque de Linux (~/runeforge-npc-editor) : node_modules et target/ de Windows et de Linux ne
// doivent jamais etre partages (docs/DEV_SETUP.md). Sont exclus de la copie : node_modules, target, .git, dist, .vitest,
// release-out et les cles privees *.key de la racine. Aucune release n'est preparee ni publiee.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const elfPath = join(root, "target", "release", "runeforge-studio-linux-x86_64");
const appImagePath = `${elfPath}.AppImage`;

function fail(message, code = 1) {
  console.error(`build:linux - ${message}`);
  process.exit(code);
}

if (process.platform !== "win32") {
  fail("ce script sert a construire pour Linux depuis Windows (WSL). Sous Linux : pnpm --filter @runeforge/desktop tauri build --no-bundle", 2);
}

const args = process.argv.slice(2);
const known = new Set(["--distro", "--no-appimage", "--allow-download"]);
const distroIndex = args.indexOf("--distro");
for (const [i, arg] of args.entries()) {
  if (arg.startsWith("--") && !known.has(arg)) fail(`option inconnue : ${arg}`, 2);
  if (!arg.startsWith("--") && i !== distroIndex + 1) fail(`argument inattendu : ${arg}`, 2);
}
const distro = distroIndex >= 0 ? args[distroIndex + 1] : process.env.RUNEFORGE_WSL_DISTRO;
if (distroIndex >= 0 && (!distro || distro.startsWith("--"))) fail("--distro demande un nom de distribution", 2);
const withAppImage = !args.includes("--no-appimage");
const allowDownload = args.includes("--allow-download");

// D:\Project\x -> /mnt/d/Project/x (disques locaux seulement ; le script verifie que le dossier existe dans WSL).
const drive = /^([A-Za-z]):\\(.*)$/.exec(root);
if (!drive) fail(`le projet doit etre sur un disque local (X:\\...), pas : ${root}`, 2);
const source = `/mnt/${drive[1].toLowerCase()}/${drive[2].replaceAll("\\", "/")}`;
if (/['\r\n]/.test(source)) fail("le chemin du projet contient un caractere non pris en charge (apostrophe ou saut de ligne)", 2);

// Le script bash arrive sur l'entree standard de `bash -s` : les commandes longues lisent /dev/null pour ne pas en avaler la suite.
const bash = `
set -euo pipefail
SRC='${source}'
APPIMAGE=${withAppImage ? 1 : 0}
ALLOW=${allowDownload ? 1 : 0}
DST="$HOME/runeforge-npc-editor"
OUT="$SRC/target/release/runeforge-studio-linux-x86_64"
[ -d "$SRC" ] || { echo "dossier introuvable dans WSL : $SRC" >&2; exit 3; }
[ "$SRC" != "$DST" ] || { echo "la copie de travail ne peut pas etre le projet lui-meme" >&2; exit 3; }
for tool in node pnpm cargo rsync; do
  command -v "$tool" >/dev/null || { echo "outil manquant dans WSL : $tool (voir docs/DEV_SETUP.md, section Linux)" >&2; exit 4; }
done
if [ "$APPIMAGE" = 1 ]; then
  C="$HOME/.cache/tauri"
  if ! { [ -f "$C/AppRun-x86_64" ] && [ -f "$C/linuxdeploy-plugin-appimage.AppImage" ] && ls "$C"/linuxdeploy-*-x86_64.AppImage >/dev/null 2>&1; }; then
    if [ "$ALLOW" != 1 ]; then
      cat >&2 <<'MSG'
build:linux - l'AppImage a besoin d'outils que Tauri doit TELECHARGER puis EXECUTER (absents de ~/.cache/tauri dans WSL) :
  AppRun-x86_64, linuxdeploy-<version>-x86_64.AppImage   <- github.com/tauri-apps/binary-releases
  linuxdeploy-plugin-appimage.AppImage                   <- github.com/linuxdeploy/linuxdeploy-plugin-appimage (« continuous », non epingle)
Relancez avec --allow-download pour les autoriser, ou avec --no-appimage pour ne construire que l'ELF brut. Rien n'a ete construit.
MSG
      exit 6
    fi
    echo "build:linux - --allow-download : Tauri va telecharger ses outils d'AppImage dans $C"
  fi
fi
mkdir -p "$DST"
rsync -a --delete \\
  --exclude node_modules --exclude target --exclude .git --exclude dist --exclude .vitest \\
  --exclude release-out --exclude '/*.key' --exclude apps/desktop/src-tauri/gen \\
  "$SRC"/ "$DST"/
cd "$DST"
CI=true pnpm install --frozen-lockfile < /dev/null
# Les sorties de ce lancement remplacent celles d'avant : aucun fichier perime ne reste si la construction echoue.
mkdir -p "$SRC/target/release"
rm -f "$OUT" "$OUT.AppImage" "$OUT.tar.gz"
pnpm --filter @runeforge/desktop tauri build --no-bundle < /dev/null
BIN="$DST/target/release/runeforge-studio"
head -c 4 "$BIN" | od -An -tx1 | grep -q '7f 45 4c 46' || { echo "$BIN n'est pas un ELF" >&2; exit 5; }
cp "$BIN" "$OUT.tmp"
mv -f "$OUT.tmp" "$OUT"
echo "copie : $OUT"
if [ "$APPIMAGE" = 1 ]; then
  rm -rf "$DST/target/release/bundle/appimage"
  pnpm --filter @runeforge/desktop tauri build --bundles appimage < /dev/null
  [ "$(ls "$DST"/target/release/bundle/appimage/*.AppImage | wc -l)" = 1 ] || { echo "un seul fichier .AppImage etait attendu" >&2; exit 7; }
  AI="$(ls "$DST"/target/release/bundle/appimage/*.AppImage)"
  head -c 11 "$AI" | tail -c 3 | od -An -tx1 | grep -q '41 49 02' || { echo "$AI n'a pas la signature AppImage type 2" >&2; exit 7; }
  cp "$AI" "$OUT.AppImage.tmp"
  mv -f "$OUT.AppImage.tmp" "$OUT.AppImage"
  echo "copie : $OUT.AppImage"
fi
`;

console.log(`build:linux - sources ${source} -> WSL${distro ? ` (${distro})` : ""}${withAppImage ? " ; ELF + AppImage" : " ; ELF seul"}`);
// `bash -l` charge le PATH de l'utilisateur (node, pnpm, cargo) ; `exec bash -s` lit ensuite le script sur l'entree standard dans un
// shell qui n'est plus « de connexion » : sinon `set -e` et ~/.bash_logout ramenent tout code de sortie a 1.
const wslArgs = [...(distro ? ["-d", distro] : []), "--", "bash", "-lc", "exec bash -s"];
const result = spawnSync("wsl", wslArgs, { input: bash, stdio: ["pipe", "inherit", "inherit"] });
if (result.error) fail(`wsl est introuvable ou n'a pas pu demarrer : ${result.error.message}`);
if (result.status !== 0) fail(`la construction dans WSL a echoue (code ${result.status ?? "inconnu"})`, result.status ?? 1);

// Controle independant, cote Windows, des fichiers livres.
function read(path) {
  try {
    return readFileSync(path);
  } catch {
    return fail(`fichier attendu absent : ${path}`);
  }
}
function isElf(data) {
  return data[0] === 0x7f && data[1] === 0x45 && data[2] === 0x4c && data[3] === 0x46;
}
function sha256(data) {
  return createHash("sha256").update(data).digest("hex");
}

const elf = read(elfPath);
if (!isElf(elf)) fail(`${elfPath} n'a pas l'en-tete ELF`);
console.log("build:linux - OK");
console.log(`  ELF      : ${elfPath}`);
console.log(`             ${elf.length} octets, SHA-256 ${sha256(elf)}`);
if (withAppImage) {
  const appImage = read(appImagePath);
  // Un AppImage de type 2 est un ELF (le « runtime ») dont les octets 8 a 10 valent « AI\\x02 ».
  if (!isElf(appImage) || appImage[8] !== 0x41 || appImage[9] !== 0x49 || appImage[10] !== 0x02) fail(`${appImagePath} n'est pas un AppImage de type 2`);
  console.log(`  AppImage : ${appImagePath}`);
  console.log(`             ${appImage.length} octets, SHA-256 ${sha256(appImage)}`);
}
console.log("  non signes, sans installateur ; sous Linux : chmod +x avant le premier lancement (le bit est perdu en passant par Windows)");
