import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "@/lib/prisma";
import {
  lirePersona,
  enregistrerProfil,
  enregistrerFait,
  supprimerFait,
  PersonaRefuseError,
} from "@/persona/service";
import { assemblerContexte } from "@/redacteur/contexte";
import { resetDb } from "../helpers/db";

describe("service de la fiche persona", () => {
  beforeEach(resetDb);

  it("rend une fiche vide plutôt que de lever quand rien n'est renseigné", async () => {
    expect(await lirePersona()).toEqual({
      styleGuide: {},
      hardLimits: [],
      termesInterdits: [],
      faits: [],
    });
  });

  it("enregistre le style, les limites et les mots interdits", async () => {
    const persona = await enregistrerProfil({
      styleGuide: { traits: ["taquin", "direct"] },
      hardLimits: ["Ne jamais promettre une date"],
      termesInterdits: ["rembourse"],
    });
    expect(persona.styleGuide).toEqual({ traits: ["taquin", "direct"] });
    expect(persona.hardLimits).toEqual(["Ne jamais promettre une date"]);
    expect(persona.termesInterdits).toEqual(["rembourse"]);
  });

  it("écarte les lignes vides et les doublons des listes", async () => {
    // Une zone de texte produit des lignes vides à chaque retour à la ligne, et
    // une limite en double n'en protège pas deux fois : les garder encombrerait
    // le prompt sans rien apporter.
    const persona = await enregistrerProfil({
      styleGuide: {},
      hardLimits: ["  Ne jamais parler d'argent  ", "", "   ", "ne jamais parler d'argent"],
      termesInterdits: ["rembourse", "rembourse", ""],
    });
    expect(persona.hardLimits).toEqual(["Ne jamais parler d'argent"]);
    expect(persona.termesInterdits).toEqual(["rembourse"]);
  });

  it("crée, modifie et supprime un fait", async () => {
    let persona = await enregistrerFait({ key: "ville", value: "Abidjan", shareable: true });
    expect(persona.faits).toHaveLength(1);
    const fait = persona.faits[0];

    persona = await enregistrerFait({ id: fait.id, key: "ville", value: "Bouaké", shareable: false });
    expect(persona.faits[0].value).toBe("Bouaké");
    expect(persona.faits[0].shareable).toBe(false);

    persona = await supprimerFait(fait.id);
    expect(persona.faits).toEqual([]);
  });

  it("refuse deux faits portant la même clé", async () => {
    await enregistrerFait({ key: "ville", value: "Abidjan", shareable: true });
    await expect(
      enregistrerFait({ key: "ville", value: "Bouaké", shareable: true }),
    ).rejects.toBeInstanceOf(PersonaRefuseError);
    expect(await prisma.personaFact.count()).toBe(1);
  });

  it("laisse renommer un fait sans se heurter à lui-même", async () => {
    const persona = await enregistrerFait({ key: "ville", value: "Abidjan", shareable: true });
    const fait = persona.faits[0];
    await expect(
      enregistrerFait({ id: fait.id, key: "ville", value: "Abidjan", shareable: false }),
    ).resolves.toBeDefined();
  });

  it("refuse une clé ou une valeur vide", async () => {
    await expect(enregistrerFait({ key: "   ", value: "x", shareable: true })).rejects.toBeInstanceOf(
      PersonaRefuseError,
    );
    await expect(enregistrerFait({ key: "ville", value: "  ", shareable: true })).rejects.toBeInstanceOf(
      PersonaRefuseError,
    );
  });

  it("supprimer pour de bon, pas seulement décocher : le fait cesse d'exister", async () => {
    const persona = await enregistrerFait({ key: "adresse", value: "secret", shareable: false });
    await supprimerFait(persona.faits[0].id);
    expect(await prisma.personaFact.count()).toBe(0);
  });

  it("ne rend pas au rédacteur un fait non marqué partageable", async () => {
    // Le vrai test de la fiche : ce qu'on y règle doit arriver — ou non —
    // jusqu'au contexte de rédaction, pas seulement en base.
    await enregistrerFait({ key: "prenom", value: "Ibrahim", shareable: true });
    await enregistrerFait({ key: "adresse", value: "SECRET", shareable: false });
    await enregistrerProfil({
      styleGuide: {},
      hardLimits: ["Ne jamais parler d'argent"],
      termesInterdits: ["rembourse"],
    });

    const contact = await prisma.contact.create({
      data: { jid: "225@s.whatsapp.net", thread: { create: {} }, policy: { create: {} } },
    });
    const contexte = await assemblerContexte(contact.id);

    expect(contexte.faits.map((f) => f.key)).toEqual(["prenom"]);
    expect(JSON.stringify(contexte)).not.toContain("SECRET");
    expect(contexte.termesInterdits).toEqual(["rembourse"]);
    expect(contexte.hardLimits).toEqual(["Ne jamais parler d'argent"]);
  });
});
