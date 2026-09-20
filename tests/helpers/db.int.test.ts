import { describe, it, expect } from "vitest";
import { prisma } from "@/lib/prisma";
import { resetDb, tablesATronquer } from "./db";

describe("remise à zéro de la base", () => {
  it("couvre toutes les tables métier, y compris celles ajoutées après coup", async () => {
    const tables = await tablesATronquer();
    for (const attendue of ["Contact", "Decision", "Escalation", "PersonaFact", "PersonaProfile", "SystemState"]) {
      expect(tables).toContain(attendue);
    }
  });

  it("n'inclut pas la table de migrations de Prisma", async () => {
    expect(await tablesATronquer()).not.toContain("_prisma_migrations");
  });

  it("vide effectivement une table que personne n'a pensé à lister", async () => {
    await prisma.personaFact.create({ data: { key: "temoin", value: "x", shareable: true } });
    await resetDb();
    expect(await prisma.personaFact.count()).toBe(0);
  });
});
