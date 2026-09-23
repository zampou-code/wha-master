import { MessageSource } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { log } from "@/lib/log";

export type EnvoiAConsigner = {
  contactId: string;
  texte: string;
  // L'identifiant rendu par WhatsApp. Absent si l'envoi a réussi sans que GOWA
  // le renvoie : on consigne quand même le message, avec un identifiant de
  // repli, plutôt que de perdre la trace de ce qui est parti.
  waMessageId?: string;
  // `AUTO` quand le système a envoyé seul, `HUMAN` quand l'utilisateur a
  // approuvé ou écrit le texte : c'est cette distinction qui gouverne le
  // plafond de messages automatiques consécutifs.
  source: MessageSource;
};

/**
 * Consigne un message sortant et met à jour le fil.
 *
 * Sans cette fonction, un message envoyé n'existait nulle part : le rédacteur
 * ne voyait jamais ce qu'il venait de faire envoyer et rédigeait le tour suivant
 * comme si la conversation s'était arrêtée au message du contact. Le compteur
 * `autoStreak` n'était pas écrit non plus, ce qui rendait le garde-fou
 * « plafond de messages automatiques » structurellement inerte.
 */
export async function consignerEnvoi(envoi: EnvoiAConsigner): Promise<{ messageId: string } | null> {
  const fil = await prisma.thread.findUnique({ where: { contactId: envoi.contactId } });
  if (!fil) {
    log.error("Envoi consigné sans fil : le message est parti mais ne sera pas retrouvé", {
      contactId: envoi.contactId,
    });
    return null;
  }

  const maintenant = new Date();
  // `waMessageId` est unique en base ; un envoi rejoué par erreur ne doit pas
  // créer deux lignes. Le repli porte l'horodatage pour rester unique quand
  // WhatsApp ne rend pas d'identifiant.
  const waMessageId = envoi.waMessageId ?? `local-${fil.id}-${maintenant.getTime()}`;

  const message = await prisma.message.upsert({
    where: { waMessageId },
    create: {
      threadId: fil.id,
      waMessageId,
      direction: "OUT",
      source: envoi.source,
      text: envoi.texte,
      timestamp: maintenant,
    },
    update: {},
    select: { id: true },
  });


  await prisma.thread.update({
    where: { id: fil.id },
    data: {
      lastMessageAt: maintenant,
      // Un envoi automatique fait monter le compteur ; un message que
      // l'utilisateur a approuvé ou écrit le remet à zéro, puisqu'il vient de
      // reprendre la main sur la conversation.
      autoStreak: envoi.source === MessageSource.AUTO ? { increment: 1 } : 0,
    },
  });

  return { messageId: message.id };
}
