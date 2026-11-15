import { resolveScriptLoadOrder } from "@runeforge/emulator-core";
import type { ScriptLoadEntryPoint, ScriptLoadFileSystem, ScriptLoadOptions, ScriptLoadReport } from "@runeforge/emulator-core";
import { RATHENA_PATHS } from "./paths";

/**
 * Points d'entree de la lecture des scripts par le serveur rAthena, dans l'ordre (`do_init` de `map.cpp`) : d'abord
 * `conf/map_athena.conf` (qui peut contenir des `npc:` et des `import:`), puis `npc/re/scripts_main.conf` en mode renewal
 * ou `npc/pre-re/scripts_main.conf` sinon.
 */
export function rathenaEntryPoints(renewal: boolean): ScriptLoadEntryPoint[] {
  return [
    { path: RATHENA_PATHS.mapConfig, mode: "map-config" },
    { path: renewal ? RATHENA_PATHS.scriptsMain.renewal : RATHENA_PATHS.scriptsMain.preRenewal, mode: "npc-list" },
  ];
}

/** Liste, dans l'ordre de chargement, les fichiers de script que le serveur rAthena charge reellement. */
export function resolveRathenaScripts(
  fileSystem: ScriptLoadFileSystem,
  renewal: boolean,
  options?: ScriptLoadOptions,
): Promise<ScriptLoadReport> {
  return resolveScriptLoadOrder(rathenaEntryPoints(renewal), fileSystem, options);
}
