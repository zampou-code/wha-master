import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "@/lib/prisma";
import { assemblerContexte } from "@/redacteur/contexte";
import { resetDb } from "../helpers/db";

async function preparer() {
  await prisma.personaProfile.create({
    data: { id: "self", styleGuide: { longueur: "court" }, hardLimits: ["Ne jamais promettre une date"] },
  });
  await prisma.personaFact.createMany({
    data: [
      { key: "prenom", value: "Ibrahim", shareable: true },
      { key: "ville", value: "Abidjan", shareable: true },
      { key: "adresse", value: "SECRET", shareable: false },
    ],
  });
  const contact = await prisma.contact.create({
    data: {
      jid: "225@s.whatsapp.net",
      thread: { create: { rollingSummary: "on se taquine" } },
      policy: { create: { styleLanguage: "en" } },
    },
    include: { thread: true },
  });
  for (let i = 0; i < 25; i++) {
    await prisma.message.create({
      data: {
        threadId: contact.thread!.id,
        waMessageId: `M-${i}`,
        direction: i % 2 === 0 ? "IN" : "OUT",
        source: "HUMAN",
        text: `message ${i}`,
        timestamp: new Date(Date.now() - (25 - i) * 60_000),
      },
    });
  }
  return contact;
}

describe("contexte du rédacteur", () => {
  beforeEach(resetDb);

  it("ne transmet que les faits partageables (P4)", async () => {
    const contact = await preparer();
    const contexte = await assemblerContexte(contact.id);
    expect(contexte.faits.map((f) => f.key).sort()).toEqual(["prenom", "ville"]);
    expect(JSON.stringify(contexte)).not.toContain("SECRET");
  });

  it("donne à chaque fait un identifiant, pour que la validation puisse le retrouver", async () => {
    const contact = await preparer();
    const contexte = await assemblerContexte(contact.id);
    for (const fait of contexte.faits) {
      expect(fait.id).toBeTruthy();
    }
  });

  it("joint les limites dures et le résumé du fil", async () => {
    const contact = await preparer();
    const contexte = await assemblerContexte(contact.id);
    expect(contexte.hardLimits).toEqual(["Ne jamais promettre une date"]);
    expect(contexte.resumeFil).toBe("on se taquine");
  });

  it("borne l'historique aux 20 derniers messages, du plus ancien au plus récent", async () => {
    const contact = await preparer();
    const contexte = await assemblerContexte(contact.id);
    expect(contexte.derniersMessages).toHaveLength(20);
    expect(contexte.derniersMessages[0].texte).toBe("message 5");
    expect(contexte.derniersMessages[19].texte).toBe("message 24");
  });

  it("reprend les paramètres de style du contact", async () => {
    const contact = await preparer();
    const contexte = await assemblerContexte(contact.id);
    // La valeur diverge du défaut du schéma ("fr") : un test qui se contentait
    // de vérifier le défaut passerait même si assemblerContexte ne lisait
    // jamais la policy en base.
    expect(contexte.stylePolitique.langue).toBe("en");
  });

  it("fonctionne sur une persona vide sans lever", async () => {
    const contact = await prisma.contact.create({
      data: { jid: "226@s.whatsapp.net", thread: { create: {} }, policy: { create: {} } },
    });
    const contexte = await assemblerContexte(contact.id);
    expect(contexte.faits).toEqual([]);
    expect(contexte.hardLimits).toEqual([]);
  });
});
