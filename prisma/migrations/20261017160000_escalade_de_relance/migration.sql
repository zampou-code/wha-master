-- Une escalade peut désormais porter sur une relance : une proposition
-- d'initiative ne répond à aucun message reçu, donc n'a pas de Decision.
--
-- En trois temps, et non en une instruction : `ADD COLUMN "contactId" TEXT NOT
-- NULL` échouerait sur une table qui contient déjà des escalades — c'est ce que
-- `prisma migrate diff` a proposé, et ce qui aurait bloqué le démarrage en
-- production, `migrate deploy` tournant avant l'application.

-- 1. La colonne arrive nullable, donc acceptable pour les lignes existantes.
ALTER TABLE "Escalation" ADD COLUMN "contactId" TEXT;

-- 2. Chaque escalade existante tient son contact de sa décision.
UPDATE "Escalation" AS e
SET "contactId" = d."contactId"
FROM "Decision" AS d
WHERE e."decisionId" = d."id" AND e."contactId" IS NULL;

-- 3. Une escalade sans contact ne mène à personne : il n'y a rien à en faire,
-- et la laisser en base ferait échouer la contrainte. Le cas n'existe que si
-- une décision a disparu sans emporter son escalade.
DELETE FROM "Escalation" WHERE "contactId" IS NULL;

ALTER TABLE "Escalation" ALTER COLUMN "contactId" SET NOT NULL;
ALTER TABLE "Escalation" ALTER COLUMN "decisionId" DROP NOT NULL;

ALTER TABLE "Thread" ADD COLUMN "lastInitiativeAt" TIMESTAMP(3);

CREATE INDEX "Escalation_contactId_status_idx" ON "Escalation"("contactId", "status");

ALTER TABLE "Escalation" ADD CONSTRAINT "Escalation_contactId_fkey"
  FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;
