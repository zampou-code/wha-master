import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import { deciderEtTracer } from "@/ingest/decision";
import { resetDb } from "../helpers/db";
import { resetEnvCache } from "@/config/env";
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

  // `getEnv()` met sa lecture en cache au niveau du module : toute mutation de
  // `process.env.CONTROL_GROUP_JID` doit être suivie de `resetEnvCache()`
  // pour être vue par `publierEscalade`, appelé depuis `deciderEtTracer`.
  afterEach(() => {
    delete process.env.CONTROL_GROUP_JID;
    resetEnvCache();
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

  it("n'appelle jamais le classifieur quand le système est en pause globale (P1)", async () => {
    const { contact, message } = await contactAvecMessage(ContactMode.DRAFT);
    await prisma.systemState.upsert({
      where: { id: "singleton" },
      create: { id: "singleton", globalPaused: true },
      update: { globalPaused: true },
    });
    const verdict = await deciderEtTracer({
      messageId: message.id, contactId: contact.id, texte: "on se voit vendredi ?",
      typeMedia: null, classifierImpl: classifieurCalme,
    });
    expect(verdict.issue).toBe(DecisionOutcome.IGNORED);
    expect(classifieurCalme).not.toHaveBeenCalled();
  });

  it("persiste une Decision liée au message, avec la règle déclenchée", async () => {
    const { contact, message } = await contactAvecMessage(ContactMode.DRAFT);
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

  it("n'appelle jamais le classifieur pour un texte vide", async () => {
    const { contact, message } = await contactAvecMessage(ContactMode.DRAFT);
    const verdict = await deciderEtTracer({
      messageId: message.id, contactId: contact.id, texte: "",
      typeMedia: null, classifierImpl: classifieurCalme,
    });
    expect(classifieurCalme).not.toHaveBeenCalled();
    // Le contenu vide est lui-même un signal LOW_CONFIDENCE (garde-fou toujours
    // actif) : l'issue est une escalade, pas un silence qui masquerait le cas.
    expect(verdict.issue).toBe(DecisionOutcome.ESCALATED);
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

  it("enregistre le coût du classifieur dans la Decision quand il est disponible (finding 6)", async () => {
    const { contact, message } = await contactAvecMessage(ContactMode.DRAFT);
    const classifieurAvecCout = vi.fn().mockResolvedValue({
      signaux: [], confiance: 0.95, motif: "anodin", fournisseur: "test", latencyMs: 5, costUsd: 0.0032,
    });
    await deciderEtTracer({
      messageId: message.id, contactId: contact.id, texte: "haha t'es fou",
      typeMedia: null, classifierImpl: classifieurAvecCout,
    });
    const decision = await prisma.decision.findUnique({ where: { messageId: message.id } });
    expect(decision!.costUsd).toBe(0.0032);
  });

  it("n'écrit pas de coût quand le court-circuit du Gate 0 empêche tout appel au classifieur (P1)", async () => {
    const { contact, message } = await contactAvecMessage(ContactMode.OFF);
    await deciderEtTracer({
      messageId: message.id, contactId: contact.id, texte: "on se voit vendredi ?",
      typeMedia: null, classifierImpl: classifieurCalme,
    });
    const decision = await prisma.decision.findUnique({ where: { messageId: message.id } });
    expect(decision!.costUsd).toBeNull();
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

  it("publie une escalade quand le verdict est ESCALATED", async () => {
    process.env.CONTROL_GROUP_JID = "1234-5678@g.us";
    resetEnvCache();
    const { contact, message } = await contactAvecMessage(ContactMode.DRAFT);
    await deciderEtTracer({
      messageId: message.id, contactId: contact.id, texte: "tu peux m'envoyer 50000 F ?",
      typeMedia: null, classifierImpl: classifieurCalme,
    });
    const decision = await prisma.decision.findUnique({
      where: { messageId: message.id }, include: { escalation: true },
    });
    expect(decision?.escalation).not.toBeNull();
  });

  it("ne publie pas d'escalade sur un verdict IGNORED (P1)", async () => {
    process.env.CONTROL_GROUP_JID = "1234-5678@g.us";
    resetEnvCache();
    const { contact, message } = await contactAvecMessage(ContactMode.OFF);
    await deciderEtTracer({
      messageId: message.id, contactId: contact.id, texte: "on se voit vendredi ?",
      typeMedia: null, classifierImpl: classifieurCalme,
    });
    const decision = await prisma.decision.findUnique({
      where: { messageId: message.id }, include: { escalation: true },
    });
    expect(decision?.escalation).toBeNull();
  });
});
