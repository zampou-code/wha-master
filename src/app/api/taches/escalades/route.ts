import { NextResponse } from "next/server";
import { getEnv } from "@/config/env";
import { log } from "@/lib/log";
import { constantTimeEquals } from "@/lib/crypto";
import { expirerEscalades } from "@/escalade/expiration";
import { traiterEnvoisDus } from "@/envoi/file";

export const dynamic = "force-dynamic";

// Déclenchée par une tâche planifiée, pas par une minuterie en processus : une
// minuterie ne survit pas à un redéploiement et s'exécute là où personne ne la
// regarde. Le secret du webhook sert d'authentification.
export async function POST(request: Request) {
  const fourni = request.headers.get("X-Tache-Secret");
  if (!fourni || !constantTimeEquals(fourni, getEnv().GOWA_WEBHOOK_SECRET)) {
    return NextResponse.json({ erreur: "Non autorisé" }, { status: 401 });
  }
  // Les deux travaux de fond passent par le même appel : ils sont indépendants,
  // et une seule tâche planifiée à entretenir vaut mieux que deux. Chacun est
  // isolé, parce qu'une expiration en panne ne doit pas retenir des messages
  // déjà promis — et réciproquement.
  const [expiration, envois] = await Promise.allSettled([expirerEscalades(), traiterEnvoisDus()]);

  if (expiration.status === "rejected") {
    log.error("Expiration des escalades en échec", { erreur: String(expiration.reason) });
  }
  if (envois.status === "rejected") {
    log.error("Traitement de la file d'envoi en échec", { erreur: String(envois.reason) });
  }

  const corps = {
    ...(expiration.status === "fulfilled" ? expiration.value : { expirationEnEchec: true }),
    ...(envois.status === "fulfilled" ? envois.value : { envoisEnEchec: true }),
  };
  // 500 si l'un des deux a échoué : la tâche planifiée doit le voir dans son
  // journal plutôt que de croire que tout va bien.
  const echec = expiration.status === "rejected" || envois.status === "rejected";
  return NextResponse.json(corps, { status: echec ? 500 : 200 });
}
