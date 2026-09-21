import { execSync } from "node:child_process";
import { Client } from "pg";

// Deux suites d'intégration lancées en même temps partagent la même base et se
// tronquent mutuellement : les échecs qui en résultent tombent sur des tests
// sans rapport, semblent intermittents, et se « reproduisent » différemment à
// chaque essai. Ça m'a coûté une demi-heure de diagnostic. Un verrou consultatif
// PostgreSQL rend la situation impossible : la seconde suite attend son tour au
// lieu de corrompre la première. Le verrou tombe de lui-même à la fermeture de
// la connexion, y compris si le processus est tué.
const CLE_VERROU = 815_243_001;

export default async function setup() {
  const url = process.env.DATABASE_URL_TEST;
  if (!url) throw new Error("DATABASE_URL_TEST doit être défini pour les tests d'intégration");

  process.env.DATABASE_URL = url;
  process.env.MASTER_KEY ??= "a".repeat(64);
  process.env.BETTER_AUTH_SECRET ??= "b".repeat(32);
  process.env.BETTER_AUTH_URL ??= "http://localhost:3000";
  process.env.ADMIN_EMAIL ??= "test@example.com";
  process.env.ADMIN_PASSWORD ??= "motdepassetest";
  process.env.GOWA_BASE_URL ??= "http://localhost:3001";
  process.env.GOWA_BASIC_AUTH ??= "admin:test";
  process.env.GOWA_WEBHOOK_SECRET ??= "c".repeat(16);

  // Connexion unique et non un client Prisma : un verrou consultatif appartient
  // à la SESSION qui l'a pris. Avec un pool, le verrou partirait sur une
  // connexion quelconque et le déverrouillage sur une autre.
  const verrou = new Client({ connectionString: url });
  await verrou.connect();
  await verrou.query("SELECT pg_advisory_lock($1)", [CLE_VERROU]);

  execSync("pnpm prisma migrate deploy", {
    stdio: "inherit",
    // Sans cette variable, `prisma migrate deploy` imprime un bandeau
    // « Update available » sur stdout : la contrainte de sortie vierge des
    // tests d'intégration est inconditionnelle (finding 7).
    env: { ...process.env, DATABASE_URL: url, PRISMA_HIDE_UPDATE_MESSAGE: "1" },
  });

  return async () => {
    await verrou.end();
  };
}
