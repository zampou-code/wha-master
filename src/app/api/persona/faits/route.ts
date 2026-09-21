import { NextResponse } from "next/server";
import { z } from "zod";
import { requireSession } from "@/lib/auth";
import { log } from "@/lib/log";
import { enregistrerFait, supprimerFait, PersonaRefuseError } from "@/persona/service";

export const dynamic = "force-dynamic";

const faitSchema = z.object({
  id: z.string().optional(),
  key: z.string(),
  value: z.string(),
  shareable: z.boolean(),
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

export async function PUT(request: Request) {
  const refus = await sansSession(request);
  if (refus) return refus;

  const analyse = faitSchema.safeParse(await request.json().catch(() => null));
  if (!analyse.success) {
    return NextResponse.json({ erreur: "Fait invalide." }, { status: 400 });
  }

  try {
    return NextResponse.json({ persona: await enregistrerFait(analyse.data) });
  } catch (erreur) {
    if (erreur instanceof PersonaRefuseError) {
      return NextResponse.json({ erreur: erreur.message }, { status: 400 });
    }
    log.error("Enregistrement d'un fait impossible", {
      erreur: erreur instanceof Error ? erreur : String(erreur),
    });
    return NextResponse.json({ erreur: "Enregistrement impossible" }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  const refus = await sansSession(request);
  if (refus) return refus;

  const analyse = suppressionSchema.safeParse(await request.json().catch(() => null));
  if (!analyse.success) {
    return NextResponse.json({ erreur: "Fait invalide." }, { status: 400 });
  }

  try {
    return NextResponse.json({ persona: await supprimerFait(analyse.data.id) });
  } catch (erreur) {
    log.error("Suppression d'un fait impossible", {
      erreur: erreur instanceof Error ? erreur : String(erreur),
    });
    return NextResponse.json({ erreur: "Suppression impossible" }, { status: 500 });
  }
}
