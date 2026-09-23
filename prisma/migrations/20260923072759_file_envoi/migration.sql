-- CreateEnum
CREATE TYPE "StatutEnvoi" AS ENUM ('EN_ATTENTE', 'ENVOYE', 'ANNULE', 'ECHEC');

-- CreateTable
CREATE TABLE "EnvoiPlanifie" (
    "id" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "decisionId" TEXT,
    "texte" TEXT NOT NULL,
    "source" "MessageSource" NOT NULL DEFAULT 'AUTO',
    "aEnvoyerApres" TIMESTAMP(3) NOT NULL,
    "statut" "StatutEnvoi" NOT NULL DEFAULT 'EN_ATTENTE',
    "tentatives" INTEGER NOT NULL DEFAULT 0,
    "dernierEchec" TEXT,
    "waMessageId" TEXT,
    "envoyeA" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EnvoiPlanifie_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "EnvoiPlanifie_decisionId_key" ON "EnvoiPlanifie"("decisionId");

-- CreateIndex
CREATE INDEX "EnvoiPlanifie_statut_aEnvoyerApres_idx" ON "EnvoiPlanifie"("statut", "aEnvoyerApres");

-- AddForeignKey
ALTER TABLE "EnvoiPlanifie" ADD CONSTRAINT "EnvoiPlanifie_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EnvoiPlanifie" ADD CONSTRAINT "EnvoiPlanifie_decisionId_fkey" FOREIGN KEY ("decisionId") REFERENCES "Decision"("id") ON DELETE SET NULL ON UPDATE CASCADE;

