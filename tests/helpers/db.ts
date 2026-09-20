import { prisma } from "@/lib/prisma";

export async function resetDb(): Promise<void> {
  // ProviderConfig/ProviderRoute sont inclus : un test (tests/ia/registre.int.test.ts)
  // laisse une route par défaut en base après sa dernière assertion. Sans ce
  // nettoyage, un test d'un autre fichier dont le contact n'est pas OFF (ex.
  // handler.int.test.ts) peut faire résoudre cette route par le classifieur
  // réel et atteindre un vrai fournisseur IA — interdit dans les tests.
  // SystemState est inclus pour la même raison : un test qui pose
  // globalPaused = true (Gate 0) ne doit pas laisser cet état fuiter vers les
  // tests suivants, y compris ceux d'autres fichiers.
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "Message", "Thread", "ContactPolicy", "ContactProfile", "Decision", "Escalation", "Contact", "ProviderRoute", "ProviderConfig", "SystemState" RESTART IDENTITY CASCADE',
  );
}
