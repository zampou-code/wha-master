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
    // Les événements non gérés (présence, accusés) sont acquittés sans traitement :
    // répondre en erreur déclencherait cinq tentatives inutiles côté GOWA.
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
