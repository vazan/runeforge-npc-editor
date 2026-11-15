import type { DeployBackend, DeployRoots } from "../app/deploy-service";
import { FakeBackend } from "./fake-backend";

/**
 * Deux disques en memoire — le projet et la destination — derriere l'interface de fichiers du deploiement : les memes operations, aiguillees
 * selon la racine demandee (comme le fait le coeur natif avec deux racines approuvees).
 */
export interface TwoRoots {
  readonly project: FakeBackend;
  readonly destination: FakeBackend;
  readonly backend: DeployBackend;
  readonly roots: DeployRoots;
}

export const PROJECT_ROOT = "projet";
export const DESTINATION_ROOT = "destination";

export function twoRoots(): TwoRoots {
  const project = new FakeBackend();
  const destination = new FakeBackend();
  const pick = (rootId: string): FakeBackend => {
    if (rootId === PROJECT_ROOT) return project;
    if (rootId === DESTINATION_ROOT) return destination;
    throw new Error(`racine inconnue : ${rootId}`);
  };
  const backend: DeployBackend = {
    readFiles: (rootId, paths, maxBytes) => pick(rootId).readFiles(rootId, paths, maxBytes),
    writeFile: (rootId, path, data, precondition, keepHistory) => pick(rootId).writeFile(rootId, path, data, precondition, keepHistory),
    createDirectory: (rootId, path) => pick(rootId).createDirectory(rootId, path),
  };
  return { project, destination, backend, roots: { projectRootId: PROJECT_ROOT, destinationRootId: DESTINATION_ROOT } };
}
