import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { log } from "@/lib/log";

export const dynamic = "force-dynamic";

const PAR_PAGE = 50;

export async function GET(request: Request) {
  try {
    await requireSession(request.headers);
  } catch {
    return NextResponse.json({ erreur: "Non authentifié" }, { status: 401 });
  }

  const url = new URL(request.url);
  const contactId = url.searchParams.get("contactId");

  try {
    const decisions = await prisma.decision.findMany({
      where: contactId ? { contactId } : {},
      // `id` départage les décisions écrites dans la même milliseconde, sinon
      // l'ordre d'affichage varie d'un rechargement à l'autre.
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: PAR_PAGE,
      select: {
        id: true,
        createdAt: true,
        outcome: true,
        risks: true,
        ruleFired: true,
        costUsd: true,
        classifierProvider: true,
        contact: { select: { id: true, alias: true, pushName: true, jid: true } },
        message: { select: { text: true, direction: true } },
        escalation: { select: { status: true, resolution: true } },
      },
    });

    return NextResponse.json({
      decisions: decisions.map((decision) => ({
        id: decision.id,
        quand: decision.createdAt.toISOString(),
        issue: decision.outcome,
        risques: decision.risks,
        regle: decision.ruleFired,
        coutUsd: decision.costUsd,
        classifieur: decision.classifierProvider,
        contact: {
          id: decision.contact.id,
          nom:
            decision.contact.alias ??
            decision.contact.pushName ??
            decision.contact.jid.split("@")[0],
        },
        message: decision.message.text,
        escalade: decision.escalation
          ? { statut: decision.escalation.status, resolution: decision.escalation.resolution }
          : null,
      })),
    });
  } catch (erreur) {
    log.error("Journal des décisions illisible", {
      chemin: "/api/journal",
      erreur: erreur instanceof Error ? erreur : String(erreur),
    });
    return NextResponse.json({ erreur: "Journal illisible" }, { status: 500 });
  }
}
