import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { detecterTypeMedia, type WebhookMessage } from "./payload";

export type IngestResult = {
  statut: "persiste" | "doublon" | "groupe_de_controle" | "ignore";
  messageId?: string;
};

// GOWA réessaie un webhook en échec jusqu'à 5 fois avec un backoff exponentiel :
// une première tentative lente peut donc réellement chevaucher sa propre relance.
// Les deux passent la vérification `findUnique` puis se disputent l'insertion ;
// on distingue cette violation d'unicité par son code Prisma, jamais par le texte
// de l'erreur.
function estViolationUnicite(erreur: unknown): boolean {
  return erreur instanceof Prisma.PrismaClientKnownRequestError && erreur.code === "P2002";
}

export async function ingererMessage(
  evenement: WebhookMessage,
  options: { controlGroupJid?: string },
): Promise<IngestResult> {
  if (evenement.event !== "message") {
    return { statut: "ignore" };
  }

  const { payload } = evenement;

  if (options.controlGroupJid && payload.chat_id === options.controlGroupJid) {
    return { statut: "groupe_de_controle" };
  }

  const existant = await prisma.message.findUnique({ where: { waMessageId: payload.id } });
  if (existant) {
    return { statut: "doublon", messageId: existant.id };
  }

  // Le contact du fil est toujours l'interlocuteur : chat_id, jamais l'expéditeur,
  // qui vaut notre propre jid quand is_from_me est vrai.
  const jidContact = payload.chat_id;

  let contact;
  try {
    contact = await prisma.contact.upsert({
      where: { jid: jidContact },
      // P1 : la création se fait sans `mode`, donc en OFF (valeur par défaut en base).
      // La mise à jour ne touche que pushName et ne peut jamais changer le mode
      // d'un contact déjà existant.
      create: {
        jid: jidContact,
        pushName: payload.is_from_me ? undefined : payload.from_name,
        thread: { create: {} },
        policy: { create: {} },
      },
      update: payload.is_from_me ? {} : { pushName: payload.from_name },
      include: { thread: true },
    });
  } catch (erreur) {
    if (!estViolationUnicite(erreur)) throw erreur;
    // La création imbriquée (thread + policy) empêche un upsert natif atomique :
    // un appel concurrent a inséré le contact entre notre vérification et notre
    // écriture. On récupère l'existant plutôt que de laisser l'erreur remonter ;
    // le mode de ce contact n'est jamais touché ici (P1).
    const contactConcurrent = await prisma.contact.findUnique({
      where: { jid: jidContact },
      include: { thread: true },
    });
    if (!contactConcurrent) throw erreur;
    contact = contactConcurrent;
  }

  let fil = contact.thread;
  if (!fil) {
    try {
      fil = await prisma.thread.create({ data: { contactId: contact.id } });
    } catch (erreur) {
      if (!estViolationUnicite(erreur)) throw erreur;
      // Un appel concurrent a créé le fil entre-temps : on le récupère au lieu
      // de laisser la violation d'unicité remonter.
      const filConcurrent = await prisma.thread.findUnique({ where: { contactId: contact.id } });
      if (!filConcurrent) throw erreur;
      fil = filConcurrent;
    }
  }

  const horodatage = new Date(payload.timestamp);
  const typeMedia = detecterTypeMedia(payload as Record<string, unknown>);

  let message;
  try {
    message = await prisma.message.create({
      data: {
        threadId: fil.id,
        waMessageId: payload.id,
        direction: payload.is_from_me ? "OUT" : "IN",
        source: "HUMAN",
        text: payload.body ?? null,
        mediaType: typeMedia,
        timestamp: horodatage,
        replyToWaId: payload.replied_to_id ?? null,
      },
    });
  } catch (erreur) {
    if (!estViolationUnicite(erreur)) throw erreur;
    // Livraison concurrente du même message : la course était sur waMessageId,
    // pas une véritable erreur de persistance (P2 reste respecté pour les autres).
    const messageConcurrent = await prisma.message.findUnique({ where: { waMessageId: payload.id } });
    return { statut: "doublon", messageId: messageConcurrent?.id };
  }

  await prisma.thread.update({
    where: { id: fil.id },
    data: { lastMessageAt: horodatage },
  });

  return { statut: "persiste", messageId: message.id };
}
