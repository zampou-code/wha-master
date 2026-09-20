import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

describe("instance Prisma paresseuse", () => {
  const ancien = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    process.env = { ...ancien };
  });

  it("s'importe sans lever quand aucune variable d'environnement n'est définie", async () => {
    for (const cle of ["DATABASE_URL", "MASTER_KEY", "BETTER_AUTH_SECRET", "BETTER_AUTH_URL", "ADMIN_EMAIL", "ADMIN_PASSWORD", "GOWA_BASE_URL", "GOWA_BASIC_AUTH", "GOWA_WEBHOOK_SECRET"]) {
      delete process.env[cle];
    }
    await expect(import("@/lib/prisma")).resolves.toBeDefined();
  });

  it("ne construit le client qu'au premier accès à une propriété", async () => {
    delete process.env.DATABASE_URL;
    const { prisma } = await import("@/lib/prisma");
    // L'import seul n'a rien construit : c'est la lecture d'une propriété qui
    // déclenche getEnv(), et donc l'erreur de configuration attendue.
    expect(() => prisma.contact).toThrow(/Configuration d'environnement invalide/);
  });

  it("réutilise la même instance entre deux accès", async () => {
    process.env.DATABASE_URL = "postgres://wha:test@localhost:5432/test";
    process.env.MASTER_KEY = "a".repeat(64);
    process.env.BETTER_AUTH_SECRET = "b".repeat(32);
    process.env.BETTER_AUTH_URL = "http://localhost:3000";
    process.env.ADMIN_EMAIL = "test@example.com";
    process.env.ADMIN_PASSWORD = "motdepassetest12";
    process.env.GOWA_BASE_URL = "http://localhost:3001";
    process.env.GOWA_BASIC_AUTH = "admin:test";
    process.env.GOWA_WEBHOOK_SECRET = "c".repeat(16);
    const { prisma } = await import("@/lib/prisma");
    expect(prisma.contact).toBe(prisma.contact);
  });
});
