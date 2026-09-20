import { execSync } from "node:child_process";

export default function setup() {
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

  execSync("pnpm prisma migrate deploy", {
    stdio: "inherit",
    // Sans cette variable, `prisma migrate deploy` imprime un bandeau
    // « Update available » sur stdout : la contrainte de sortie vierge des
    // tests d'intégration est inconditionnelle (finding 7).
    env: { ...process.env, DATABASE_URL: url, PRISMA_HIDE_UPDATE_MESSAGE: "1" },
  });
}
