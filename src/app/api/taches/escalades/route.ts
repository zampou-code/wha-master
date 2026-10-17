import { NextResponse } from "next/server";
import { getEnv } from "@/config/env";
import { log } from "@/lib/log";
import { constantTimeEquals } from "@/lib/crypto";
import { expirerEscalades } from "@/escalade/expiration";
import { traiterEnvoisDus } from "@/envoi/file";
import { resumerFilsEnRetard } from "@/redacteur/resume";

export const dynamic = "force-dynamic";

// Déclenchée par une tâche planifiée, pas par une minuterie en processus : une
// minuterie ne survit pas à un redéploiement et s'exécute là où personne ne la
// regarde. Le secret du webhook sert d'authentification.
export async function POST(request: Request) {
  const fourni = request.headers.get("X-Tache-Secret");
  if (!fourni || !constantTimeEquals(fourni, getEnv().GOWA_WEBHOOK_SECRET)) {
    return NextResponse.json({ erreur: "Non autorisé" }, { status: 401 });
  }
  // Les travaux de fond passent par le même appel : ils sont indépendants, et
  // une seule tâche planifiée à entretenir vaut mieux que trois. Chacun est
  // isolé, parce qu'une expiration en panne ne doit pas retenir des messages
  // déjà promis — et réciproquement.
  //
  // Le résumé vient en dernier et n'a pas de latence à respecter : c'est le
  // seul endroit raisonnable pour l'appeler. Le faire à la réception d'un
  // message aurait ajouté un appel de modèle devant chaque réponse.
  const [expiration, envois, resumes] = await Promise.allSettled([
    expirerEscalades(),
    traiterEnvoisDus(),
    resumerFilsEnRetard(),
  ]);

  if (expiration.status === "rejected") {
    log.error("Expiration des escalades en échec", { erreur: String(expiration.reason) });
  }
  if (envois.status === "rejected") {
    log.error("Traitement de la file d'envoi en échec", { erreur: String(envois.reason) });
  }
  if (resumes.status === "rejected") {
    log.error("Résumés en retard non traités", { erreur: String(resumes.reason) });
  }

  const corps = {
    ...(expiration.status === "fulfilled" ? expiration.value : { expirationEnEchec: true }),
    ...(envois.status === "fulfilled" ? envois.value : { envoisEnEchec: true }),
    ...(resumes.status === "fulfilled" ? { resumes: resumes.value } : { resumesEnEchec: true }),
  };
  // 500 si l'un des deux travaux porteurs a échoué : la tâche planifiée doit le
  // voir dans son journal plutôt que de croire que tout va bien. Le résumé, lui,
  // ne retient aucun message : son échec est journalisé sans faire passer la
  // tâche pour en panne.
  const echec = expiration.status === "rejected" || envois.status === "rejected";
  return NextResponse.json(corps, { status: echec ? 500 : 200 });
}
