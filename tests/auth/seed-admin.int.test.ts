import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "@/lib/prisma";
import { seedAdmin } from "@/scripts/seed-admin";

describe("création du compte unique", () => {
  beforeEach(async () => {
    await prisma.$executeRawUnsafe('TRUNCATE TABLE "session", "account", "user" CASCADE');
  });

  it("crée le compte à partir de ADMIN_EMAIL et ADMIN_PASSWORD", async () => {
    await seedAdmin();
    const utilisateurs = await prisma.user.findMany();
    expect(utilisateurs).toHaveLength(1);
    expect(utilisateurs[0].email).toBe(process.env.ADMIN_EMAIL);
  });

  it("est idempotent : un deuxième appel ne crée pas de doublon", async () => {
    await seedAdmin();
    await seedAdmin();
    expect(await prisma.user.count()).toBe(1);
  });
});
