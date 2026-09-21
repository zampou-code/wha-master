import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import { publierEscalade } from "@/escalade/publication";
import { assemblerContexte } from "@/redacteur/contexte";
import { resetEnvCache } from "@/config/env";
import { resetDb } from "../helpers/db";

vi.mock("@/redacteur/contexte", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/redacteur/contexte")>();
  return { ...original, assemblerContexte: vi.fn(original.assemblerContexte) };
});

vi.mock("@/redacteur/redacteur", () => ({
  rediger: vi.fn().mockResolvedValue({
    brouillon: "Vendredi ça me va", motifRefus: null, regleRefus: null,
    fournisseur: "test", latencyMs: 10, costUsd: 0.0002,
  }),
}));

async function decision() {
  const contact = await prisma.contact.create({
    data: { jid: "225@s.whatsapp.net", alias: "sarah", mode: "DRAFT", thread: { create: {} }, policy: { create: {} } },
    include: { thread: true },
  });
  const message = await prisma.message.create({
    data: {
      threadId: contact.thread!.id, waMessageId: `M-${Date.now()}`,
      direction: "IN", source: "HUMAN", text: "on se voit vendredi ?", timestamp: new Date(),
    },
  });
  const d = await prisma.decision.create({
    data: {
      messageId: message.id, contactId: contact.id, risks: ["ENGAGEMENT"],
      ruleFired: "risque.engagement.rendez-vous", outcome: "ESCALATED",
    },
  });
  return { contact, decision: d };
}

// `getEnv()` met sa lecture en cache au niveau du module : chaque mutation de
// `process.env.CONTROL_GROUP_JID` dans ce fichier doit être suivie de
// `resetEnvCache()`, sans quoi la valeur observée par `publierEscalade`
// resterait celle lue lors du tout premier appel du fichier.
describe("publication d'une escalade", () => {
  beforeEach(async () => {
    await resetDb();
    process.env.CONTROL_GROUP_JID = "1234-5678@g.us";
    resetEnvCache();
  });

  // Évite de laisser `CONTROL_GROUP_JID` fuiter vers d'autres fichiers de test
  // (process.env est un objet réellement global, partagé entre fichiers).
  afterEach(() => {
    delete process.env.CONTROL_GROUP_JID;
    resetEnvCache();
  });

  it("crée l'escalade, poste le message et enregistre son identifiant", async () => {
    const { contact, decision: d } = await decision();
    const envoyer = vi.fn().mockResolvedValue({ messageId: "WA-CTRL-9" });
    const r = await publierEscalade({
      decisionId: d.id, contactId: contact.id, messageRecu: "on se voit vendredi ?",
      risques: ["ENGAGEMENT"], envoyer,
    });
    expect(r).not.toBeNull();
    expect(envoyer).toHaveBeenCalledTimes(1);
    const e = await prisma.escalation.findUnique({ where: { id: r!.escaladeId } });
    expect(e?.controlMessageWaId).toBe("WA-CTRL-9");
    expect(e?.proposedText).toBe("Vendredi ça me va");
  });

  it("poste le message dans le groupe de contrôle, pas au contact", async () => {
    const { contact, decision: d } = await decision();
    const envoyer = vi.fn().mockResolvedValue({ messageId: "WA-CTRL-9" });
    await publierEscalade({
      decisionId: d.id, contactId: contact.id, messageRecu: "x", risques: [], envoyer,
    });
    const [destinataire] = envoyer.mock.calls[0];
    // Nommer le groupe, pas seulement « pas le contact » : `not.toBe(contact.jid)`
    // passait aussi si le code postait vers "" ou vers n'importe qui d'autre.
    expect(destinataire).toBe("1234-5678@g.us");
    expect(destinataire).not.toBe(contact.jid);
  });

  it("ne lève pas quand le groupe de contrôle n'est pas configuré", async () => {
    const { contact, decision: d } = await decision();
    delete process.env.CONTROL_GROUP_JID;
    resetEnvCache();
    await expect(
      publierEscalade({ decisionId: d.id, contactId: contact.id, messageRecu: "x", risques: [], envoyer: vi.fn() }),
    ).resolves.toBeNull();
  });

  it("crée quand même l'escalade si l'envoi échoue, pour ne pas la perdre", async () => {
    const { contact, decision: d } = await decision();
    process.env.CONTROL_GROUP_JID = "1234-5678@g.us";
    resetEnvCache();
    const envoyer = vi.fn().mockRejectedValue(new Error("GOWA injoignable"));
    const r = await publierEscalade({
      decisionId: d.id, contactId: contact.id, messageRecu: "x", risques: [], envoyer,
    });
    expect(r).not.toBeNull();
    const e = await prisma.escalation.findUnique({ where: { id: r!.escaladeId } });
    expect(e?.status).toBe("OPEN");
    expect(e?.controlMessageWaId).toBeNull();
  });

  it("crée quand même l'escalade si le contexte de rédaction est indisponible", async () => {
    // Dans l'ordre inverse (rédiger puis créer), une panne d'assemblage faisait
    // disparaître l'alerte entière alors que la Decision disait ESCALATED : un
    // message MONEY ou INTIMATE s'évaporait entre la décision et le groupe.
    process.env.CONTROL_GROUP_JID = "1234-5678@g.us";
    resetEnvCache();
    const { contact, decision: d } = await decision();
    vi.mocked(assemblerContexte).mockRejectedValueOnce(new Error("base injoignable"));
    const envoyer = vi.fn().mockResolvedValue({ messageId: "WA-CTRL-9" });

    const r = await publierEscalade({
      decisionId: d.id, contactId: contact.id, messageRecu: "tu peux m'envoyer 50000 F ?",
      risques: ["MONEY"], envoyer,
    });

    expect(r).not.toBeNull();
    const e = await prisma.escalation.findUnique({ where: { id: r!.escaladeId } });
    expect(e?.status).toBe("OPEN");
    expect(e?.proposedText).toBeNull();
    // Et l'utilisateur est prévenu de ce qui manque, plutôt que de ne rien voir.
    expect(String(envoyer.mock.calls[0][1])).toMatch(/contexte de rédaction/i);
  });
});
