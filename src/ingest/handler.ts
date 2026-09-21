import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { log } from "@/lib/log";
import { deciderEtTracer } from "./decision";
import { detecterTypeMedia, type WebhookMessage } from "./payload";
import type { classifier } from "@/decision/classifieur";
import { traiterMessageControle } from "@/controle/routeur";
import {
  estMessageSysteme,
  MARQUEUR_ESCALADE,
  MARQUEUR_FAIT,
  MARQUEUR_SANS_EFFET,
} from "@/controle/marqueurs";
import { createGowaClient } from "@/gowa/client";

type EnvoyeurControle = (jid: string, texte: string) => Promise<{ messageId?: string }>;

async function envoyerAuGroupeDeControle(jid: string, texte: string): Promise<{ messageId?: string }> {
  return createGowaClient().sendText({ phone: jid, message: texte });
}

// ✅ = la commande a produit un effet ; ↩️ = elle n'a rien fait. Le routeur
// tranche lui-même via `aboutie` : le champ `action` ne suffisait pas, un
// `/mode` sur un alias introuvable et un `/mode` appliqué portent la même
// action, et l'utilisateur recevait un ✅ pour une commande sans effet.

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
  // `classifierImpl` n'existe que pour l'injection en test : elle traverse
  // jusqu'à `deciderEtTracer` sans changer le comportement par défaut
  // (le vrai classifieur reste utilisé en production).
  options: {
    controlGroupJid?: string;
    classifierImpl?: typeof classifier;
    // N'existe que pour l'injection en test : l'accusé de réception par
    // défaut passe par GOWA, jamais joint depuis la suite de tests.
    envoyerControle?: EnvoyeurControle;
  },
): Promise<IngestResult> {
  if (evenement.event !== "message") {
    return { statut: "ignore" };
  }

  const { payload } = evenement;

  if (options.controlGroupJid && payload.chat_id === options.controlGroupJid) {
    // Le groupe de contrôle est adossé au compte WhatsApp de l'utilisateur :
    // is_from_me vaut vrai à la fois quand il tape lui-même une commande et
    // quand le système y poste (escalade, accusé de réception, expiration),
    // puisque c'est le même compte des deux côtés.
    // Seuls les messages que l'utilisateur écrit lui-même dans le groupe sont
    // des commandes ; ceux des autres membres du groupe n'en sont jamais.
    if (!payload.is_from_me) {
      return { statut: "groupe_de_controle" };
    }

    const texte = payload.body ?? "";
    // Un message qui commence par un marqueur est une publication du système
    // (escalade, expiration, notre propre accusé de réception) revenue par le
    // webhook : la traiter comme une commande la ferait réagir à elle-même.
    if (estMessageSysteme(texte)) {
      return { statut: "groupe_de_controle" };
    }

    try {
      const resultat = await traiterMessageControle({
        texte,
        replyToWaId: payload.replied_to_id ?? null,
      });
      log.info("Commande de contrôle traitée", { action: resultat.action });

      const prefixe = resultat.aboutie ? MARQUEUR_FAIT : MARQUEUR_SANS_EFFET;
      const envoyerControle = options.envoyerControle ?? envoyerAuGroupeDeControle;
      try {
        await envoyerControle(options.controlGroupJid, `${prefixe} ${resultat.reponse}`);
      } catch (erreur) {
        // L'action a déjà eu lieu (traiterMessageControle a réussi) : un échec
        // de l'accusé de réception ne doit jamais faire échouer l'ingestion.
        log.error("Accusé de réception non publié dans le groupe de contrôle", {
          action: resultat.action,
          erreur: erreur instanceof Error ? erreur.message : String(erreur),
        });
      }
    } catch (erreur) {
      log.error("Commande de contrôle en échec", {
        erreur: erreur instanceof Error ? erreur.message : String(erreur),
      });
      // Une commande qui échoue en cours de route ne doit pas laisser
      // l'utilisateur devant un silence : il en déduirait que rien n'a eu lieu
      // et retaperait « 1 », ce qui enverrait le message une seconde fois —
      // l'escalade étant restée OPEN avec sa proposition. Le marqueur fait
      // aussi que cet avertissement ne reviendra pas comme une commande.
      const envoyerControle = options.envoyerControle ?? envoyerAuGroupeDeControle;
      try {
        await envoyerControle(
          options.controlGroupJid,
          `${MARQUEUR_ESCALADE} Ta commande n'est pas allée à son terme. Si elle demandait un envoi, ` +
            "le message est peut-être déjà parti : vérifie la conversation avant de réessayer.",
        );
      } catch (secondaire) {
        log.error("Avertissement d'échec non publié dans le groupe de contrôle", {
          erreur: secondaire instanceof Error ? secondaire.message : String(secondaire),
        });
      }
    }
    return { statut: "groupe_de_controle" };
  }

  const existant = await prisma.message.findUnique({
    where: { waMessageId: payload.id },
    include: { thread: true, decision: true },
  });
  if (existant) {
    // R18 : réparation par relecture plutôt que par transaction. GOWA rejoue
    // un webhook en échec jusqu'à 5 fois avec un backoff exponentiel ; si une
    // panne transitoire a empêché la Decision d'un précédent passage (message
    // persisté mais deciderEtTracer tombé), ce rejeu est l'occasion naturelle
    // de la produire — sans quoi le message reste indécis pour toujours (P5).
    // Les messages sortants ne sont jamais décidés, ici comme ailleurs.
    if (!payload.is_from_me && !existant.decision) {
      try {
        await deciderEtTracer({
          messageId: existant.id,
          contactId: existant.thread.contactId,
          texte: existant.text,
          typeMedia: existant.mediaType,
          classifierImpl: options.classifierImpl,
        });
      } catch (erreur) {
        // Même discipline que plus bas : un échec de réparation ne doit
        // jamais transformer un doublon en 500, sous peine de faire rejouer
        // à GOWA un message pourtant déjà persisté en toute sécurité.
        log.error("Réparation de la décision impossible pour un doublon", {
          messageId: existant.id,
          erreur: erreur instanceof Error ? erreur.message : String(erreur),
        });
      }
    }
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
    // Symétrique aux deux compensations ci-dessus : si la relecture ne confirme
    // pas le doublon (waMessageId n'était pas la contrainte violée — par exemple
    // Decision.messageId, unique depuis la phase 2), on relance plutôt que
    // d'avaler l'erreur sous un faux "doublon".
    const messageConcurrent = await prisma.message.findUnique({ where: { waMessageId: payload.id } });
    if (!messageConcurrent) throw erreur;
    return { statut: "doublon", messageId: messageConcurrent.id };
  }

  // Finding 2 : capturer la valeur AVANT l'écrasement. `deciderEtTracer`
  // calcule la dormance de la conversation à partir de cette date ; si on la
  // lit après la mise à jour ci-dessous, elle vaut toujours l'horodatage du
  // message qu'on est en train de décider, donc l'écart est toujours nul et
  // gate3.conversation-dormante ne peut jamais se déclencher.
  const dernierEchangeAvant = fil.lastMessageAt;

  await prisma.thread.update({
    where: { id: fil.id },
    data: { lastMessageAt: horodatage },
  });

  // Seuls les messages entrants sont décidés : un message que l'utilisateur a
  // écrit lui-même depuis son téléphone n'a pas à être classé.
  if (payload.is_from_me) {
    return { statut: "persiste", messageId: message.id };
  }

  // Finding 3 (R18) : le message est déjà persisté ci-dessus, donc un échec
  // de décision sur ce chemin principal doit remonter comme un échec
  // d'ingestion (P2) plutôt que d'être avalé. GOWA rejouera ce webhook sans
  // dupliquer le message (waMessageId est déjà pris) ; le rejeu retombera
  // dans la branche « doublon » plus haut, dont la réparation est idempotente
  // et, elle, ne doit jamais transformer un doublon déjà persisté en 500 —
  // c'est la seule branche où avaler l'erreur reste correct.
  try {
    await deciderEtTracer({
      messageId: message.id,
      contactId: contact.id,
      texte: payload.body ?? null,
      typeMedia: typeMedia,
      dernierEchangeAvant,
      classifierImpl: options.classifierImpl,
    });
  } catch (erreur) {
    log.error("Décision impossible pour un message pourtant persisté", {
      messageId: message.id,
      contactId: contact.id,
      erreur: erreur instanceof Error ? erreur.message : String(erreur),
    });
    throw erreur;
  }

  return { statut: "persiste", messageId: message.id };
}
