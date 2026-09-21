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
    const groupes = await client.listGroups(await client.ensureDevice());
    // Les communautés sont écartées ici plutôt que masquées côté page : elles
    // ne reçoivent pas de messages, les proposer n'aurait aucun sens.
    return NextResponse.json({
      groupes: groupes
        .filter((groupe) => !groupe.estCommunaute)
        .sort((a, b) => a.nom.localeCompare(b.nom, "fr")),
    });
  } catch (erreur) {
    log.error("Liste des groupes WhatsApp indisponible", {
      chemin: "/api/controle/groupes",
      erreur: erreur instanceof Error ? erreur : String(erreur),
    });
    return NextResponse.json({ erreur: "WhatsApp injoignable" }, { status: 502 });
  }
}
