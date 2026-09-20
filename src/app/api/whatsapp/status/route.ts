import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { createGowaClient } from "@/gowa/client";
import { log } from "@/lib/log";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    await requireSession(request.headers);
  } catch {
    return NextResponse.json({ erreur: "Non authentifié" }, { status: 401 });
  }

  try {
    const client = createGowaClient();
    const idAppareil = await client.ensureDevice();
    const statut = await client.getStatus(idAppareil);
    return NextResponse.json(statut);
  } catch (erreur) {
    // L'absence de journalisation ici a déjà coûté une heure de diagnostic :
    // sans elle, un 502 est muet et ne dit rien de la cause réelle côté GOWA.
    log.error("Échec de récupération du statut GOWA", {
      chemin: "/api/whatsapp/status",
      erreur: erreur instanceof Error ? erreur : String(erreur),
    });
    return NextResponse.json({ erreur: "WhatsApp injoignable" }, { status: 502 });
  }
}
