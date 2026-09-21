import { ProviderKind, type Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { getEnv } from "@/config/env";
import { encryptSecret, maskSecret, decryptSecret } from "@/lib/crypto";
import type { RoleIA } from "@/ia/registre";

export const ROLES: RoleIA[] = ["classify", "compose", "profile", "summarize"];

export const LIBELLE_ROLE: Record<RoleIA, string> = {
  classify: "Classer les messages entrants",
  compose: "Rédiger les réponses",
  profile: "Déduire les paramètres d'un contact",
  summarize: "Résumer les conversations",
};

export type Fournisseur = {
  id: string;
  name: string;
  kind: ProviderKind;
  baseUrl: string | null;
  enabled: boolean;
  // Jamais la clé : seulement de quoi reconnaître laquelle est enregistrée.
  cleMasquee: string | null;
  healthyAt: string | null;
  lastError: string | null;
};

export type EntreeRole = { providerId: string; model: string };

export type Reglages = {
  fournisseurs: Fournisseur[];
  roles: Record<string, EntreeRole[]>;
};

export class FournisseurRefuseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FournisseurRefuseError";
  }
}

const NOM_ROUTE = "par défaut";

function commeEntrees(valeur: Prisma.JsonValue | undefined): Record<string, EntreeRole[]> {
  if (valeur === null || typeof valeur !== "object" || Array.isArray(valeur)) return {};
  const sortie: Record<string, EntreeRole[]> = {};
  for (const [role, brut] of Object.entries(valeur)) {
    if (!Array.isArray(brut)) continue;
    const entrees: EntreeRole[] = [];
    for (const entree of brut) {
      if (
        entree !== null &&
        typeof entree === "object" &&
        !Array.isArray(entree) &&
        typeof (entree as Record<string, unknown>).providerId === "string" &&
        typeof (entree as Record<string, unknown>).model === "string"
      ) {
        const objet = entree as Record<string, unknown>;
        entrees.push({ providerId: objet.providerId as string, model: objet.model as string });
      }
    }
    sortie[role] = entrees;
  }
  return sortie;
}

export async function lireReglages(): Promise<Reglages> {
  const [fournisseurs, route] = await Promise.all([
    prisma.providerConfig.findMany({ orderBy: { name: "asc" } }),
    prisma.providerRoute.findFirst({ where: { isDefault: true } }),
  ]);

  return {
    fournisseurs: fournisseurs.map((fournisseur) => ({
      id: fournisseur.id,
      name: fournisseur.name,
      kind: fournisseur.kind,
      baseUrl: fournisseur.baseUrl,
      enabled: fournisseur.enabled,
      cleMasquee: fournisseur.apiKeyEncrypted
        ? masquerSansExposer(fournisseur.apiKeyEncrypted)
        : null,
      healthyAt: fournisseur.healthyAt?.toISOString() ?? null,
      lastError: fournisseur.lastError,
    })),
    roles: commeEntrees(route?.entries),
  };
}

// Déchiffre uniquement pour masquer : la clé en clair ne quitte jamais cette
// fonction, et un secret indéchiffrable (MASTER_KEY changée) se signale au lieu
// de faire échouer toute la page.
function masquerSansExposer(chiffre: string): string {
  try {
    return maskSecret(decryptSecret(chiffre, getEnv().MASTER_KEY));
  } catch {
    return "clé illisible";
  }
}

export async function enregistrerFournisseur(params: {
  id?: string;
  name: string;
  kind: ProviderKind;
  baseUrl?: string | null;
  apiKey?: string | null;
  enabled: boolean;
}): Promise<Reglages> {
  const name = params.name.trim();
  if (name === "") throw new FournisseurRefuseError("Donne un nom à ce fournisseur.");

  const homonyme = await prisma.providerConfig.findUnique({ where: { name } });
  if (homonyme && homonyme.id !== params.id) {
    throw new FournisseurRefuseError(`Un fournisseur s'appelle déjà « ${name} ».`);
  }

  const baseUrl = params.baseUrl?.trim() || null;
  if (params.kind === ProviderKind.OPENAI_COMPATIBLE || params.kind === ProviderKind.OLLAMA) {
    if (!baseUrl) {
      throw new FournisseurRefuseError("Ce type de fournisseur exige une adresse de base.");
    }
  }

  // Une clé vide ne veut pas dire « efface la clé » : c'est le cas normal d'une
  // modification où l'on ne retape pas un secret qu'on ne peut plus lire.
  const cle =
    params.apiKey && params.apiKey.trim() !== ""
      ? encryptSecret(params.apiKey.trim(), getEnv().MASTER_KEY)
      : undefined;

  if (params.id) {
    await prisma.providerConfig.update({
      where: { id: params.id },
      data: {
        name,
        kind: params.kind,
        baseUrl,
        enabled: params.enabled,
        ...(cle ? { apiKeyEncrypted: cle } : {}),
      },
    });
  } else {
    await prisma.providerConfig.create({
      data: { name, kind: params.kind, baseUrl, enabled: params.enabled, apiKeyEncrypted: cle ?? null },
    });
  }
  return lireReglages();
}

export async function supprimerFournisseur(id: string): Promise<Reglages> {
  const route = await prisma.providerRoute.findFirst({ where: { isDefault: true } });
  const roles = commeEntrees(route?.entries);
  const utilise = Object.entries(roles).find(([, entrees]) =>
    entrees.some((entree) => entree.providerId === id),
  );
  if (utilise) {
    // Le supprimer laisserait une route qui désigne un fournisseur disparu :
    // le rôle tomberait en panne silencieusement, sans que rien ne le dise.
    throw new FournisseurRefuseError(
      `Ce fournisseur sert encore au rôle « ${LIBELLE_ROLE[utilise[0] as RoleIA] ?? utilise[0]} ». Retire-le d'abord.`,
    );
  }
  await prisma.providerConfig.deleteMany({ where: { id } });
  return lireReglages();
}

export async function enregistrerRoles(roles: Record<string, EntreeRole[]>): Promise<Reglages> {
  const connus = await prisma.providerConfig.findMany({ select: { id: true } });
  const identifiants = new Set(connus.map((fournisseur) => fournisseur.id));

  for (const [role, entrees] of Object.entries(roles)) {
    if (!ROLES.includes(role as RoleIA)) {
      throw new FournisseurRefuseError(`Rôle inconnu : ${role}.`);
    }
    for (const entree of entrees) {
      if (!identifiants.has(entree.providerId)) {
        throw new FournisseurRefuseError("Un fournisseur choisi n'existe plus. Recharge la page.");
      }
      if (entree.model.trim() === "") {
        throw new FournisseurRefuseError("Chaque entrée doit préciser un modèle.");
      }
    }
  }

  const entrees = Object.fromEntries(
    Object.entries(roles).map(([role, liste]) => [
      role,
      liste.map((entree) => ({ providerId: entree.providerId, model: entree.model.trim() })),
    ]),
  ) as Prisma.InputJsonValue;

  const existante = await prisma.providerRoute.findFirst({ where: { isDefault: true } });
  if (existante) {
    await prisma.providerRoute.update({ where: { id: existante.id }, data: { entries: entrees } });
  } else {
    await prisma.providerRoute.create({
      data: { name: NOM_ROUTE, isDefault: true, entries: entrees },
    });
  }
  return lireReglages();
}
