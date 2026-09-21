import { describe, it, expect, beforeEach, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import { traiterMessageControle } from "@/controle/routeur";
import { resetDb } from "../helpers/db";

async function escaladeOuverte(proposition: string | null = "Vendredi ça me va") {
  const contact = await prisma.contact.create({
    data: { jid: "22500000001@s.whatsapp.net", alias: "sarah", mode: "DRAFT", thread: { create: {} }, policy: { create: {} } },
    include: { thread: true },
  });
  const message = await prisma.message.create({
    data: {
      threadId: contact.thread!.id, waMessageId: `M-${Date.now()}-${Math.random()}`,
      direction: "IN", source: "HUMAN", text: "on se voit vendredi ?", timestamp: new Date(),
    },
  });
  const decision = await prisma.decision.create({
    data: {
      messageId: message.id, contactId: contact.id, risks: ["ENGAGEMENT"],
      ruleFired: "risque.engagement.rendez-vous", outcome: "ESCALATED",
    },
  });
  const escalade = await prisma.escalation.create({
    data: {
      decisionId: decision.id, proposedText: proposition,
      controlMessageWaId: "WA-CTRL-1", expiresAt: new Date(Date.now() + 3_600_000),
    },
  });
  return { contact, escalade };
}

describe("routeur du groupe de contrôle", () => {
  beforeEach(resetDb);

  it("envoie la proposition au contact sur « 1 » et résout l'escalade", async () => {
    const { contact, escalade } = await escaladeOuverte();
    const envoyer = vi.fn().mockResolvedValue(undefined);
    const r = await traiterMessageControle({ texte: "1", replyToWaId: "WA-CTRL-1", envoyer });
    expect(envoyer).toHaveBeenCalledWith(contact.jid, "Vendredi ça me va");
    expect(r.action).toBe("envoyer");
    const apres = await prisma.escalation.findUnique({ where: { id: escalade.id } });
    expect(apres?.status).toBe("RESOLVED");
    expect(apres?.resolvedText).toBe("Vendredi ça me va");
  });

  it("envoie le texte de l'utilisateur plutôt que la proposition", async () => {
    const { contact } = await escaladeOuverte();
    const envoyer = vi.fn().mockResolvedValue(undefined);
    await traiterMessageControle({ texte: "2 je passe dimanche", replyToWaId: "WA-CTRL-1", envoyer });
    expect(envoyer).toHaveBeenCalledWith(contact.jid, "je passe dimanche");
  });

  it("refuse « 1 » quand l'escalade n'a pas de proposition", async () => {
    await escaladeOuverte(null);
    const envoyer = vi.fn();
    const r = await traiterMessageControle({ texte: "1", replyToWaId: "WA-CTRL-1", envoyer });
    expect(envoyer).not.toHaveBeenCalled();
    expect(r.reponse).toMatch(/aucune proposition/i);
  });

  it("résout sans rien envoyer sur « 3 »", async () => {
    const { escalade } = await escaladeOuverte();
    const envoyer = vi.fn();
    await traiterMessageControle({ texte: "3", replyToWaId: "WA-CTRL-1", envoyer });
    expect(envoyer).not.toHaveBeenCalled();
    const apres = await prisma.escalation.findUnique({ where: { id: escalade.id } });
    expect(apres?.status).toBe("RESOLVED");
  });

  it("passe le contact en DRAFT sur « 4 », sans jamais l'activer", async () => {
    const { contact } = await escaladeOuverte();
    await prisma.contact.update({ where: { id: contact.id }, data: { mode: "AUTO" } });
    await traiterMessageControle({ texte: "4", replyToWaId: "WA-CTRL-1", envoyer: vi.fn() });
    const apres = await prisma.contact.findUnique({ where: { id: contact.id } });
    expect(apres?.mode).toBe("DRAFT");
  });

  it("refuse une action d'escalade sans réponse native, plutôt que de deviner laquelle", async () => {
    await escaladeOuverte();
    const envoyer = vi.fn();
    const r = await traiterMessageControle({ texte: "1", replyToWaId: null, envoyer });
    expect(envoyer).not.toHaveBeenCalled();
    expect(r.reponse).toMatch(/réponds au message/i);
  });

  it("refuse d'agir sur une escalade déjà résolue", async () => {
    const { escalade } = await escaladeOuverte();
    await prisma.escalation.update({ where: { id: escalade.id }, data: { status: "RESOLVED" } });
    const envoyer = vi.fn();
    const r = await traiterMessageControle({ texte: "1", replyToWaId: "WA-CTRL-1", envoyer });
    expect(envoyer).not.toHaveBeenCalled();
    expect(r.reponse).toMatch(/déjà/i);
  });

  it("bascule la pause globale sur /stop et /go", async () => {
    await traiterMessageControle({ texte: "/stop", replyToWaId: null, envoyer: vi.fn() });
    let etat = await prisma.systemState.findUnique({ where: { id: "singleton" } });
    expect(etat?.globalPaused).toBe(true);
    await traiterMessageControle({ texte: "/go", replyToWaId: null, envoyer: vi.fn() });
    etat = await prisma.systemState.findUnique({ where: { id: "singleton" } });
    expect(etat?.globalPaused).toBe(false);
  });

  it("refuse /mode sur un contact inconnu (P1)", async () => {
    const r = await traiterMessageControle({ texte: "/mode inconnue auto", replyToWaId: null, envoyer: vi.fn() });
    expect(r.reponse).toMatch(/introuvable|interface/i);
    expect(await prisma.contact.count()).toBe(0);
  });

  it("change le mode d'un contact connu", async () => {
    const { contact } = await escaladeOuverte();
    await traiterMessageControle({ texte: "/mode sarah off", replyToWaId: null, envoyer: vi.fn() });
    const apres = await prisma.contact.findUnique({ where: { id: contact.id } });
    expect(apres?.mode).toBe("OFF");
  });

  it("répond quelque chose d'utile sur une commande inconnue", async () => {
    const r = await traiterMessageControle({ texte: "/danse", replyToWaId: null, envoyer: vi.fn() });
    expect(r.action).toBe("inconnue");
    expect(r.reponse.length).toBeGreaterThan(0);
  });

  it("répond l'aide sur une commande inconnue sans réponse à une escalade, pas l'invitation à répondre", async () => {
    const r = await traiterMessageControle({ texte: "/danse", replyToWaId: null, envoyer: vi.fn() });
    expect(r.action).toBe("inconnue");
    expect(r.reponse).not.toMatch(/réponds au message/i);
    expect(r.reponse.length).toBeGreaterThan(0);
  });
});
