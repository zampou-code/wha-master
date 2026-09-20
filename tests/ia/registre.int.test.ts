import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "@/lib/prisma";
import { encryptSecret } from "@/lib/crypto";
import { resoudreRoute } from "@/ia/registre";

const CLE = "a".repeat(64); // identique à MASTER_KEY dans tests/int-setup.ts

async function reset() {
  await prisma.$executeRawUnsafe('TRUNCATE TABLE "ProviderRoute", "ProviderConfig" CASCADE');
  await prisma.$executeRawUnsafe('TRUNCATE TABLE "ContactPolicy", "Contact" CASCADE');
}

describe("résolution de route IA", () => {
  beforeEach(reset);

  it("renvoie les entrées de la route par défaut, dans l'ordre", async () => {
    const a = await prisma.providerConfig.create({
      data: { name: "anthropic", kind: "ANTHROPIC", apiKeyEncrypted: encryptSecret("k-a", CLE) },
    });
    const b = await prisma.providerConfig.create({
      data: { name: "openrouter", kind: "OPENAI_COMPATIBLE", baseUrl: "https://openrouter.ai/api/v1", apiKeyEncrypted: encryptSecret("k-b", CLE) },
    });
    await prisma.providerRoute.create({
      data: {
        name: "defaut",
        isDefault: true,
        entries: { classify: [{ providerId: a.id, model: "m1" }, { providerId: b.id, model: "m2" }] },
      },
    });

    const entrees = await resoudreRoute("classify");
    expect(entrees.map((e) => e.model)).toEqual(["m1", "m2"]);
    expect(entrees[0].apiKey).toBe("k-a");
    expect(entrees[1].baseUrl).toBe("https://openrouter.ai/api/v1");
  });

  it("préfère la route du contact à la route par défaut", async () => {
    const p = await prisma.providerConfig.create({
      data: { name: "ollama", kind: "OLLAMA", baseUrl: "http://ollama:11434/v1" },
    });
    await prisma.providerRoute.create({
      data: { name: "defaut", isDefault: true, entries: { classify: [{ providerId: p.id, model: "defaut" }] } },
    });
    const routeContact = await prisma.providerRoute.create({
      data: { name: "permissif", entries: { classify: [{ providerId: p.id, model: "special" }] } },
    });
    const contact = await prisma.contact.create({
      data: { jid: "225@s.whatsapp.net", policy: { create: { providerRouteId: routeContact.id } } },
    });

    const entrees = await resoudreRoute("classify", { contactId: contact.id });
    expect(entrees[0].model).toBe("special");
  });

  it("ignore les fournisseurs désactivés", async () => {
    const actif = await prisma.providerConfig.create({ data: { name: "a", kind: "OLLAMA", baseUrl: "http://x/v1" } });
    const inactif = await prisma.providerConfig.create({ data: { name: "b", kind: "OLLAMA", baseUrl: "http://y/v1", enabled: false } });
    await prisma.providerRoute.create({
      data: {
        name: "defaut",
        isDefault: true,
        entries: { classify: [{ providerId: inactif.id, model: "non" }, { providerId: actif.id, model: "oui" }] },
      },
    });
    const entrees = await resoudreRoute("classify");
    expect(entrees.map((e) => e.model)).toEqual(["oui"]);
  });

  it("renvoie une liste vide quand aucune route n'existe, sans lever", async () => {
    await expect(resoudreRoute("classify")).resolves.toEqual([]);
  });

  it("ne renvoie jamais la clé chiffrée telle quelle", async () => {
    const p = await prisma.providerConfig.create({
      data: { name: "a", kind: "ANTHROPIC", apiKeyEncrypted: encryptSecret("secret-clair", CLE) },
    });
    await prisma.providerRoute.create({
      data: { name: "defaut", isDefault: true, entries: { classify: [{ providerId: p.id, model: "m" }] } },
    });
    const entrees = await resoudreRoute("classify");
    expect(entrees[0].apiKey).toBe("secret-clair");
    // La forme chiffrée est `iv.tag.ciphertext` (segments base64url séparés par
    // des points) ; on vérifie que la clé en clair ne colle pas à ce format,
    // plutôt qu'une absence générale de "." qui casserait dès qu'un champ
    // comme baseUrl contiendrait un point.
    expect(entrees[0].apiKey).not.toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  });
});
