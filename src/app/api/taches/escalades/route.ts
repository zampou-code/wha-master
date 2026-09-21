import { NextResponse } from "next/server";
import { getEnv } from "@/config/env";
import { log } from "@/lib/log";
import { constantTimeEquals } from "@/lib/crypto";
import { expirerEscalades } from "@/escalade/expiration";

export const dynamic = "force-dynamic";

// Déclenchée par une tâche planifiée, pas par une minuterie en processus : une
// minuterie ne survit pas à un redéploiement et s'exécute là où personne ne la
// regarde. Le secret du webhook sert d'authentification.
export async function POST(request: Request) {
  const fourni = request.headers.get("X-Tache-Secret");
  if (!fourni || !constantTimeEquals(fourni, getEnv().GOWA_WEBHOOK_SECRET)) {
    return NextResponse.json({ erreur: "Non autorisé" }, { status: 401 });
  }
  try {
    const resultat = await expirerEscalades();
    return NextResponse.json(resultat);
  } catch (erreur) {
    log.error("Expiration des escalades en échec", {
      erreur: erreur instanceof Error ? erreur.message : String(erreur),
    });
    return NextResponse.json({ erreur: "Expiration impossible" }, { status: 500 });
  }
}
