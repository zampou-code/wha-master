import { NextResponse } from "next/server";
import { z } from "zod";
import { requireSession } from "@/lib/auth";
import { log } from "@/lib/log";
import { lirePersona, enregistrerProfil } from "@/persona/service";

export const dynamic = "force-dynamic";

const profilSchema = z.object({
  styleGuide: z.record(z.string(), z.json()),
  hardLimits: z.array(z.string()),
  termesInterdits: z.array(z.string()),
});

async function sansSession(request: Request): Promise<NextResponse | null> {
  try {
    await requireSession(request.headers);
    return null;
  } catch {
    return NextResponse.json({ erreur: "Non authentifié" }, { status: 401 });
  }
}

export async function GET(request: Request) {
  const refus = await sansSession(request);
  if (refus) return refus;

  try {
    return NextResponse.json({ persona: await lirePersona() });
  } catch (erreur) {
    log.error("Fiche persona illisible", {
      chemin: "/api/persona",
      erreur: erreur instanceof Error ? erreur : String(erreur),
    });
    return NextResponse.json({ erreur: "Fiche illisible" }, { status: 500 });
  }
}

export async function PUT(request: Request) {
  const refus = await sansSession(request);
  if (refus) return refus;

  const analyse = profilSchema.safeParse(await request.json().catch(() => null));
  if (!analyse.success) {
    return NextResponse.json({ erreur: "Fiche invalide." }, { status: 400 });
  }

  try {
    return NextResponse.json({ persona: await enregistrerProfil(analyse.data) });
  } catch (erreur) {
    log.error("Enregistrement de la fiche persona impossible", {
      erreur: erreur instanceof Error ? erreur : String(erreur),
    });
    return NextResponse.json({ erreur: "Enregistrement impossible" }, { status: 500 });
  }
}
