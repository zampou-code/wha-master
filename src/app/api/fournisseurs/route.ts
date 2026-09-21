import { NextResponse } from "next/server";
import { z } from "zod";
import { ProviderKind } from "@/generated/prisma/client";
import { requireSession } from "@/lib/auth";
import { log } from "@/lib/log";
import {
  lireReglages,
  enregistrerFournisseur,
  supprimerFournisseur,
  enregistrerRoles,
  FournisseurRefuseError,
} from "@/fournisseurs/service";

export const dynamic = "force-dynamic";

const fournisseurSchema = z.object({
  id: z.string().optional(),
  name: z.string(),
  kind: z.enum(ProviderKind),
  baseUrl: z.string().nullable().optional(),
  apiKey: z.string().nullable().optional(),
  enabled: z.boolean(),
});

const rolesSchema = z.object({
  roles: z.record(
    z.string(),
    z.array(z.object({ providerId: z.string(), model: z.string() })),
  ),
});

const suppressionSchema = z.object({ id: z.string().min(1) });

async function sansSession(request: Request): Promise<NextResponse | null> {
  try {
    await requireSession(request.headers);
    return null;
  } catch {
    return NextResponse.json({ erreur: "Non authentifié" }, { status: 401 });
  }
}

function echec(erreur: unknown, contexte: string): NextResponse {
  if (erreur instanceof FournisseurRefuseError) {
    return NextResponse.json({ erreur: erreur.message }, { status: 400 });
  }
  log.error(contexte, { erreur: erreur instanceof Error ? erreur : String(erreur) });
  return NextResponse.json({ erreur: "Opération impossible" }, { status: 500 });
}

export async function GET(request: Request) {
  const refus = await sansSession(request);
  if (refus) return refus;

  try {
    return NextResponse.json({ reglages: await lireReglages() });
  } catch (erreur) {
    return echec(erreur, "Réglages des fournisseurs illisibles");
  }
}

export async function PUT(request: Request) {
  const refus = await sansSession(request);
  if (refus) return refus;

  const corps = await request.json().catch(() => null);

  // Une seule route pour les deux écritures : le formulaire enregistre soit un
  // fournisseur, soit l'affectation des rôles, jamais les deux à la fois.
  const roles = rolesSchema.safeParse(corps);
  if (roles.success) {
    try {
      return NextResponse.json({ reglages: await enregistrerRoles(roles.data.roles) });
    } catch (erreur) {
      return echec(erreur, "Affectation des rôles impossible");
    }
  }

  const fournisseur = fournisseurSchema.safeParse(corps);
  if (!fournisseur.success) {
    return NextResponse.json({ erreur: "Réglage invalide." }, { status: 400 });
  }
  try {
    return NextResponse.json({ reglages: await enregistrerFournisseur(fournisseur.data) });
  } catch (erreur) {
    return echec(erreur, "Enregistrement du fournisseur impossible");
  }
}

export async function DELETE(request: Request) {
  const refus = await sansSession(request);
  if (refus) return refus;

  const analyse = suppressionSchema.safeParse(await request.json().catch(() => null));
  if (!analyse.success) {
    return NextResponse.json({ erreur: "Fournisseur invalide." }, { status: 400 });
  }
  try {
    return NextResponse.json({ reglages: await supprimerFournisseur(analyse.data.id) });
  } catch (erreur) {
    return echec(erreur, "Suppression du fournisseur impossible");
  }
}
