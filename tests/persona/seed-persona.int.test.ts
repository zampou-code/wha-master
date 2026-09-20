import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "@/lib/prisma";
import { chargerPersona, personaSchema } from "@/scripts/seed-persona";
import { resetDb } from "../helpers/db";

const donnees = {
  styleGuide: { longueur: "court", tutoiement: true },
  hardLimits: ["Ne jamais promettre une date"],
  faits: [
    { key: "prenom", value: "Ibrahim", shareable: true },
    { key: "adresse", value: "secrète", shareable: false },
  ],
};

describe("amorçage de la persona", () => {
  beforeEach(resetDb);

  it("crée le profil unique et ses faits", async () => {
    const resume = await chargerPersona(personaSchema.parse(donnees));
    expect(resume.faits).toBe(2);
    expect(resume.limites).toBe(1);
    const profil = await prisma.personaProfile.findUnique({ where: { id: "self" } });
    expect(profil?.hardLimits).toEqual(["Ne jamais promettre une date"]);
  });

  it("préserve le drapeau shareable, qui décide de ce que le rédacteur peut citer", async () => {
    await chargerPersona(personaSchema.parse(donnees));
    const partageables = await prisma.personaFact.findMany({ where: { shareable: true } });
    expect(partageables.map((f) => f.key)).toEqual(["prenom"]);
  });

  it("est idempotent : relancer met à jour sans dupliquer", async () => {
    await chargerPersona(personaSchema.parse(donnees));
    await chargerPersona(personaSchema.parse({
      ...donnees,
      faits: [{ key: "prenom", value: "Ibra", shareable: true }],
    }));
    const faits = await prisma.personaFact.findMany();
    expect(faits).toHaveLength(2);
    expect(faits.find((f) => f.key === "prenom")?.value).toBe("Ibra");
  });

  it("refuse un fait sans clé, avec un message en français", () => {
    expect(() => personaSchema.parse({ ...donnees, faits: [{ value: "x", shareable: true }] }))
      .toThrow(/clé/i);
  });
});
