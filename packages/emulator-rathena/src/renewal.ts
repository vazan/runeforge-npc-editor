export interface RenewalDetection {
  /** Vrai si le serveur est compile en mode « renewal » (il charge alors `npc/re/`, sinon `npc/pre-re/`). */
  readonly renewal: boolean;
  /**
   * - `header` : lu dans `src/config/renewal.hpp` ;
   * - `default` : fichier absent, valeur par defaut de rAthena (renewal) : a confirmer par l'utilisateur.
   */
  readonly evidence: "header" | "default";
}

/**
 * Deduit le mode de compilation de `src/config/renewal.hpp` : `#define RENEWAL` actif et `#define PRERE` absent (ce
 * dernier, ecrit par `./configure`, desactive tout le bloc renewal). La compilation peut aussi etre pilotee par des options
 * du compilateur que ce fichier ne montre pas ; l'utilisateur peut alors imposer le mode dans la configuration du projet.
 */
export function detectRenewal(headerText: string | null): RenewalDetection {
  if (headerText === null) return { renewal: true, evidence: "default" };
  const code = headerText.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  const defines = (name: string): boolean => new RegExp(`^[ \\t]*#[ \\t]*define[ \\t]+${name}[ \\t]*$`, "m").test(code);
  return { renewal: defines("RENEWAL") && !defines("PRERE"), evidence: "header" };
}
