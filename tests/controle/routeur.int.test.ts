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
    const envoyer = vi.fn().mockResolvedValue({ messageId: "WA-OUT-1" });
    const r = await traiterMessageControle({ texte: "1", replyToWaId: "WA-CTRL-1", envoyer });
    expect(envoyer).toHaveBeenCalledWith(contact.jid, "Vendredi ça me va");
    expect(r.action).toBe("envoyer");
    const apres = await prisma.escalation.findUnique({ where: { id: escalade.id } });
    expect(apres?.status).toBe("RESOLVED");
    expect(apres?.resolvedText).toBe("Vendredi ça me va");
  });

  it("envoie le texte de l'utilisateur plutôt que la proposition", async () => {
    const { contact } = await escaladeOuverte();
    const envoyer = vi.fn().mockResolvedValue({ messageId: "WA-OUT-1" });
    await traiterMessageControle({ texte: "2 je passe dimanche", replyToWaId: "WA-CTRL-1", envoyer });
    expect(envoyer).toHaveBeenCalledWith(contact.jid, "je passe dimanche");
  });

  it("refuse « 1 » quand l'escalade n'a pas de proposition", async () => {
    await escaladeOuverte(null);
    const envoyer = vi.fn().mockResolvedValue({ messageId: "WA-OUT-1" });
    const r = await traiterMessageControle({ texte: "1", replyToWaId: "WA-CTRL-1", envoyer });
    expect(envoyer).not.toHaveBeenCalled();
    expect(r.reponse).toMatch(/aucune proposition/i);
  });

  it("résout sans rien envoyer sur « 3 »", async () => {
    const { escalade } = await escaladeOuverte();
    const envoyer = vi.fn().mockResolvedValue({ messageId: "WA-OUT-1" });
    await traiterMessageControle({ texte: "3", replyToWaId: "WA-CTRL-1", envoyer });
    expect(envoyer).not.toHaveBeenCalled();
    const apres = await prisma.escalation.findUnique({ where: { id: escalade.id } });
    expect(apres?.status).toBe("RESOLVED");
  });

  it("passe le contact en DRAFT sur « 4 » depuis AUTO", async () => {
    const { contact } = await escaladeOuverte();
    await prisma.contact.update({ where: { id: contact.id }, data: { mode: "AUTO" } });
    await traiterMessageControle({ texte: "4", replyToWaId: "WA-CTRL-1", envoyer: vi.fn() });
    const apres = await prisma.contact.findUnique({ where: { id: contact.id } });
    expect(apres?.mode).toBe("DRAFT");
  });

  it("ne réactive jamais un contact OFF sur « 4 » (P1) : classe l'escalade sans y toucher", async () => {
    const { contact, escalade } = await escaladeOuverte();
    await prisma.contact.update({ where: { id: contact.id }, data: { mode: "OFF" } });
    const envoyer = vi.fn().mockResolvedValue({ messageId: "WA-OUT-1" });
    await traiterMessageControle({ texte: "4", replyToWaId: "WA-CTRL-1", envoyer });
    expect(envoyer).not.toHaveBeenCalled();
    const contactApres = await prisma.contact.findUnique({ where: { id: contact.id } });
    expect(contactApres?.mode).toBe("OFF");
    const escaladeApres = await prisma.escalation.findUnique({ where: { id: escalade.id } });
    expect(escaladeApres?.status).toBe("RESOLVED");
  });

  it("refuse une action d'escalade sans réponse native, plutôt que de deviner laquelle", async () => {
    await escaladeOuverte();
    const envoyer = vi.fn().mockResolvedValue({ messageId: "WA-OUT-1" });
    const r = await traiterMessageControle({ texte: "1", replyToWaId: null, envoyer });
    expect(envoyer).not.toHaveBeenCalled();
    expect(r.reponse).toMatch(/réponds au message/i);
  });

  it("refuse d'agir sur une escalade déjà résolue", async () => {
    const { escalade } = await escaladeOuverte();
    await prisma.escalation.update({ where: { id: escalade.id }, data: { status: "RESOLVED" } });
    const envoyer = vi.fn().mockResolvedValue({ messageId: "WA-OUT-1" });
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

  it("refuse de réactiver un contact OFF via /mode (P1) : l'existence ne suffit pas", async () => {
    const { contact } = await escaladeOuverte();
    await prisma.contact.update({ where: { id: contact.id }, data: { mode: "OFF" } });
    const r = await traiterMessageControle({ texte: "/mode sarah auto", replyToWaId: null, envoyer: vi.fn() });
    expect(r.reponse).toMatch(/désactivé|interface/i);
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

  it("refuse d'agir quand deux escalades partagent le même identifiant de message de contrôle (base corrompue)", async () => {
    const { escalade: escalade1 } = await escaladeOuverte();

    const contact2 = await prisma.contact.create({
      data: {
        jid: "22500000002@s.whatsapp.net", alias: "yasmine", mode: "DRAFT",
        thread: { create: {} }, policy: { create: {} },
      },
      include: { thread: true },
    });
    const message2 = await prisma.message.create({
      data: {
        threadId: contact2.thread!.id, waMessageId: `M2-${Date.now()}-${Math.random()}`,
        direction: "IN", source: "HUMAN", text: "tu es dispo demain ?", timestamp: new Date(),
      },
    });
    const decision2 = await prisma.decision.create({
      data: {
        messageId: message2.id, contactId: contact2.id, risks: ["ENGAGEMENT"],
        ruleFired: "risque.engagement.rendez-vous", outcome: "ESCALATED",
      },
    });

    // La contrainte `@unique` sur `controlMessageWaId` empêche cette
    // collision par la voie normale (Prisma comme SQL brut : c'est un index
    // au niveau de la base). On simule donc une base déjà corrompue — donnée
    // antérieure à la contrainte, import direct — en désactivant
    // temporairement l'index le temps de l'insertion : c'est justement ce
    // cas-là que le routeur doit refuser tout seul, indépendamment de la
    // contrainte SQL.
    await prisma.$executeRawUnsafe(`DROP INDEX "Escalation_controlMessageWaId_key"`);
    let escalade2: { id: string } | null = null;
    try {
      escalade2 = await prisma.escalation.create({
        data: {
          decisionId: decision2.id, proposedText: "Demain plutôt",
          controlMessageWaId: "WA-CTRL-1", expiresAt: new Date(Date.now() + 3_600_000),
        },
      });

      const envoyer = vi.fn().mockResolvedValue({ messageId: "WA-OUT-1" });
      const r = await traiterMessageControle({ texte: "1", replyToWaId: "WA-CTRL-1", envoyer });
      expect(envoyer).not.toHaveBeenCalled();
      expect(r.reponse).toMatch(/réponds au message/i);

      const apres1 = await prisma.escalation.findUnique({ where: { id: escalade1.id } });
      expect(apres1?.status).toBe("OPEN");
    } finally {
      // La duplication doit disparaître avant de recréer l'index, sinon
      // Postgres refuse de le reposer — on ne laisse pas le prochain test
      // hériter d'une base sans la contrainte.
      if (escalade2) {
        await prisma.escalation.delete({ where: { id: escalade2.id } });
      }
      await prisma.$executeRawUnsafe(
        `CREATE UNIQUE INDEX "Escalation_controlMessageWaId_key" ON "Escalation"("controlMessageWaId")`,
      );
    }
  });

  it("distingue une commande qui agit d'une commande qui n'agit pas", async () => {
    // L'accusé de réception posté dans le groupe choisit ✅ ou ↩️ d'après ce
    // drapeau. Sans lui, `/mode` sur un alias introuvable portait la même
    // action qu'un `/mode` appliqué et recevait un ✅ trompeur.
    const { contact } = await escaladeOuverte();
    const envoyer = vi.fn().mockResolvedValue({ messageId: "WA-OUT-1" });

    expect((await traiterMessageControle({ texte: "/mode fantome auto", replyToWaId: null, envoyer })).aboutie).toBe(false);
    expect((await traiterMessageControle({ texte: "/qui fantome", replyToWaId: null, envoyer })).aboutie).toBe(false);
    expect((await traiterMessageControle({ texte: "/danse", replyToWaId: null, envoyer })).aboutie).toBe(false);
    expect((await traiterMessageControle({ texte: "1", replyToWaId: null, envoyer })).aboutie).toBe(false);

    expect((await traiterMessageControle({ texte: "/stop", replyToWaId: null, envoyer })).aboutie).toBe(true);
    expect((await traiterMessageControle({ texte: "/go", replyToWaId: null, envoyer })).aboutie).toBe(true);
    expect((await traiterMessageControle({ texte: `/qui ${contact.alias}`, replyToWaId: null, envoyer })).aboutie).toBe(true);
    expect((await traiterMessageControle({ texte: "1", replyToWaId: "WA-CTRL-1", envoyer })).aboutie).toBe(true);

    // Rejeu sur une escalade désormais résolue : plus aucun effet.
    expect((await traiterMessageControle({ texte: "1", replyToWaId: "WA-CTRL-1", envoyer })).aboutie).toBe(false);
  });

  it("n'envoie rien quand la pause globale est active, mais laisse classer", async () => {
    // Le bouton panique doit tenir des deux côtés du système. Sans ce contrôle,
    // « /stop » puis « 1 » sur une escalade encore affichée expédiait le message.
    const { contact } = await escaladeOuverte();
    const envoyer = vi.fn().mockResolvedValue({ messageId: "WA-OUT-1" });
    await traiterMessageControle({ texte: "/stop", replyToWaId: null, envoyer });

    const r1 = await traiterMessageControle({ texte: "1", replyToWaId: "WA-CTRL-1", envoyer });
    expect(envoyer).not.toHaveBeenCalled();
    expect(r1.reponse).toMatch(/pause globale/i);
    expect(r1.aboutie).toBe(false);

    const r2 = await traiterMessageControle({ texte: "2 je passe dimanche", replyToWaId: "WA-CTRL-1", envoyer });
    expect(envoyer).not.toHaveBeenCalled();
    expect(r2.aboutie).toBe(false);

    // « 3 » et « 4 » n'écrivent à personne : ils restent disponibles pour
    // classer les escalades en attente pendant la pause.
    const r3 = await traiterMessageControle({ texte: "3", replyToWaId: "WA-CTRL-1", envoyer });
    expect(r3.aboutie).toBe(true);
    expect(envoyer).not.toHaveBeenCalled();
    expect(contact.mode).toBe("DRAFT");
  });

  it("n'écrit pas à un contact désactivé depuis la publication de l'escalade (P1)", async () => {
    // Escalade publiée à 14 h, contact coupé à 15 h, « 1 » tapé à 17 h en
    // remontant le fil : le message ne doit pas partir.
    const { contact } = await escaladeOuverte();
    await prisma.contact.update({ where: { id: contact.id }, data: { mode: "OFF" } });
    const envoyer = vi.fn().mockResolvedValue({ messageId: "WA-OUT-1" });

    const r = await traiterMessageControle({ texte: "1", replyToWaId: "WA-CTRL-1", envoyer });
    expect(envoyer).not.toHaveBeenCalled();
    expect(r.aboutie).toBe(false);
    expect(r.reponse).toMatch(/désactivé/i);

    const r2 = await traiterMessageControle({ texte: "2 coucou", replyToWaId: "WA-CTRL-1", envoyer });
    expect(envoyer).not.toHaveBeenCalled();
    expect(r2.aboutie).toBe(false);
  });

  it("dit qu'une escalade a expiré plutôt que de la déclarer résolue", async () => {
    // Confondre les deux laisse croire qu'un message a été envoyé alors qu'il
    // ne l'a jamais été et ne le sera jamais.
    const { escalade } = await escaladeOuverte();
    await prisma.escalation.update({ where: { id: escalade.id }, data: { status: "EXPIRED" } });
    const envoyer = vi.fn().mockResolvedValue({ messageId: "WA-OUT-1" });

    const r = await traiterMessageControle({ texte: "1", replyToWaId: "WA-CTRL-1", envoyer });
    expect(envoyer).not.toHaveBeenCalled();
    expect(r.action).toBe("expiree");
    expect(r.reponse).toMatch(/expiré/i);
    expect(r.reponse).not.toMatch(/résolue/i);
  });

  it("refuse d'agir quand deux contacts partagent le même alias", async () => {
    // `findFirst` sans tri en choisissait un au hasard : le cas réel est un
    // changement de numéro qui laisse deux fiches au même prénom.
    await escaladeOuverte();
    const jumeau = await prisma.contact.create({
      data: { jid: "22500000002@s.whatsapp.net", alias: "sarah", mode: "DRAFT", thread: { create: {} }, policy: { create: {} } },
    });
    const envoyer = vi.fn().mockResolvedValue({ messageId: "WA-OUT-1" });

    const rMode = await traiterMessageControle({ texte: "/mode sarah auto", replyToWaId: null, envoyer });
    expect(rMode.aboutie).toBe(false);
    expect(rMode.reponse).toMatch(/plusieurs contacts/i);

    const rQui = await traiterMessageControle({ texte: "/qui sarah", replyToWaId: null, envoyer });
    expect(rQui.aboutie).toBe(false);

    // Surtout : aucun mode n'a bougé.
    const modes = await prisma.contact.findMany({ select: { mode: true } });
    expect(modes.every((m) => m.mode === "DRAFT")).toBe(true);
    expect((await prisma.contact.findUnique({ where: { id: jumeau.id } }))?.mode).toBe("DRAFT");
  });

  it("retrouve un contact quelle que soit la casse de l'alias tapé", async () => {
    const { contact } = await escaladeOuverte();
    const envoyer = vi.fn().mockResolvedValue({ messageId: "WA-OUT-1" });
    const r = await traiterMessageControle({ texte: "/qui SARAH", replyToWaId: null, envoyer });
    expect(r.aboutie).toBe(true);
    // La réponse nomme ce qui est en base, pas ce que l'utilisateur a tapé :
    // c'est l'information qui lui permet de repérer une erreur de cible.
    expect(r.reponse).toContain(contact.alias);
  });
});
