import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Quelle version de l'application tourne.
 *
 * Sans cette information, vérifier qu'un déploiement a bien pris demandait de
 * deviner : `/api/health` répondait exactement la même chose avant et après.
 *
 * Le SHA n'arrive pas par magie — Dokploy ne le passe pas au build. Il est
 * résolu à la construction de l'image par `src/scripts/ecrire-version.ts`, qui
 * écrit `.commit-sha` à la racine, et relu ici à chaque appel. En
 * développement local le fichier n'existe pas : on retombe sur le `.git` du
 * dépôt, qui est là.
 */
const NOM_FICHIER = ".commit-sha";
const INCONNU = "inconnu";

function lire(chemin: string): string | null {
  try {
    const contenu = readFileSync(chemin, "utf8").trim();
    return contenu === "" ? null : contenu;
  } catch {
    return null;
  }
}

// Un dépôt en SHA-1 donne 40 caractères, en SHA-256 soixante-quatre. Tout le
// reste — une référence symbolique mal lue, une ligne de commentaire — n'est
// pas un SHA et vaut mieux « inconnu » qu'une valeur fausse.
export function estSha(valeur: string | null | undefined): valeur is string {
  return typeof valeur === "string" && /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(valeur);
}

/**
 * Le SHA du commit pointé par un dossier `.git`, sans appeler le binaire git —
 * l'image de production ne l'embarque pas.
 *
 * Trois formes à traverser : un HEAD détaché (le SHA directement, ce que fait
 * souvent un clone de CI), une référence vers un fichier `refs/heads/...`, et
 * la même référence une fois compactée dans `packed-refs` — ce que `git gc`
 * finit toujours par faire, et qui aurait fait échouer une lecture naïve.
 */
export function resoudreShaDepuisGit(cheminGit: string): string | null {
  const head = lire(join(cheminGit, "HEAD"));
  if (head === null) return null;
  if (!head.startsWith("ref: ")) return estSha(head) ? head : null;

  const reference = head.slice("ref: ".length).trim();
  const direct = lire(join(cheminGit, reference));
  if (estSha(direct)) return direct;

  const compactees = lire(join(cheminGit, "packed-refs"));
  if (compactees === null) return null;
  for (const ligne of compactees.split("\n")) {
    const [sha, nom] = ligne.trim().split(/\s+/);
    if (nom === reference && estSha(sha)) return sha;
  }
  return null;
}

/** Le SHA complet, ou `null` si aucune source ne le donne. */
export function shaDeploiement(
  racine = process.cwd(),
  env: Record<string, string | undefined> = process.env,
): string | null {
  if (estSha(env.COMMIT_SHA?.trim())) return env.COMMIT_SHA!.trim();
  const fichier = lire(join(racine, NOM_FICHIER));
  if (estSha(fichier)) return fichier;
  return resoudreShaDepuisGit(join(racine, ".git"));
}

/**
 * De quoi se comparer d'un coup d'œil à `git log --oneline` : douze
 * caractères, ou `inconnu` plutôt qu'une version inventée.
 */
export function versionDeploiement(
  racine = process.cwd(),
  env: Record<string, string | undefined> = process.env,
): string {
  return shaDeploiement(racine, env)?.slice(0, 12) ?? INCONNU;
}
