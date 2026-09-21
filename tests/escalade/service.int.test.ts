import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "@/lib/prisma";
import { creerEscalade, marquerPostee, DUREE_ESCALADE_MS } from "@/escalade/service";
import { resetDb } from "../helpers/db";

async function decision() {
  const contact = await prisma.contact.create({
    data: { jid: "225@s.whatsapp.net", thread: { create: {} }, policy: { create: {} } },
    include: { thread: true },
  });
  const message = await prisma.message.create({
    data: {
      threadId: contact.thread!.id, waMessageId: `M-${Date.now()}`,
      direction: "IN", source: "HUMAN", text: "on se voit vendredi ?", timestamp: new Date(),
    },
  });
  return prisma.decision.create({
    data: {
      messageId: message.id, contactId: contact.id, risks: ["ENGAGEMENT"],
      ruleFired: "risque.engagement.rendez-vous", outcome: "ESCALATED",
    },
  });
}

describe("service d'escalade", () => {
  beforeEach(resetDb);

  it("crée une escalade ouverte liée à la décision", async () => {
    const d = await decision();
    const { id } = await creerEscalade({ decisionId: d.id, proposition: "Vendredi ça me va" });
    const e = await prisma.escalation.findUnique({ where: { id } });
    expect(e?.status).toBe("OPEN");
    expect(e?.proposedText).toBe("Vendredi ça me va");
    expect(e?.decisionId).toBe(d.id);
  });

  it("fixe une échéance par défaut à six heures", async () => {
    const d = await decision();
    const avant = Date.now();
    const { id } = await creerEscalade({ decisionId: d.id, proposition: null });
    const e = await prisma.escalation.findUnique({ where: { id } });
    const ecart = e!.expiresAt.getTime() - avant;
    expect(ecart).toBeGreaterThan(DUREE_ESCALADE_MS - 5_000);
    expect(ecart).toBeLessThan(DUREE_ESCALADE_MS + 5_000);
  });

  it("enregistre l'identifiant du message de contrôle, qui sert à la résolution", async () => {
    const d = await decision();
    const { id } = await creerEscalade({ decisionId: d.id, proposition: null });
    await marquerPostee(id, "WA-CTRL-1");
    const e = await prisma.escalation.findUnique({ where: { id } });
    expect(e?.controlMessageWaId).toBe("WA-CTRL-1");
  });

  it("refuse deux escalades pour la même décision", async () => {
    const d = await decision();
    await creerEscalade({ decisionId: d.id, proposition: null });
    await expect(creerEscalade({ decisionId: d.id, proposition: null })).rejects.toThrow();
  });
});
