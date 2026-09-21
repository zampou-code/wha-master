import { prisma } from "@/lib/prisma";

// Six heures : au-delà, une escalade non résolue ne correspond plus au fil de la
// conversation. Rien n'est envoyé, un rappel est posté.
export const DUREE_ESCALADE_MS = 6 * 60 * 60 * 1000;

export async function creerEscalade(params: {
  decisionId: string;
  proposition: string | null;
  expiresAt?: Date;
}): Promise<{ id: string }> {
  const escalade = await prisma.escalation.create({
    data: {
      decisionId: params.decisionId,
      proposedText: params.proposition,
      expiresAt: params.expiresAt ?? new Date(Date.now() + DUREE_ESCALADE_MS),
    },
    select: { id: true },
  });
  return escalade;
}

export async function marquerPostee(escaladeId: string, controlMessageWaId: string): Promise<void> {
  await prisma.escalation.update({
    where: { id: escaladeId },
    data: { controlMessageWaId },
  });
}
