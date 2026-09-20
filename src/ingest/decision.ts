import { ContactMode, DecisionOutcome, MediaType, RiskCategory } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { log } from "@/lib/log";
import { evaluerReglesLexicales } from "@/decision/regles-lexicales";
import { classifier } from "@/decision/classifieur";
import { decider } from "@/decision/moteur";
import type { ContexteDecision, SignalRisque, Verdict } from "@/decision/types";

const JOUR_MS = 24 * 60 * 60 * 1000;

export async function deciderEtTracer(params: {
  messageId: string;
  contactId: string;
  texte: string | null;
  typeMedia: MediaType | null;
  classifierImpl?: typeof classifier;
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

  // Gate 0 avant toute dépense : un contact non activé ne déclenche aucun appel
  // à un fournisseur (P1). Idem pour un média, que le classifieur ne sait pas
  // lire et qui escalade de toute façon.
  const courtCircuit =
    contact.mode === ContactMode.OFF ||
    pauseGlobale ||
    params.typeMedia !== null ||
    params.texte === null ||
    params.texte.trim() === "";

  let signauxClassifieur: SignalRisque[] = [];
  let fournisseur: string | null = null;
  let latencyMs: number | null = null;
  let motif: string | null = null;
  let classifieurDisponible = true;

  if (!courtCircuit) {
    const resultat = await classifierUtilise({ texte: params.texte!, contactId: contact.id });
    signauxClassifieur = resultat.signaux;
    fournisseur = resultat.fournisseur;
    latencyMs = resultat.latencyMs;
    motif = resultat.motif;
    classifieurDisponible = resultat.fournisseur !== null;
  }

  // P3 : concaténation, jamais intersection. Un classifieur complaisant ne peut
  // pas annuler une règle déterministe.
  const signaux = [...signauxLexicaux, ...signauxClassifieur];

  const escaladeOuverte =
    (await prisma.escalation.count({
      where: { status: "OPEN", decision: { contactId: contact.id } },
    })) > 0;

  const dernierEchange = contact.thread?.lastMessageAt ?? null;
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
  await prisma.decision.create({
    data: {
      messageId: params.messageId,
      contactId: contact.id,
      risks: risquesUniques,
      ruleFired: verdict.regle,
      outcome: verdict.issue,
      classifierProvider: fournisseur,
      latencyMs,
      rawClassification: motif ? { motif } : undefined,
    },
  });

  log.info("Décision prise", {
    contactId: contact.id,
    messageId: params.messageId,
    issue: verdict.issue,
    regle: verdict.regle,
    risques: risquesUniques,
    fournisseur,
    latencyMs,
  });

  return verdict;
}
