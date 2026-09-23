import { describe, it, expect, beforeEach, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import { MessageSource, ContactMode } from "@/generated/prisma/client";
import { consignerEnvoi } from "@/envoi/journal";
import { traiterMessageControle } from "@/controle/routeur";
import { assemblerContexte } from "@/redacteur/contexte";
import { resetDb } from "../helpers/db";

async function contact(mode: ContactMode = ContactMode.DRAFT) {
  return prisma.contact.create({
    data: { jid: "225@s.whatsapp.net", alias: "sarah", mode, thread: { create: {} }, policy: { create: {} } },
  });
}

describe("journal des envois", () => {
  beforeEach(resetDb);

  it("consigne le message sortant et le rend visible au rédacteur", async () => {
    // Sans ça, le rédacteur ne voyait jamais ce qu'il venait de faire envoyer
    // et rédigeait le tour suivant comme si la conversation s'était arrêtée au
    // message du contact.
    const c = await contact();
    await consignerEnvoi({
      contactId: c.id, texte: "Vendredi ça me va", waMessageId: "WA-1", source: MessageSource.HUMAN,
    });

    const contexte = await assemblerContexte(c.id);
    expect(contexte.derniersMessages).toEqual([{ direction: "OUT", texte: "Vendredi ça me va" }]);
  });

  it("avance le fil pour que la dormance se calcule sur le dernier échange réel", async () => {
    const c = await contact();
    const avant = await prisma.thread.findUnique({ where: { contactId: c.id } });
    expect(avant?.lastMessageAt).toBeNull();

    await consignerEnvoi({ contactId: c.id, texte: "coucou", source: MessageSource.HUMAN });
    const apres = await prisma.thread.findUnique({ where: { contactId: c.id } });
    expect(apres?.lastMessageAt).not.toBeNull();
  });

  it("fait monter le compteur sur un envoi automatique", async () => {
    // Le garde-fou « plafond de messages automatiques consécutifs » lit ce
    // compteur. Tant que personne ne l'écrivait, il ne pouvait jamais se
    // déclencher.
    const c = await contact(ContactMode.AUTO);
    for (let i = 0; i < 3; i++) {
      await consignerEnvoi({
        contactId: c.id, texte: `auto ${i}`, waMessageId: `WA-A${i}`, source: MessageSource.AUTO,
      });
    }
    const fil = await prisma.thread.findUnique({ where: { contactId: c.id } });
    expect(fil?.autoStreak).toBe(3);
  });

  it("remet le compteur à zéro dès que l'utilisateur reprend la main", async () => {
    const c = await contact(ContactMode.AUTO);
    await consignerEnvoi({ contactId: c.id, texte: "a", waMessageId: "WA-A", source: MessageSource.AUTO });
    await consignerEnvoi({ contactId: c.id, texte: "b", waMessageId: "WA-B", source: MessageSource.AUTO });
    await consignerEnvoi({ contactId: c.id, texte: "moi", waMessageId: "WA-H", source: MessageSource.HUMAN });

    const fil = await prisma.thread.findUnique({ where: { contactId: c.id } });
    expect(fil?.autoStreak).toBe(0);
  });

  it("ne crée pas deux lignes si le même envoi est consigné deux fois", async () => {
    const c = await contact();
    await consignerEnvoi({ contactId: c.id, texte: "x", waMessageId: "WA-1", source: MessageSource.HUMAN });
    await consignerEnvoi({ contactId: c.id, texte: "x", waMessageId: "WA-1", source: MessageSource.HUMAN });
    expect(await prisma.message.count({ where: { direction: "OUT" } })).toBe(1);
  });

  it("consigne quand même un envoi dont WhatsApp ne rend pas l'identifiant", async () => {
    // Perdre la trace d'un message réellement parti serait pire que de lui
    // donner un identifiant de repli.
    const c = await contact();
    await consignerEnvoi({ contactId: c.id, texte: "sans identifiant", source: MessageSource.HUMAN });
    const message = await prisma.message.findFirst({ where: { direction: "OUT" } });
    expect(message?.text).toBe("sans identifiant");
    expect(message?.waMessageId).toMatch(/^local-/);
  });

  it("consigne l'envoi déclenché par « 1 » dans le groupe de contrôle", async () => {
    // Le vrai chemin, de bout en bout : la commande envoie ET laisse une trace.
    const c = await contact();
    const fil = await prisma.thread.findUnique({ where: { contactId: c.id } });
    const message = await prisma.message.create({
      data: {
        threadId: fil!.id, waMessageId: "M-IN", direction: "IN", source: "HUMAN",
        text: "on se voit vendredi ?", timestamp: new Date(),
      },
    });
    const decision = await prisma.decision.create({
      data: { messageId: message.id, contactId: c.id, risks: [], ruleFired: "r", outcome: "ESCALATED" },
    });
    await prisma.escalation.create({
      data: {
        decisionId: decision.id, proposedText: "Vendredi ça me va",
        controlMessageWaId: "WA-CTRL-1", expiresAt: new Date(Date.now() + 3_600_000),
      },
    });

    const envoyer = vi.fn().mockResolvedValue({ messageId: "WA-OUT-9" });
    await traiterMessageControle({ texte: "1", replyToWaId: "WA-CTRL-1", envoyer });

    const sortant = await prisma.message.findUnique({ where: { waMessageId: "WA-OUT-9" } });
    expect(sortant?.text).toBe("Vendredi ça me va");
    expect(sortant?.direction).toBe("OUT");
    // Approuvé par l'utilisateur : c'est un message humain, pas automatique.
    expect(sortant?.source).toBe(MessageSource.HUMAN);
  });
});
