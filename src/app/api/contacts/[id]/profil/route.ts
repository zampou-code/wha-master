import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { log } from "@/lib/log";
import { profilerContact, ProfilageRefuseError } from "@/profilage/profileur";

export const dynamic = "force-dynamic";

/**
 * Analyse l'historique d'un contact et enregistre ce qu'on en déduit.
 *
 * Déclenché à la demande, jamais en arrière-plan : l'analyse coûte un appel de
 * modèle, et le moment où elle a un sens est juste après un import — pas à
 * chaque passage d'une tâche planifiée.
 */
export async function POST(request: Request, contexte: { params: Promise<{ id: string }> }) {
  try {
    await requireSession(request.headers);
  } catch {
    return NextResponse.json({ erreur: "Non authentifié" }, { status: 401 });
  }

  const { id } = await contexte.params;
  try {
    return NextResponse.json({ profil: await profilerContact({ contactId: id }) });
  } catch (erreur) {
    if (erreur instanceof ProfilageRefuseError) {
      return NextResponse.json({ erreur: erreur.message }, { status: 400 });
    }
    log.error("Profilage impossible", {
      contactId: id,
      erreur: erreur instanceof Error ? erreur : String(erreur),
    });
    return NextResponse.json({ erreur: "Analyse impossible" }, { status: 500 });
  }
}
