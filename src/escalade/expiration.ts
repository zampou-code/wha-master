import { getEnv } from "@/config/env";
import { prisma } from "@/lib/prisma";
import { log } from "@/lib/log";
import { createGowaClient } from "@/gowa/client";

type Envoyeur = (jid: string, texte: string) => Promise<unknown>;

async function envoyerParGowa(jid: string, texte: string): Promise<unknown> {
  return createGowaClient().sendText({ phone: jid, message: texte });
}

export async function expirerEscalades(params: {
  maintenant?: Date;
  envoyer?: Envoyeur;
} = {}): Promise<{ expirees: number }> {
  const maintenant = params.maintenant ?? new Date();
  const envoyer = params.envoyer ?? envoyerParGowa;

  const depassees = await prisma.escalation.findMany({
    where: { status: "OPEN", expiresAt: { lt: maintenant } },
    select: { id: true },
  });
  if (depassees.length === 0) return { expirees: 0 };

  await prisma.escalation.updateMany({
    where: { id: { in: depassees.map((e) => e.id) } },
    data: { status: "EXPIRED" },
  });

  const groupe = getEnv().CONTROL_GROUP_JID;
  if (groupe) {
    // Un rappel groupé plutôt qu'un message par escalade : à six heures
    // d'échéance, plusieurs peuvent expirer ensemble, et autant de
    // notifications rendraient le groupe inutilisable.
    const texte =
      `⏳ ${depassees.length} escalade(s) expirée(s) sans réponse. ` +
      `Rien n'a été envoyé.`;
    try {
      await envoyer(groupe, texte);
    } catch (erreur) {
      log.error("Rappel d'expiration non posté", {
        erreur: erreur instanceof Error ? erreur.message : String(erreur),
      });
    }
  }

  log.info("Escalades expirées", { nombre: depassees.length });
  return { expirees: depassees.length };
}
