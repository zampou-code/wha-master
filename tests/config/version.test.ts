import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resoudreShaDepuisGit, shaDeploiement, versionDeploiement } from "@/config/version";

const SHA = "a".repeat(39) + "7";
const AUTRE = "b".repeat(40);

let racine: string;

function ecrire(chemin: string, contenu: string) {
  const complet = join(racine, chemin);
  mkdirSync(join(complet, ".."), { recursive: true });
  writeFileSync(complet, contenu, "utf8");
}

describe("version déployée", () => {
  beforeEach(() => {
    racine = mkdtempSync(join(tmpdir(), "version-"));
  });

  afterEach(() => {
    rmSync(racine, { recursive: true, force: true });
  });

  it("suit la référence de HEAD jusqu'au fichier de branche", () => {
    ecrire(".git/HEAD", "ref: refs/heads/main\n");
    ecrire(".git/refs/heads/main", `${SHA}\n`);

    expect(resoudreShaDepuisGit(join(racine, ".git"))).toBe(SHA);
  });

  it("lit un HEAD détaché, la forme d'un clone de déploiement", () => {
    // Dokploy clone et place souvent le dépôt sur un commit précis : HEAD
    // contient alors le SHA, sans référence à suivre.
    ecrire(".git/HEAD", `${SHA}\n`);

    expect(resoudreShaDepuisGit(join(racine, ".git"))).toBe(SHA);
  });

  it("retrouve la référence compactée dans packed-refs", () => {
    // `git gc` déplace les refs dans packed-refs et supprime refs/heads/main :
    // une lecture naïve du fichier de branche échouerait là, silencieusement.
    ecrire(".git/HEAD", "ref: refs/heads/main\n");
    ecrire(".git/packed-refs", `# pack-refs with: peeled fully-peeled sorted \n${AUTRE} refs/heads/autre\n${SHA} refs/heads/main\n`);

    expect(resoudreShaDepuisGit(join(racine, ".git"))).toBe(SHA);
  });

  it("ne rend rien plutôt qu'une valeur fausse quand la référence est introuvable", () => {
    ecrire(".git/HEAD", "ref: refs/heads/main\n");
    ecrire(".git/packed-refs", `${AUTRE} refs/heads/autre\n`);

    expect(resoudreShaDepuisGit(join(racine, ".git"))).toBeNull();
  });

  it("refuse ce qui n'a pas la forme d'un SHA", () => {
    // Un HEAD tronqué ou un fichier de référence contenant autre chose
    // afficherait « version déployée : ref: refs » — pire que pas de version.
    ecrire(".git/HEAD", "ref: refs/heads/main\n");
    ecrire(".git/refs/heads/main", "pas-un-sha\n");

    expect(resoudreShaDepuisGit(join(racine, ".git"))).toBeNull();
  });

  it("préfère COMMIT_SHA, que le build peut passer en argument", () => {
    ecrire(".commit-sha", `${AUTRE}\n`);

    expect(shaDeploiement(racine, { COMMIT_SHA: SHA })).toBe(SHA);
  });

  it("ignore un COMMIT_SHA vide — le cas d'un build sans argument", () => {
    // Le Dockerfile passe toujours COMMIT_SHA="$GIT_SHA", vide par défaut :
    // s'arrêter là rendrait le fichier et le .git inutiles.
    ecrire(".commit-sha", `${SHA}\n`);

    expect(shaDeploiement(racine, { COMMIT_SHA: "  " })).toBe(SHA);
  });

  it("lit le fichier figé à la construction de l'image", () => {
    ecrire(".commit-sha", `${SHA}\n`);

    expect(shaDeploiement(racine, {})).toBe(SHA);
  });

  it("retombe sur le dépôt local quand le fichier est absent", () => {
    // Le cas du développement : aucune image construite, mais un .git présent.
    ecrire(".git/HEAD", `${SHA}\n`);

    expect(shaDeploiement(racine, {})).toBe(SHA);
  });

  it("dit « inconnu » quand aucune source ne donne le commit", () => {
    // L'image ne contient ni .git ni fichier si les exceptions du
    // .dockerignore cessent de fonctionner : la route doit répondre quand même.
    expect(versionDeploiement(racine, {})).toBe("inconnu");
  });

  it("raccourcit à douze caractères, de quoi comparer avec git log", () => {
    ecrire(".commit-sha", SHA);

    expect(versionDeploiement(racine, {})).toBe(SHA.slice(0, 12));
    expect(SHA.startsWith(versionDeploiement(racine, {}))).toBe(true);
  });
});
