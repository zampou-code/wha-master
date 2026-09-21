import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { prisma } from "@/lib/prisma";
import { lireGroupeDeControle, enregistrerGroupeDeControle } from "@/controle/groupe";
import { resetEnvCache } from "@/config/env";
import { resetDb } from "../helpers/db";

describe("résolution du groupe de contrôle", () => {
  beforeEach(async () => {
    await resetDb();
    delete process.env.CONTROL_GROUP_JID;
    resetEnvCache();
  });

  afterEach(() => {
    delete process.env.CONTROL_GROUP_JID;
    resetEnvCache();
  });

  it("ne rend rien tant que rien n'est réglé", async () => {
    expect(await lireGroupeDeControle()).toBeNull();
  });

  it("retombe sur la variable d'environnement quand la base ne dit rien", async () => {
    // Un déploiement qui avait déjà renseigné la variable ne doit pas cesser de
    // fonctionner parce que le réglage existe désormais dans l'interface.
    process.env.CONTROL_GROUP_JID = "120363000000000001@g.us";
    resetEnvCache();
    expect(await lireGroupeDeControle()).toEqual({
      jid: "120363000000000001@g.us",
      nom: null,
      source: "environnement",
    });
  });

  it("préfère le réglage de l'interface à la variable d'environnement", async () => {
    process.env.CONTROL_GROUP_JID = "120363000000000001@g.us";
    resetEnvCache();
    await enregistrerGroupeDeControle({ jid: "120363000000000002@g.us", nom: "Poste de contrôle" });
    expect(await lireGroupeDeControle()).toEqual({
      jid: "120363000000000002@g.us",
      nom: "Poste de contrôle",
      source: "interface",
    });
  });

  it("remplace le groupe précédent plutôt que d'en accumuler", async () => {
    await enregistrerGroupeDeControle({ jid: "120363000000000002@g.us", nom: "Premier" });
    await enregistrerGroupeDeControle({ jid: "120363000000000003@g.us", nom: "Second" });
    expect((await lireGroupeDeControle())?.jid).toBe("120363000000000003@g.us");
    expect(await prisma.systemState.count()).toBe(1);
  });

  it("n'efface pas la pause globale en enregistrant un groupe", async () => {
    // Les deux réglages vivent sur la même ligne singleton : un `upsert` qui
    // recréerait l'enregistrement lèverait une pause posée juste avant.
    await prisma.systemState.upsert({
      where: { id: "singleton" },
      create: { id: "singleton", globalPaused: true },
      update: { globalPaused: true },
    });
    await enregistrerGroupeDeControle({ jid: "120363000000000004@g.us", nom: "Poste" });
    const etat = await prisma.systemState.findUnique({ where: { id: "singleton" } });
    expect(etat?.globalPaused).toBe(true);
    expect(etat?.controlGroupJid).toBe("120363000000000004@g.us");
  });
});
