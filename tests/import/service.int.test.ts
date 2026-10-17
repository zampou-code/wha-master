import { describe, it, expect, beforeEach } from "vitest";
import { ContactMode, Direction, MessageSource } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { apercu, importerConversation, ImportRefuseError } from "@/import/service";
import { resetDb } from "../helpers/db";

const EXPORT = [
  "[12/08/2026, 21:04:11] Sarah: tu fais quoi ce soir ?",
  "[12/08/2026, 21:10:02] Ibrahim: je bosse encore",
  "[12/08/2026, 21:11:00] Sarah: image omise",
  "[13/08/2026, 08:00:00] Sarah: bonne journée",
].join("\n");

async function contact(mode: ContactMode = ContactMode.OFF) {
  return prisma.contact.create({
    data: {
      jid: "22500000001@s.whatsapp.net",
      alias: "Sarah",
      mode,
      thread: { create: {} },
      policy: { create: {} },
    },
  });
}

describe("import d'un historique", () => {
  beforeEach(resetDb);

  it("montre les auteurs et les bornes avant d'écrire quoi que ce soit", async () => {
    const vu = apercu(EXPORT);

    expect(vu.auteurs).toEqual(["Sarah", "Ibrahim"]);
    expect(vu.messages).toBe(4);
    expect(vu.du).toBe("2026-08-12T21:04:11.000Z");
    expect(vu.au).toBe("2026-08-13T08:00:00.000Z");
    expect(await prisma.message.count()).toBe(0);
  });

  it("range chaque message du bon côté de la conversation", async () => {
    // Inverser les deux auteurs ferait lire au rédacteur ses propres messages
    // comme ceux du contact : il s'imiterait lui-même.
    const sarah = await contact();

    const resultat = await importerConversation({
      contactId: sarah.id,
      contenu: EXPORT,
      auteurContact: "Sarah",
    });

    expect(resultat.inseres).toBe(4);
    const messages = await prisma.message.findMany({ orderBy: { timestamp: "asc" } });
    expect(messages.map((m) => m.direction)).toEqual([
      Direction.IN,
      Direction.OUT,
      Direction.IN,
      Direction.IN,
    ]);
    expect(messages.every((m) => m.source === MessageSource.IMPORT)).toBe(true);
    expect(messages[2]).toMatchObject({ text: null, mediaType: "IMAGE" });
  });

  it("ne décide rien, n'escalade rien, n'envoie rien", async () => {
    // Classer un historique de deux ans produirait des escalades sur des
    // conversations closes, et pourrait faire répondre à un message d'il y a six
    // mois. L'historique est du contexte, pas des messages à traiter.
    const sarah = await contact(ContactMode.AUTO);

    await importerConversation({ contactId: sarah.id, contenu: EXPORT, auteurContact: "Sarah" });

    expect(await prisma.decision.count()).toBe(0);
    expect(await prisma.escalation.count()).toBe(0);
    expect(await prisma.envoiPlanifie.count()).toBe(0);
  });

  it("se réimporte sans rien dupliquer", async () => {
    // Réimporter le même fichier est le premier geste de quelqu'un qui doute
    // que ça ait marché.
    const sarah = await contact();

    await importerConversation({ contactId: sarah.id, contenu: EXPORT, auteurContact: "Sarah" });
    const second = await importerConversation({
      contactId: sarah.id,
      contenu: EXPORT,
      auteurContact: "Sarah",
    });

    expect(second).toMatchObject({ inseres: 0, deja: 4 });
    expect(await prisma.message.count()).toBe(4);
  });

  it("complète un fil déjà alimenté par les webhooks, sans toucher à l'existant", async () => {
    const sarah = await contact();
    const fil = await prisma.thread.findUniqueOrThrow({ where: { contactId: sarah.id } });
    await prisma.message.create({
      data: {
        threadId: fil.id,
        waMessageId: "WA-LIVE",
        direction: Direction.IN,
        source: MessageSource.HUMAN,
        text: "message reçu en direct",
        timestamp: new Date("2026-10-01T10:00:00Z"),
      },
    });

    await importerConversation({ contactId: sarah.id, contenu: EXPORT, auteurContact: "Sarah" });

    expect(await prisma.message.count()).toBe(5);
    expect(await prisma.message.count({ where: { source: MessageSource.HUMAN } })).toBe(1);
  });

  it("ne fait pas reculer la date du dernier message", async () => {
    // L'import est une archive : elle est plus ancienne que la conversation en
    // cours. Écraser cette date ferait paraître le contact silencieux depuis des
    // mois — ce que lira la relance.
    const sarah = await contact();
    const recent = new Date("2026-10-01T10:00:00Z");
    await prisma.thread.update({
      where: { contactId: sarah.id },
      data: { lastMessageAt: recent },
    });

    await importerConversation({ contactId: sarah.id, contenu: EXPORT, auteurContact: "Sarah" });

    const fil = await prisma.thread.findUniqueOrThrow({ where: { contactId: sarah.id } });
    expect(fil.lastMessageAt?.toISOString()).toBe(recent.toISOString());
  });

  it("avance la date quand l'import est plus récent que le fil", async () => {
    const sarah = await contact();

    await importerConversation({ contactId: sarah.id, contenu: EXPORT, auteurContact: "Sarah" });

    const fil = await prisma.thread.findUniqueOrThrow({ where: { contactId: sarah.id } });
    expect(fil.lastMessageAt?.toISOString()).toBe("2026-08-13T08:00:00.000Z");
  });

  it("refuse un fichier qui n'est pas un export", async () => {
    const sarah = await contact();

    await expect(
      importerConversation({ contactId: sarah.id, contenu: "mes notes", auteurContact: "Sarah" }),
    ).rejects.toThrow(ImportRefuseError);
    expect(await prisma.message.count()).toBe(0);
  });

  it("refuse un auteur absent du fichier plutôt que de tout mettre du même côté", async () => {
    const sarah = await contact();

    await expect(
      importerConversation({ contactId: sarah.id, contenu: EXPORT, auteurContact: "Awa" }),
    ).rejects.toThrow(/n'apparaît pas/);
    expect(await prisma.message.count()).toBe(0);
  });

  it("refuse un contact inconnu", async () => {
    await expect(
      importerConversation({ contactId: "inexistant", contenu: EXPORT, auteurContact: "Sarah" }),
    ).rejects.toThrow(ImportRefuseError);
  });

  it("insère un export plus gros que la taille d'une tranche", async () => {
    // La boucle par tranches de 500 est le genre de code où une erreur d'indice
    // perd des messages en silence.
    const sarah = await contact();
    const lignes: string[] = [];
    for (let index = 0; index < 1200; index += 1) {
      const minute = String(index % 60).padStart(2, "0");
      const heure = String(Math.floor(index / 60)).padStart(2, "0");
      lignes.push(`[12/08/2026, ${heure}:${minute}:00] Sarah: message ${index}`);
    }

    const resultat = await importerConversation({
      contactId: sarah.id,
      contenu: lignes.join("\n"),
      auteurContact: "Sarah",
    });

    expect(resultat.inseres).toBe(1200);
    expect(await prisma.message.count()).toBe(1200);
  });
});
