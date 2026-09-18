import { prisma } from "@/lib/prisma";
import { detecterTypeMedia, type WebhookMessage } from "./payload";

export type IngestResult = {
  statut: "persiste" | "doublon" | "groupe_de_controle" | "ignore";
  messageId?: string;
};

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

  const contact = await prisma.contact.upsert({
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

  const fil =
    contact.thread ??
    (await prisma.thread.create({ data: { contactId: contact.id } }));

  const horodatage = new Date(payload.timestamp);
  const typeMedia = detecterTypeMedia(payload as Record<string, unknown>);

  const message = await prisma.message.create({
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

  await prisma.thread.update({
    where: { id: fil.id },
    data: { lastMessageAt: horodatage },
  });

  return { statut: "persiste", messageId: message.id };
}
