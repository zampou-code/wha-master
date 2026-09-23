import { z } from "zod";
import type { ProviderKind } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { decryptSecret } from "@/lib/crypto";
import { getEnv } from "@/config/env";
import { log } from "@/lib/log";

export type RoleIA = "classify" | "compose" | "profile" | "summarize";

export type EntreeRoute = {
  providerId: string;
  nom: string;
  kind: ProviderKind;
  model: string;
  baseUrl: string | null;
  apiKey: string | null;
};

const entreesSchema = z.record(
  z.string(),
  z.array(z.object({ providerId: z.string(), model: z.string() })),
);

async function entreesDeLaRoute(routeId: string | null, role: RoleIA) {
  const route = routeId
    ? await prisma.providerRoute.findUnique({ where: { id: routeId } })
    : await prisma.providerRoute.findFirst({ where: { isDefault: true } });
  if (!route) return [];

  const analyse = entreesSchema.safeParse(route.entries);
  if (!analyse.success) {
    log.error("Route IA au format invalide", { routeId: route.id, issues: analyse.error.issues });
    return [];
  }
  return analyse.data[role] ?? [];
}

/**
 * Construit une entrée de route à partir d'une fiche de fournisseur.
 *
 * Extrait de la résolution pour que le test d'un fournisseur emprunte
 * exactement le même chemin qu'un appel réel — clé déchiffrée comprise. Un
 * test qui passerait par un autre chemin ne prouverait rien.
 */
export function entreeDepuisConfig(
  config: {
    id: string;
    name: string;
    kind: ProviderKind;
    baseUrl: string | null;
    apiKeyEncrypted: string | null;
  },
  model: string,
): EntreeRoute | null {
  let apiKey: string | null = null;
  if (config.apiKeyEncrypted) {
    try {
      apiKey = decryptSecret(config.apiKeyEncrypted, getEnv().MASTER_KEY);
    } catch {
      return null;
    }
  }
  return {
    providerId: config.id,
    nom: config.name,
    kind: config.kind,
    model,
    baseUrl: config.baseUrl,
    apiKey,
  };
}

export async function resoudreRoute(
  role: RoleIA,
  options: { contactId?: string } = {},
): Promise<EntreeRoute[]> {
  let routeId: string | null = null;

  if (options.contactId) {
    const politique = await prisma.contactPolicy.findUnique({
      where: { contactId: options.contactId },
      select: { providerRouteId: true },
    });
    routeId = politique?.providerRouteId ?? null;
  }

  let brutes = await entreesDeLaRoute(routeId, role);
  // Repli sur la route par défaut si la route du contact ne couvre pas ce rôle.
  if (brutes.length === 0 && routeId !== null) {
    brutes = await entreesDeLaRoute(null, role);
  }
  if (brutes.length === 0) return [];

  const fournisseurs = await prisma.providerConfig.findMany({
    where: { id: { in: brutes.map((e) => e.providerId) }, enabled: true },
  });
  const parId = new Map(fournisseurs.map((f) => [f.id, f]));
  const masterKey = getEnv().MASTER_KEY;

  const entrees: EntreeRoute[] = [];
  for (const brute of brutes) {
    const fournisseur = parId.get(brute.providerId);
    if (!fournisseur) continue;

    let apiKey: string | null = null;
    if (fournisseur.apiKeyEncrypted) {
      try {
        apiKey = decryptSecret(fournisseur.apiKeyEncrypted, masterKey);
      } catch {
        // Une clé indéchiffrable signifie presque toujours une MASTER_KEY
        // changée. On saute l'entrée plutôt que d'échouer : la cascade de repli
        // existe précisément pour ça.
        log.error("Clé de fournisseur indéchiffrable, entrée ignorée", { fournisseur: fournisseur.name });
        continue;
      }
    }

    entrees.push({
      providerId: fournisseur.id,
      nom: fournisseur.name,
      kind: fournisseur.kind,
      model: brute.model,
      baseUrl: fournisseur.baseUrl,
      apiKey,
    });
  }
  return entrees;
}
