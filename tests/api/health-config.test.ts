import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Fichier séparé, et surtout SANS `vi.mock("@/lib/prisma")` : c'est le vrai
// client paresseux qui doit être sollicité. Un mock de Prisma rendrait ce test
// vert quoi que fasse la route, puisque `getEnv()` — celui qui lève sur une
// configuration invalide — ne serait jamais appelé.
const CLES = [
  "DATABASE_URL", "MASTER_KEY", "BETTER_AUTH_SECRET", "BETTER_AUTH_URL",
  "ADMIN_EMAIL", "ADMIN_PASSWORD", "GOWA_BASE_URL", "GOWA_BASIC_AUTH",
  "GOWA_WEBHOOK_SECRET", "CONTROL_GROUP_JID",
];

describe("GET /api/health sans configuration valide", () => {
  const sauvegarde: Record<string, string | undefined> = {};

  beforeEach(() => {
    vi.resetModules();
    for (const cle of CLES) {
      sauvegarde[cle] = process.env[cle];
      delete process.env[cle];
    }
  });

  afterEach(() => {
    for (const cle of CLES) {
      if (sauvegarde[cle] === undefined) delete process.env[cle];
      else process.env[cle] = sauvegarde[cle];
    }
  });

  it("répond dégradé au lieu de lever — c'est justement le cas où on l'interroge", async () => {
    const { GET } = await import("@/app/api/health/route");
    const reponse = await GET();
    expect(reponse.status).toBe(503);
    await expect(reponse.json()).resolves.toMatchObject({
      status: "degraded",
      groupeDeControle: "absent",
    });
  });
});
