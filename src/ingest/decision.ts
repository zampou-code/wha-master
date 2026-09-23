import { ContactMode, DecisionOutcome, MediaType, RiskCategory } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { log } from "@/lib/log";
import { evaluerReglesLexicales } from "@/decision/regles-lexicales";
import { classifier } from "@/decision/classifieur";
import { decider } from "@/decision/moteur";
import type { ContexteDecision, SignalRisque, Verdict } from "@/decision/types";
import { publierEscalade } from "@/escalade/publication";
import { traiterEnvoiAutonome } from "@/envoi/auto";

const JOUR_MS = 24 * 60 * 60 * 1000;

// La phase 3a n'envoie jamais seule : un verdict AUTO_SENT est soumis à
// validation comme un brouillon. Sans AUTO_SENT dans cet ensemble, un contact
// en mode automatique tombait dans un trou noir — ni envoi, ni escalade, ni
// alerte — pendant que la base enregistrait « envoyé automatiquement ».
// AUTO_SENT n'est plus de la partie : il a son propre chemin, qui planifie un
// envoi et ne retombe sur l'escalade que si le rédacteur ne produit rien de
// valide. Le laisser ici escaladerait tout deux fois.
const PRODUIT_UNE_ESCALADE: ReadonlySet<DecisionOutcome> = new Set([
  DecisionOutcome.ESCALATED,
  DecisionOutcome.DRAFTED,
]);

export async function deciderEtTracer(params: {
  messageId: string;
  contactId: string;
  texte: string | null;
  typeMedia: MediaType | null;
  classifierImpl?: typeof classifier;
  // Finding 2 : l'horodatage du dernier échange AVANT le message en cours de
  // décision. L'appelant (src/ingest/handler.ts) le capture avant d'écraser
  // `thread.lastMessageAt` avec l'horodatage de ce même message — sans quoi
  // cette fonction ne verrait plus que l'horodatage du message qu'elle est en
  // train de décider, et la dormance ne pourrait jamais se déclencher.
  // Quand omis (ex. réparation R18 d'un doublon), on retombe sur la valeur
  // actuellement en base.
  dernierEchangeAvant?: Date | null;
}): Promise<Verdict> {
  const classifierUtilise = params.classifierImpl ?? classifier;

  const contact = await prisma.contact.findUnique({
    where: { id: params.contactId },
    include: { policy: true, thread: true },
  });
  if (!contact) {
    throw new Error(`Contact ${params.contactId} introuvable`);
  }

  const etat = await prisma.systemState.findUnique({ where: { id: "singleton" } });
  const pauseGlobale = etat?.globalPaused ?? false;

  const politique = contact.policy;
  const gardeFous = {
    engagement: politique?.guardEngagement ?? true,
    facts: politique?.guardFacts ?? true,
    emotional: politique?.guardEmotional ?? true,
    money: politique?.guardMoney ?? true,
    intimate: politique?.guardIntimate ?? true,
    thirdParty: politique?.guardThirdParty ?? true,
  };

  const signauxLexicaux = evaluerReglesLexicales(params.texte, params.typeMedia);

  // Finding 8 : le court-circuit garantit qu'on n'appelle le classifieur que
  // pour un texte non vide, mais un booléen agrégé ne le dit pas au typage.
  // `texteExploitable` rétrécit `params.texte` une fois pour toutes ; on
  // vérifie sa nullité au point d'usage plutôt que d'affirmer `params.texte!`.
  const texteExploitable =
    params.texte !== null && params.texte.trim() !== "" ? params.texte : null;

  // Gate 0 avant toute dépense : un contact non activé ne déclenche aucun appel
  // à un fournisseur (P1). Idem pour un média, que le classifieur ne sait pas
  // lire et qui escalade de toute façon.
  const courtCircuit =
    contact.mode === ContactMode.OFF ||
    pauseGlobale ||
    params.typeMedia !== null ||
    texteExploitable === null;

  let signauxClassifieur: SignalRisque[] = [];
  let fournisseur: string | null = null;
  let latencyMs: number | null = null;
  let motif: string | null = null;
  let classifieurDisponible = true;
  let coutUsd: number | null = null;

  if (!courtCircuit && texteExploitable !== null) {
    const resultat = await classifierUtilise({ texte: texteExploitable, contactId: contact.id });
    signauxClassifieur = resultat.signaux;
    fournisseur = resultat.fournisseur;
    latencyMs = resultat.latencyMs;
    motif = resultat.motif;
    classifieurDisponible = resultat.fournisseur !== null;
    coutUsd = resultat.costUsd;
  }

  // P3 : concaténation, jamais intersection. Un classifieur complaisant ne peut
  // pas annuler une règle déterministe.
  const signaux = [...signauxLexicaux, ...signauxClassifieur];

  const escaladeOuverte =
    (await prisma.escalation.count({
      where: { status: "OPEN", decision: { contactId: contact.id } },
    })) > 0;

  const dernierEchange =
    params.dernierEchangeAvant !== undefined ? params.dernierEchangeAvant : (contact.thread?.lastMessageAt ?? null);
  const dernierEchangeIlYaJours = dernierEchange
    ? Math.floor((Date.now() - dernierEchange.getTime()) / JOUR_MS)
    : null;

  const contexte: ContexteDecision = {
    mode: contact.mode,
    pauseGlobale,
    gardeFous,
    intimateOverride: politique?.intimateOverride ?? false,
    isAdult: contact.isAdult,
    signaux,
    autoStreak: contact.thread?.autoStreak ?? 0,
    maxAutoStreak: politique?.maxAutoStreak ?? 6,
    escaladeOuverte,
    dernierEchangeIlYaJours,
    classifieurDisponible,
  };

  const verdict = decider(contexte);

  // P5 : la décision est tracée quelle qu'en soit l'issue, y compris IGNORED.
  const risquesUniques = [...new Set(verdict.risques)] as RiskCategory[];

  // Le moteur peut dire AUTO_SENT sans que rien ne parte : le rédacteur doit
  // d'abord produire un brouillon que la validation accepte. On persiste donc
  // d'abord l'issue la plus prudente, et on ne l'élève à AUTO_SENT qu'une fois
  // l'envoi réellement planifié. `ruleFired` garde le verdict d'origine.
  const issueProvisoire =
    verdict.issue === DecisionOutcome.AUTO_SENT ? DecisionOutcome.DRAFTED : verdict.issue;
  const decisionCreee = await prisma.decision.create({
    data: {
      messageId: params.messageId,
      contactId: contact.id,
      risks: risquesUniques,
      ruleFired: verdict.regle,
      outcome: issueProvisoire,
      classifierProvider: fournisseur,
      latencyMs,
      costUsd: coutUsd,
      rawClassification: motif ? { motif } : undefined,
    },
    select: { id: true },
  });

  log.info("Décision prise", {
    contactId: contact.id,
    messageId: params.messageId,
    issue: issueProvisoire,
    verdictMoteur: verdict.issue,
    regle: verdict.regle,
    risques: risquesUniques,
    fournisseur,
    latencyMs,
  });

  if (verdict.issue === DecisionOutcome.AUTO_SENT) {
    try {
      const issue = await traiterEnvoiAutonome({
        decisionId: decisionCreee.id,
        contactId: contact.id,
        messageRecu: params.texte ?? "(message non textuel)",
        risques: risquesUniques,
      });
      if (issue.planifie) {
        // Élevée seulement maintenant : un envoi est réellement inscrit dans la
        // file. S'il est annulé plus tard, la file en garde la trace.
        await prisma.decision.update({
          where: { id: decisionCreee.id },
          data: { outcome: DecisionOutcome.AUTO_SENT },
        });
      }
    } catch (erreur) {
      log.error("Chemin autonome en échec", {
        decisionId: decisionCreee.id,
        erreur: erreur instanceof Error ? erreur.message : String(erreur),
      });
    }
  } else if (PRODUIT_UNE_ESCALADE.has(verdict.issue)) {
    try {
      await publierEscalade({
        decisionId: decisionCreee.id,
        contactId: contact.id,
        messageRecu: params.texte ?? "(message non textuel)",
        risques: risquesUniques,
      });
    } catch (erreur) {
      // Une escalade non publiée ne doit pas faire échouer la décision, qui est
      // déjà tracée. Le journal en garde la trace.
      log.error("Escalade non publiée", {
        decisionId: decisionCreee.id,
        erreur: erreur instanceof Error ? erreur.message : String(erreur),
      });
    }
  }

  return verdict;
}
