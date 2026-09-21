import { NextResponse } from "next/server";
import { ContactMode } from "@/generated/prisma/client";
import { requireSession } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { log } from "@/lib/log";
import { lireGroupeDeControle } from "@/controle/groupe";
import { resoudreRoute } from "@/ia/registre";

export const dynamic = "force-dynamic";

export type EtatSysteme = {
  groupeDeControle: { pret: boolean; nom: string | null };
  persona: { pret: boolean; faitsPartageables: number };
  redaction: { pret: boolean; fournisseurs: number };
  classement: { pret: boolean; fournisseurs: number };
  contacts: { pret: boolean; actifs: number; total: number };
  escaladesOuvertes: number;
  pauseGlobale: boolean;
};

export async function GET(request: Request) {
  try {
    await requireSession(request.headers);
  } catch {
    return NextResponse.json({ erreur: "Non authentifié" }, { status: 401 });
  }

  try {
    // Tout est lu en parallèle : c'est la première page ouverte, et chaque
    // lecture est indépendante des autres.
    const [groupe, faitsPartageables, compose, classify, actifs, total, escaladesOuvertes, etat] =
      await Promise.all([
        lireGroupeDeControle(),
        prisma.personaFact.count({ where: { shareable: true } }),
        resoudreRoute("compose"),
        resoudreRoute("classify"),
        prisma.contact.count({ where: { mode: { not: ContactMode.OFF } } }),
        prisma.contact.count(),
        prisma.escalation.count({ where: { status: "OPEN" } }),
        prisma.systemState.findUnique({ where: { id: "singleton" }, select: { globalPaused: true } }),
      ]);

    const reponse: EtatSysteme = {
      groupeDeControle: { pret: groupe !== null, nom: groupe?.nom ?? null },
      persona: { pret: faitsPartageables > 0, faitsPartageables },
      redaction: { pret: compose.length > 0, fournisseurs: compose.length },
      classement: { pret: classify.length > 0, fournisseurs: classify.length },
      contacts: { pret: actifs > 0, actifs, total },
      escaladesOuvertes,
      pauseGlobale: etat?.globalPaused ?? false,
    };
    return NextResponse.json({ etat: reponse });
  } catch (erreur) {
    log.error("État du système illisible", {
      chemin: "/api/etat",
      erreur: erreur instanceof Error ? erreur : String(erreur),
    });
    return NextResponse.json({ erreur: "État illisible" }, { status: 500 });
  }
}
