import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "@/lib/prisma";
import { ProviderKind } from "@/generated/prisma/client";
import {
  lireReglages,
  enregistrerFournisseur,
  supprimerFournisseur,
  enregistrerRoles,
  FournisseurRefuseError,
} from "@/fournisseurs/service";
import { resoudreRoute } from "@/ia/registre";
import { resetDb } from "../helpers/db";

const CLE = "sk-ant-secrete-0123456789";

async function anthropic() {
  const reglages = await enregistrerFournisseur({
    name: "Anthropic",
    kind: ProviderKind.ANTHROPIC,
    apiKey: CLE,
    enabled: true,
  });
  return reglages.fournisseurs[0];
}

describe("service des fournisseurs", () => {
  beforeEach(resetDb);

  it("chiffre la clé et ne la rend jamais en clair", async () => {
    const fournisseur = await anthropic();
    expect(fournisseur.cleMasquee).not.toBeNull();
    expect(fournisseur.cleMasquee).not.toContain("secrete");

    // Ni dans la réponse du service, ni dans la ligne stockée.
    expect(JSON.stringify(await lireReglages())).not.toContain(CLE);
    const brut = await prisma.providerConfig.findUnique({ where: { id: fournisseur.id } });
    expect(brut?.apiKeyEncrypted).not.toContain(CLE);
    expect(brut?.apiKeyEncrypted).not.toBeNull();
  });

  it("garde la clé existante quand on modifie le reste sans la retaper", async () => {
    // Le cas normal : on ne peut pas relire une clé pour la ressaisir, donc un
    // champ laissé vide ne doit pas l'effacer.
    const fournisseur = await anthropic();
    const avant = (await prisma.providerConfig.findUnique({ where: { id: fournisseur.id } }))
      ?.apiKeyEncrypted;

    await enregistrerFournisseur({
      id: fournisseur.id,
      name: "Anthropic principal",
      kind: ProviderKind.ANTHROPIC,
      apiKey: "",
      enabled: false,
    });

    const apres = await prisma.providerConfig.findUnique({ where: { id: fournisseur.id } });
    expect(apres?.apiKeyEncrypted).toBe(avant);
    expect(apres?.name).toBe("Anthropic principal");
    expect(apres?.enabled).toBe(false);
  });

  it("refuse deux fournisseurs du même nom", async () => {
    await anthropic();
    await expect(
      enregistrerFournisseur({ name: "Anthropic", kind: ProviderKind.OPENAI, apiKey: "x", enabled: true }),
    ).rejects.toBeInstanceOf(FournisseurRefuseError);
  });

  it("exige une adresse de base pour un fournisseur compatible ou local", async () => {
    await expect(
      enregistrerFournisseur({
        name: "OpenRouter", kind: ProviderKind.OPENAI_COMPATIBLE, apiKey: "x", enabled: true,
      }),
    ).rejects.toBeInstanceOf(FournisseurRefuseError);

    await expect(
      enregistrerFournisseur({
        name: "OpenRouter", kind: ProviderKind.OPENAI_COMPATIBLE,
        baseUrl: "https://openrouter.ai/api/v1", apiKey: "x", enabled: true,
      }),
    ).resolves.toBeDefined();
  });

  it("refuse de supprimer un fournisseur encore affecté à un rôle", async () => {
    // Le supprimer laisserait une route qui désigne un fournisseur disparu :
    // le rôle tomberait en panne sans que rien ne le dise.
    const fournisseur = await anthropic();
    await enregistrerRoles({ compose: [{ providerId: fournisseur.id, model: "claude-sonnet-5" }] });

    await expect(supprimerFournisseur(fournisseur.id)).rejects.toBeInstanceOf(FournisseurRefuseError);
    expect(await prisma.providerConfig.count()).toBe(1);

    await enregistrerRoles({ compose: [] });
    await expect(supprimerFournisseur(fournisseur.id)).resolves.toBeDefined();
    expect(await prisma.providerConfig.count()).toBe(0);
  });

  it("refuse un rôle inconnu ou un fournisseur qui n'existe plus", async () => {
    const fournisseur = await anthropic();
    await expect(
      enregistrerRoles({ inventé: [{ providerId: fournisseur.id, model: "m" }] }),
    ).rejects.toBeInstanceOf(FournisseurRefuseError);
    await expect(
      enregistrerRoles({ compose: [{ providerId: "disparu", model: "m" }] }),
    ).rejects.toBeInstanceOf(FournisseurRefuseError);
    await expect(
      enregistrerRoles({ compose: [{ providerId: fournisseur.id, model: "  " }] }),
    ).rejects.toBeInstanceOf(FournisseurRefuseError);
  });

  it("produit une route que le moteur IA sait réellement résoudre", async () => {
    // Le vrai test : ce que règle l'interface doit arriver jusqu'au code qui
    // appelle les modèles, pas seulement être stocké dans la bonne forme.
    const fournisseur = await anthropic();
    await enregistrerRoles({
      compose: [{ providerId: fournisseur.id, model: "claude-sonnet-5" }],
      classify: [{ providerId: fournisseur.id, model: "claude-haiku-4-5-20251001" }],
    });

    const entrees = await resoudreRoute("compose");
    expect(entrees).toHaveLength(1);
    expect(entrees[0].model).toBe("claude-sonnet-5");
    expect(entrees[0].kind).toBe(ProviderKind.ANTHROPIC);
    // La clé est déchiffrée pour l'appel, et seulement là.
    expect(entrees[0].apiKey).toBe(CLE);
  });

  it("écarte de la résolution un fournisseur désactivé", async () => {
    const fournisseur = await anthropic();
    await enregistrerRoles({ compose: [{ providerId: fournisseur.id, model: "claude-sonnet-5" }] });
    await enregistrerFournisseur({
      id: fournisseur.id, name: "Anthropic", kind: ProviderKind.ANTHROPIC, apiKey: "", enabled: false,
    });
    expect(await resoudreRoute("compose")).toEqual([]);
  });

  it("remplace la route par défaut au lieu d'en accumuler", async () => {
    const fournisseur = await anthropic();
    await enregistrerRoles({ compose: [{ providerId: fournisseur.id, model: "a" }] });
    await enregistrerRoles({ compose: [{ providerId: fournisseur.id, model: "b" }] });
    expect(await prisma.providerRoute.count()).toBe(1);
    expect((await lireReglages()).roles.compose[0].model).toBe("b");
  });
});
