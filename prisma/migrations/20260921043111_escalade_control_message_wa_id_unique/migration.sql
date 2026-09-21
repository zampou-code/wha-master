-- Un même `controlMessageWaId` ne peut plus désigner deux escalades à la
-- fois. Sans cette contrainte, deux escalades ouvertes en même temps avec le
-- même identifiant de message de contrôle laissaient le routeur choisir
-- silencieusement laquelle traiter (`findFirst` sans tri), au risque
-- d'écrire au mauvais contact. Postgres traite chaque NULL comme distinct :
-- les escalades pas encore postées (controlMessageWaId encore NULL) ne se
-- gênent pas entre elles.
CREATE UNIQUE INDEX "Escalation_controlMessageWaId_key" ON "Escalation"("controlMessageWaId");
