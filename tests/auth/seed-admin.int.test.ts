import { describe, it, expect, beforeEach, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import { auth } from "@/lib/auth";
import { seedAdmin } from "@/scripts/seed-admin";

// Le journal réel écrit sur process.stdout ; on le rend silencieux ici pour
// garder une sortie de test vierge (ce fichier ne teste pas la journalisation
// elle-même, voir tests/lib/log.test.ts).
vi.mock("@/lib/log", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/log")>();
  return { ...original, log: original.creerJournal({}, () => {}) };
});

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

  it("répare un compte incomplet (utilisateur sans compte credential)", async () => {
    // Simule l'état laissé par un conteneur mort entre les deux écritures :
    // le user existe, mais createAccount n'a jamais tourné.
    const ctx = await auth.$context;
    const email = process.env.ADMIN_EMAIL as string;
    const utilisateurOrphelin = await ctx.internalAdapter.createUser(
      { email, name: "Propriétaire", emailVerified: true },
      { method: "email-password" },
    );

    expect(await prisma.account.count()).toBe(0);

    await seedAdmin();

    const comptes = await prisma.account.findMany({ where: { userId: utilisateurOrphelin.id } });
    expect(comptes).toHaveLength(1);
    expect(comptes[0].providerId).toBe("credential");
    expect(await prisma.user.count()).toBe(1);

    // Un appel suivant reste un no-op : pas de deuxième compte, pas d'erreur.
    await seedAdmin();
    expect(await prisma.account.count()).toBe(1);
    expect(await prisma.user.count()).toBe(1);
  });
});
