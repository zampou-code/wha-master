import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { estSha, resoudreShaDepuisGit } from "@/config/version";

/**
 * Fige le SHA du commit construit dans `.commit-sha`, lu ensuite par
 * `/api/health`.
 *
 * Tourne pendant la construction de l'image, où `.git` n'entre que par les
 * exceptions du `.dockerignore` (`HEAD`, `refs`, `packed-refs`).
 *
 * Volontairement sans `shaDeploiement()` : celui-ci accepte un `.commit-sha`
 * déjà présent, et un fichier traînant dans le dossier de build se recopierait
 * d'image en image — on afficherait pour l'éternité la version du jour où il a
 * été écrit. Ici, seules deux sources comptent : l'argument de build, puis le
 * dépôt lui-même.
 *
 * Ne jamais faire échouer le build pour ça : une version inconnue est une gêne,
 * un déploiement bloqué est une panne.
 */
const racine = process.cwd();
const passe = process.env.COMMIT_SHA?.trim();
const sha = (estSha(passe) ? passe : null) ?? resoudreShaDepuisGit(join(racine, ".git"));

writeFileSync(join(racine, ".commit-sha"), sha ?? "", "utf8");
console.log(sha ? `Version figée : ${sha}` : "Version inconnue : .git absent du contexte de build.");
