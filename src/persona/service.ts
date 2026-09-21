import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";

export type FaitPersona = {
  id: string;
  key: string;
  value: string;
  shareable: boolean;
};

export type Persona = {
  styleGuide: Record<string, unknown>;
  hardLimits: string[];
  termesInterdits: string[];
  faits: FaitPersona[];
};

export class PersonaRefuseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PersonaRefuseError";
  }
}

// Le styleGuide est stocké en JSON : à la racine on attend un objet, jamais une
// chaîne ni un tableau. Ce garde restreint le type au lieu de forcer une
// conversion sur la valeur brute.
function commeStyleGuide(valeur: Prisma.JsonValue | undefined): Record<string, unknown> {
  if (valeur !== null && typeof valeur === "object" && !Array.isArray(valeur)) return valeur;
  return {};
}

export async function lirePersona(): Promise<Persona> {
  const [profil, faits] = await Promise.all([
    prisma.personaProfile.findUnique({ where: { id: "self" } }),
    prisma.personaFact.findMany({
      select: { id: true, key: true, value: true, shareable: true },
      orderBy: { key: "asc" },
    }),
  ]);

  return {
    styleGuide: commeStyleGuide(profil?.styleGuide),
    hardLimits: profil?.hardLimits ?? [],
    termesInterdits: profil?.termesInterdits ?? [],
    faits,
  };
}

function nettoyerListe(liste: string[]): string[] {
  const vues = new Set<string>();
  const propre: string[] = [];
  for (const entree of liste) {
    const valeur = entree.trim();
    // Une entrée vide ne garde rien et une limite en double ne protège pas
    // deux fois : les laisser passer encombre le prompt sans rien apporter.
    if (valeur === "" || vues.has(valeur.toLowerCase())) continue;
    vues.add(valeur.toLowerCase());
    propre.push(valeur);
  }
  return propre;
}

export async function enregistrerProfil(params: {
  styleGuide: Record<string, unknown>;
  hardLimits: string[];
  termesInterdits: string[];
}): Promise<Persona> {
  const donnees = {
    styleGuide: params.styleGuide as Prisma.InputJsonValue,
    hardLimits: nettoyerListe(params.hardLimits),
    termesInterdits: nettoyerListe(params.termesInterdits),
  };
  await prisma.personaProfile.upsert({
    where: { id: "self" },
    create: { id: "self", ...donnees },
    update: donnees,
  });
  return lirePersona();
}

export async function enregistrerFait(fait: {
  id?: string;
  key: string;
  value: string;
  shareable: boolean;
}): Promise<Persona> {
  const key = fait.key.trim();
  const value = fait.value.trim();
  if (key === "") throw new PersonaRefuseError("Chaque fait doit porter une clé.");
  if (value === "") throw new PersonaRefuseError("Chaque fait doit porter une valeur.");

  const existantMemeCle = await prisma.personaFact.findUnique({ where: { key } });
  if (existantMemeCle && existantMemeCle.id !== fait.id) {
    throw new PersonaRefuseError(`Un fait porte déjà la clé « ${key} ».`);
  }

  if (fait.id) {
    await prisma.personaFact.update({
      where: { id: fait.id },
      data: { key, value, shareable: fait.shareable },
    });
  } else {
    await prisma.personaFact.create({ data: { key, value, shareable: fait.shareable } });
  }
  return lirePersona();
}

export async function supprimerFait(id: string): Promise<Persona> {
  // Supprimer pour de bon, et pas seulement décocher « partageable » : un fait
  // retiré de la fiche doit cesser d'exister, comme le fait déjà le script de
  // chargement depuis un fichier.
  await prisma.personaFact.deleteMany({ where: { id } });
  return lirePersona();
}
