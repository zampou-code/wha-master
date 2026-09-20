import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "@/lib/prisma";
import { ingererMessage } from "@/ingest/handler";
import { resetDb } from "../helpers/db";
import { MediaType } from "@/generated/prisma/client";

function evenement(surcharge: Record<string, unknown> = {}) {
  return {
    event: "message",
    device_id: "moi@s.whatsapp.net",
    payload: {
      id: "MSG-A",
      chat_id: "22500000001@s.whatsapp.net",
      from: "22500000001@s.whatsapp.net",
      from_name: "Sarah",
      body: "coucou",
      timestamp: "2026-09-17T20:04:00Z",
      is_from_me: false,
      ...surcharge,
    },
  };
}

describe("ingestion d'un message", () => {
  beforeEach(resetDb);

  it("crée le contact découvert en mode OFF (principe P1)", async () => {
    await ingererMessage(evenement(), {});
    const contact = await prisma.contact.findUnique({
      where: { jid: "22500000001@s.whatsapp.net" },
    });
    expect(contact?.mode).toBe("OFF");
    expect(contact?.pushName).toBe("Sarah");
  });

  it("crée le fil et persiste le message en IN / HUMAN", async () => {
    const resultat = await ingererMessage(evenement(), {});
    expect(resultat.statut).toBe("persiste");
    const message = await prisma.message.findUnique({ where: { waMessageId: "MSG-A" } });
    expect(message?.direction).toBe("IN");
    expect(message?.source).toBe("HUMAN");
    expect(message?.text).toBe("coucou");
    expect(await prisma.thread.count()).toBe(1);
  });

  it("persiste un message sortant envoyé depuis le téléphone en OUT / HUMAN", async () => {
    await ingererMessage(evenement({ id: "MSG-B", is_from_me: true, from: "moi@s.whatsapp.net" }), {});
    const message = await prisma.message.findUnique({ where: { waMessageId: "MSG-B" } });
    expect(message?.direction).toBe("OUT");
    expect(message?.source).toBe("HUMAN");
  });

  it("ignore un doublon sans lever d'erreur", async () => {
    await ingererMessage(evenement(), {});
    const resultat = await ingererMessage(evenement(), {});
    expect(resultat.statut).toBe("doublon");
    expect(await prisma.message.count()).toBe(1);
  });

  it("gère une livraison concurrente du même message sans crash ni doublon (rejeu GOWA)", async () => {
    const [resultatA, resultatB] = await Promise.all([
      ingererMessage(evenement(), {}),
      ingererMessage(evenement(), {}),
    ]);
    expect([resultatA.statut, resultatB.statut].sort()).toEqual(["doublon", "persiste"]);
    expect(await prisma.message.count()).toBe(1);
  });

  it("n'ingère pas les messages du groupe de contrôle", async () => {
    const resultat = await ingererMessage(
      evenement({ id: "MSG-C", chat_id: "1234-5678@g.us" }),
      { controlGroupJid: "1234-5678@g.us" },
    );
    expect(resultat.statut).toBe("groupe_de_controle");
    expect(await prisma.message.count()).toBe(0);
  });

  it("enregistre le type de média quand le message n'est pas textuel", async () => {
    await ingererMessage(
      evenement({ id: "MSG-D", body: undefined, audio: { url: "https://exemple" } }),
      {},
    );
    const message = await prisma.message.findUnique({ where: { waMessageId: "MSG-D" } });
    expect(message?.mediaType).toBe(MediaType.AUDIO);
    expect(message?.text).toBeNull();
  });

  it("met à jour lastMessageAt du fil", async () => {
    await ingererMessage(evenement(), {});
    const fil = await prisma.thread.findFirst();
    expect(fil?.lastMessageAt?.toISOString()).toBe("2026-09-17T20:04:00.000Z");
  });

  it("ne change jamais le mode d'un contact déjà activé", async () => {
    await prisma.contact.create({
      data: { jid: "22500000001@s.whatsapp.net", mode: "AUTO", thread: { create: {} } },
    });
    await ingererMessage(evenement(), {});
    const contact = await prisma.contact.findUnique({
      where: { jid: "22500000001@s.whatsapp.net" },
    });
    expect(contact?.mode).toBe("AUTO");
  });

  it("répare une Decision manquante quand GOWA rejoue un webhook déjà traité (P5, R18)", async () => {
    const premier = await ingererMessage(evenement({ id: "MSG-E" }), {});
    expect(premier.statut).toBe("persiste");
    const messageId = premier.messageId!;

    // Simule une panne transitoire lors du premier passage : le message est
    // persisté mais la Decision n'a jamais été écrite (deciderEtTracer était
    // tombé après la persistance du message).
    await prisma.decision.deleteMany({ where: { messageId } });
    expect(await prisma.decision.count()).toBe(0);

    const rejeu = await ingererMessage(evenement({ id: "MSG-E" }), {});
    expect(rejeu.statut).toBe("doublon");
    const decision = await prisma.decision.findUnique({ where: { messageId } });
    expect(decision).not.toBeNull();
  });
});
