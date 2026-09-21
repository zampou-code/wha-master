import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import { expirerEscalades } from "@/escalade/expiration";
import { resetEnvCache } from "@/config/env";
import { resetDb } from "../helpers/db";

async function escalade(expiresAt: Date, status: "OPEN" | "RESOLVED" = "OPEN") {
  const contact = await prisma.contact.create({
    data: { jid: `${Math.random()}@s.whatsapp.net`, alias: "sarah", thread: { create: {} }, policy: { create: {} } },
    include: { thread: true },
  });
  const message = await prisma.message.create({
    data: {
      threadId: contact.thread!.id, waMessageId: `M-${Math.random()}`,
      direction: "IN", source: "HUMAN", text: "x", timestamp: new Date(),
    },
  });
  const decision = await prisma.decision.create({
    data: { messageId: message.id, contactId: contact.id, risks: [], ruleFired: "r", outcome: "ESCALATED" },
  });
  return prisma.escalation.create({ data: { decisionId: decision.id, status, expiresAt } });
}

// `getEnv()` met sa lecture en cache au niveau du module : chaque mutation de
// `process.env.CONTROL_GROUP_JID` dans ce fichier doit être suivie de
// `resetEnvCache()`, sans quoi la valeur observée par `expirerEscalades`
// resterait celle lue lors du tout premier appel du fichier.
describe("expiration des escalades", () => {
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

  it("expire une escalade ouverte dont l'échéance est passée", async () => {
    const e = await escalade(new Date(Date.now() - 1000));
    const r = await expirerEscalades({ envoyer: vi.fn() });
    expect(r.expirees).toBe(1);
    const apres = await prisma.escalation.findUnique({ where: { id: e.id } });
    expect(apres?.status).toBe("EXPIRED");
  });

  it("laisse intacte une escalade encore valide", async () => {
    const e = await escalade(new Date(Date.now() + 3_600_000));
    await expirerEscalades({ envoyer: vi.fn() });
    const apres = await prisma.escalation.findUnique({ where: { id: e.id } });
    expect(apres?.status).toBe("OPEN");
  });

  it("ne touche pas une escalade déjà résolue", async () => {
    const e = await escalade(new Date(Date.now() - 1000), "RESOLVED");
    await expirerEscalades({ envoyer: vi.fn() });
    const apres = await prisma.escalation.findUnique({ where: { id: e.id } });
    expect(apres?.status).toBe("RESOLVED");
  });

  it("poste un rappel unique plutôt qu'un message par escalade", async () => {
    await escalade(new Date(Date.now() - 1000));
    await escalade(new Date(Date.now() - 2000));
    const envoyer = vi.fn().mockResolvedValue({});
    await expirerEscalades({ envoyer });
    expect(envoyer).toHaveBeenCalledTimes(1);
    expect(String(envoyer.mock.calls[0][1])).toContain("2");
  });

  it("n'envoie aucun rappel quand rien n'a expiré", async () => {
    await escalade(new Date(Date.now() + 3_600_000));
    const envoyer = vi.fn();
    await expirerEscalades({ envoyer });
    expect(envoyer).not.toHaveBeenCalled();
  });

  it("n'envoie jamais rien au contact — seul le groupe est destinataire", async () => {
    await escalade(new Date(Date.now() - 1000));
    const envoyer = vi.fn().mockResolvedValue({});
    await expirerEscalades({ envoyer });
    expect(envoyer.mock.calls[0][0]).toBe("1234-5678@g.us");
  });
});
