import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "@/lib/prisma";
import { resetDb } from "../helpers/db";

describe("modèle Contact", () => {
  beforeEach(resetDb);

  it("crée un contact en mode OFF par défaut (principe P1)", async () => {
    const contact = await prisma.contact.create({
      data: { jid: "22500000001@s.whatsapp.net" },
    });
    expect(contact.mode).toBe("OFF");
    expect(contact.isAdult).toBe(false);
    expect(contact.activatedAt).toBeNull();
  });

  it("interdit deux contacts avec le même jid", async () => {
    await prisma.contact.create({ data: { jid: "22500000002@s.whatsapp.net" } });
    await expect(
      prisma.contact.create({ data: { jid: "22500000002@s.whatsapp.net" } }),
    ).rejects.toThrow();
  });

  it("supprime le fil et les messages en cascade", async () => {
    const contact = await prisma.contact.create({
      data: {
        jid: "22500000003@s.whatsapp.net",
        thread: { create: {} },
      },
      include: { thread: true },
    });
    await prisma.message.create({
      data: {
        threadId: contact.thread!.id,
        waMessageId: "MSG-1",
        direction: "IN",
        source: "HUMAN",
        text: "salut",
        timestamp: new Date(),
      },
    });
    await prisma.contact.delete({ where: { id: contact.id } });
    expect(await prisma.message.count()).toBe(0);
    expect(await prisma.thread.count()).toBe(0);
  });
});
