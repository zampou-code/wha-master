import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "@/lib/prisma";
import { ContactMode } from "@/generated/prisma/client";
import { traiterEnvoisDus } from "@/envoi/file";
import { resetDb } from "../helpers/db";

describe("scratch: réservation sans ContactPolicy ni Thread", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("envoie quand même si le contact AUTO n'a pas de ContactPolicy/Thread", async () => {
    const contact = await prisma.contact.create({
      data: { jid: "225-sans-policy@s.whatsapp.net", mode: ContactMode.AUTO },
    });
    await prisma.envoiPlanifie.create({
      data: { contactId: contact.id, texte: "coucou", aEnvoyerApres: new Date(Date.now() - 60_000) },
    });

    const envoyer = async () => ({ messageId: "WA-1" });
    const presence = async () => undefined;
    const bilan = await traiterEnvoisDus({ envoyer, presence });

    // eslint-disable-next-line no-console
    console.log("BILAN:", JSON.stringify(bilan));
    const ligne = await prisma.envoiPlanifie.findFirst();
    // eslint-disable-next-line no-console
    console.log("LIGNE:", JSON.stringify(ligne));
  });
});
