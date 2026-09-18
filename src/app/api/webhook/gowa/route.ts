import { NextResponse } from "next/server";
import { getEnv } from "@/config/env";
import { verifierSignature } from "@/ingest/signature";
import { webhookSchema } from "@/ingest/payload";
import { ingererMessage } from "@/ingest/handler";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const env = getEnv();
  const corpsBrut = await request.text();

  if (!verifierSignature(corpsBrut, request.headers.get("X-Hub-Signature-256"), env.GOWA_WEBHOOK_SECRET)) {
    return NextResponse.json({ erreur: "Signature invalide" }, { status: 401 });
  }

  let brut: unknown;
  try {
    brut = JSON.parse(corpsBrut);
  } catch {
    return NextResponse.json({ erreur: "Corps illisible" }, { status: 400 });
  }

  const analyse = webhookSchema.safeParse(brut);
  if (!analyse.success) {
    const evenementBrut =
      typeof brut === "object" && brut !== null && "event" in brut
        ? (brut as { event?: unknown }).event
        : undefined;

    if (evenementBrut === "message") {
      // Un événement "message" qui ne respecte pas le contrat attendu est une
      // anomalie réelle (P2) : GOWA a changé de format, ou notre schéma est
      // faux. Le signaler et refuser plutôt que d'avaler silencieusement des
      // messages — voir docs/deploiement.md section 10.3.
      console.error("Payload de message invalide", analyse.error.issues);
      return NextResponse.json({ erreur: "Payload invalide" }, { status: 400 });
    }

    // Les événements non gérés (présence, accusés) sont acquittés sans traitement :
    // répondre en erreur déclencherait cinq tentatives inutiles côté GOWA.
    console.debug("Événement webhook non géré, acquitté sans traitement", evenementBrut);
    return NextResponse.json({ statut: "ignore" });
  }

  try {
    const resultat = await ingererMessage(analyse.data, {
      controlGroupJid: env.CONTROL_GROUP_JID,
    });
    return NextResponse.json(resultat);
  } catch (erreur) {
    console.error("Échec de l'ingestion", erreur);
    // P2 : on signale l'échec plutôt que de l'avaler. GOWA réessaiera.
    return NextResponse.json({ erreur: "Ingestion impossible" }, { status: 500 });
  }
}
