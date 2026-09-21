import { NextResponse } from "next/server";
import { getEnv } from "@/config/env";
import { verifierSignature } from "@/ingest/signature";
import { webhookSchema } from "@/ingest/payload";
import { ingererMessage } from "@/ingest/handler";
import { log } from "@/lib/log";
import { lireGroupeDeControle } from "@/controle/groupe";

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
      log.error("Payload de message invalide", { issues: analyse.error.issues, chemin: "/api/webhook/gowa" });
      return NextResponse.json({ erreur: "Payload invalide" }, { status: 400 });
    }

    // Les événements non gérés (présence, accusés) sont acquittés sans traitement :
    // répondre en erreur déclencherait cinq tentatives inutiles côté GOWA.
    log.debug("Événement webhook non géré, acquitté sans traitement", { evenement: evenementBrut });
    return NextResponse.json({ statut: "ignore" });
  }

  try {
    // Résolu à chaque message plutôt qu'au démarrage : un groupe choisi dans
    // l'interface doit prendre effet tout de suite, sans redéploiement.
    const groupe = await lireGroupeDeControle();
    const resultat = await ingererMessage(analyse.data, {
      controlGroupJid: groupe?.jid,
    });
    return NextResponse.json(resultat);
  } catch (erreur) {
    log.error("Échec de l'ingestion", {
      chemin: "/api/webhook/gowa",
      erreur: erreur instanceof Error ? erreur : String(erreur),
    });
    // P2 : on signale l'échec plutôt que de l'avaler. GOWA réessaiera.
    return NextResponse.json({ erreur: "Ingestion impossible" }, { status: 500 });
  }
}
