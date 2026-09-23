import { describe, it, expect, beforeEach, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import { ContactMode, StatutEnvoi } from "@/generated/prisma/client";
import { traiterEnvoiAutonome } from "@/envoi/auto";
import { resetEnvCache } from "@/config/env";
import { resetDb } from "../helpers/db";

// Le rédacteur est simulé : c'est lui qui décide si le système répond seul ou
// demande, et c'est justement cette bifurcation qu'on éprouve ici.
const rediger = vi.fn();
vi.mock("@/redacteur/redacteur", () => ({ rediger: (...args: unknown[]) => rediger(...args) }));

const envoyerControle = vi.fn();
vi.mock("@/gowa/client", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/gowa/client")>();
  return {
    ...original,
    createGowaClient: () => ({ sendText: envoyerControle }),
  };
});

function redactionReussie(brouillon: string) {
  return { brouillon, motifRefus: null, regleRefus: null, fournisseur: "test", latencyMs: 5, costUsd: 0 };
}
function redactionRefusee(regle: string) {
  return {
    brouillon: null,
    motifRefus: "Le rédacteur s'est appuyé sur un fait inconnu.",
    regleRefus: regle,
    fournisseur: "test",
    latencyMs: 5,
    costUsd: 0,
  };
}

async function contactAvecDecision() {
  const contact = await prisma.contact.create({
    data: { jid: "225@s.whatsapp.net", alias: "sarah", mode: ContactMode.AUTO, thread: { create: {} }, policy: { create: {} } },
    include: { thread: true },
  });
  const message = await prisma.message.create({
    data: {
      threadId: contact.thread!.id, waMessageId: `M-${Math.random()}`,
      direction: "IN", source: "HUMAN", text: "coucou ça va ?", timestamp: new Date(),
    },
  });
  const decision = await prisma.decision.create({
    data: { messageId: message.id, contactId: contact.id, risks: [], ruleFired: "table.auto", outcome: "DRAFTED" },
  });
  return { contact, decision };
}

describe("chemin autonome", () => {
  beforeEach(async () => {
    await resetDb();
    rediger.mockReset();
    envoyerControle.mockReset();
    envoyerControle.mockResolvedValue({ messageId: "WA-CTRL-1" });
    process.env.CONTROL_GROUP_JID = "1234-5678@g.us";
    resetEnvCache();
  });

  it("planifie un envoi quand le rédacteur produit un brouillon valide", async () => {
    const { contact, decision } = await contactAvecDecision();
    rediger.mockResolvedValue(redactionReussie("Rien de spécial, et toi ?"));

    const issue = await traiterEnvoiAutonome({
      decisionId: decision.id, contactId: contact.id, messageRecu: "coucou ça va ?", risques: [],
    });

    expect(issue.planifie).toBe(true);
    const envoi = await prisma.envoiPlanifie.findFirst();
    expect(envoi?.texte).toBe("Rien de spécial, et toi ?");
    expect(envoi?.statut).toBe(StatutEnvoi.EN_ATTENTE);
    // Rien n'est encore parti, et aucune escalade n'a été ouverte.
    expect(await prisma.escalation.count()).toBe(0);
  });

  it("escalade au lieu d'envoyer quand la validation refuse le brouillon", async () => {
    // Le principe : en cas d'anomalie, on demande, on n'envoie pas.
    const { contact, decision } = await contactAvecDecision();
    rediger.mockResolvedValue(redactionRefusee("p4.fait-inconnu"));

    const issue = await traiterEnvoiAutonome({
      decisionId: decision.id, contactId: contact.id, messageRecu: "tu as quel âge ?", risques: [],
    });

    expect(issue.planifie).toBe(false);
    expect(await prisma.envoiPlanifie.count()).toBe(0);
    expect(await prisma.escalation.count()).toBe(1);
  });

  it("escalade aussi quand le rédacteur est indisponible", async () => {
    const { contact, decision } = await contactAvecDecision();
    rediger.mockResolvedValue(redactionRefusee("redacteur.indisponible"));

    const issue = await traiterEnvoiAutonome({
      decisionId: decision.id, contactId: contact.id, messageRecu: "coucou", risques: [],
    });

    expect(issue.planifie).toBe(false);
    expect(await prisma.escalation.count()).toBe(1);
  });

  it("escalade quand l'assemblage du contexte lève, sans laisser le message sans suite", async () => {
    const { contact, decision } = await contactAvecDecision();
    rediger.mockRejectedValue(new Error("base injoignable"));

    const issue = await traiterEnvoiAutonome({
      decisionId: decision.id, contactId: contact.id, messageRecu: "coucou", risques: [],
    });

    expect(issue.planifie).toBe(false);
    expect(await prisma.envoiPlanifie.count()).toBe(0);
    expect(await prisma.escalation.count()).toBe(1);
  });

  it("ne planifie rien pour un contact qui n'existe plus", async () => {
    const { decision } = await contactAvecDecision();
    rediger.mockResolvedValue(redactionReussie("coucou"));
    const issue = await traiterEnvoiAutonome({
      decisionId: decision.id, contactId: "disparu", messageRecu: "coucou", risques: [],
    });
    expect(issue.planifie).toBe(false);
    expect(await prisma.envoiPlanifie.count()).toBe(0);
  });
});
