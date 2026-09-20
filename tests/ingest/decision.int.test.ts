import { describe, it, expect, beforeEach, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import { deciderEtTracer } from "@/ingest/decision";
import { resetDb } from "../helpers/db";
import { ContactMode, DecisionOutcome, MediaType, RiskCategory } from "@/generated/prisma/client";

async function contactAvecMessage(mode: ContactMode) {
  const contact = await prisma.contact.create({
    data: { jid: `${mode}@s.whatsapp.net`, mode, thread: { create: {} }, policy: { create: {} } },
    include: { thread: true },
  });
  const message = await prisma.message.create({
    data: {
      threadId: contact.thread!.id,
      waMessageId: `M-${mode}-${Date.now()}`,
      direction: "IN",
      source: "HUMAN",
      text: "coucou",
      timestamp: new Date(),
    },
  });
  return { contact, message };
}

const classifieurCalme = vi.fn().mockResolvedValue({
  signaux: [], confiance: 0.95, motif: "anodin", fournisseur: "test", latencyMs: 5,
});

describe("décision et traçage", () => {
  beforeEach(async () => {
    await resetDb();
    classifieurCalme.mockClear();
  });

  it("n'appelle jamais le classifieur pour un contact en OFF (P1)", async () => {
    const { contact, message } = await contactAvecMessage(ContactMode.OFF);
    const verdict = await deciderEtTracer({
      messageId: message.id, contactId: contact.id, texte: "on se voit vendredi ?",
      typeMedia: null, classifierImpl: classifieurCalme,
    });
    expect(verdict.issue).toBe(DecisionOutcome.IGNORED);
    expect(classifieurCalme).not.toHaveBeenCalled();
  });

  it("persiste une Decision liée au message, avec la règle déclenchée", async () => {
    const { contact, message } = await contactAvecMessage(ContactMode.DRAFT);
    // Note : la règle lexicale « argent.demande » exige une unité monétaire
    // accolée au nombre (voir tests/decision/regles-lexicales.test.ts) ; un
    // montant nu comme « 50000 ? » ne déclenche rien.
    await deciderEtTracer({
      messageId: message.id, contactId: contact.id, texte: "tu peux m'envoyer 50000 F ?",
      typeMedia: null, classifierImpl: classifieurCalme,
    });
    const decision = await prisma.decision.findUnique({ where: { messageId: message.id } });
    expect(decision).not.toBeNull();
    expect(decision!.outcome).toBe(DecisionOutcome.ESCALATED);
    expect(decision!.risks).toContain(RiskCategory.MONEY);
    expect(decision!.ruleFired).toMatch(/argent/);
  });

  it("réunit les signaux lexicaux et ceux du classifieur, sans intersection (P3)", async () => {
    const { contact, message } = await contactAvecMessage(ContactMode.DRAFT);
    const classifieurComplaisant = vi.fn().mockResolvedValue({
      signaux: [], confiance: 0.99, motif: "rien à signaler", fournisseur: "t", latencyMs: 1,
    });
    await deciderEtTracer({
      messageId: message.id, contactId: contact.id, texte: "on se voit vendredi ?",
      typeMedia: null, classifierImpl: classifieurComplaisant,
    });
    const decision = await prisma.decision.findUnique({ where: { messageId: message.id } });
    // Le classifieur n'a rien vu ; la règle lexicale, si. L'union l'emporte.
    expect(decision!.risks).toContain(RiskCategory.ENGAGEMENT);
    expect(decision!.outcome).toBe(DecisionOutcome.ESCALATED);
  });

  it("escalade un média sans jamais appeler le classifieur", async () => {
    const { contact, message } = await contactAvecMessage(ContactMode.DRAFT);
    const verdict = await deciderEtTracer({
      messageId: message.id, contactId: contact.id, texte: null,
      typeMedia: MediaType.AUDIO, classifierImpl: classifieurCalme,
    });
    expect(verdict.issue).toBe(DecisionOutcome.ESCALATED);
    expect(verdict.risques).toContain(RiskCategory.NON_TEXT);
    expect(classifieurCalme).not.toHaveBeenCalled();
  });

  it("enregistre le fournisseur et la latence quand le classifieur a répondu", async () => {
    const { contact, message } = await contactAvecMessage(ContactMode.DRAFT);
    await deciderEtTracer({
      messageId: message.id, contactId: contact.id, texte: "haha t'es fou",
      typeMedia: null, classifierImpl: classifieurCalme,
    });
    const decision = await prisma.decision.findUnique({ where: { messageId: message.id } });
    expect(decision!.classifierProvider).toBe("test");
    expect(decision!.latencyMs).toBe(5);
  });

  it("ne modifie jamais le mode du contact (P1)", async () => {
    const { contact, message } = await contactAvecMessage(ContactMode.AUTO);
    await deciderEtTracer({
      messageId: message.id, contactId: contact.id, texte: "haha",
      typeMedia: null, classifierImpl: classifieurCalme,
    });
    const apres = await prisma.contact.findUnique({ where: { id: contact.id } });
    expect(apres!.mode).toBe(ContactMode.AUTO);
  });
});
