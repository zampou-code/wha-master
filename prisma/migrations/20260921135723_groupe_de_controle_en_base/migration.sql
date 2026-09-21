-- Le groupe de contrôle se choisit désormais depuis l'interface plutôt que par
-- une variable d'environnement. Colonnes nullables, sans valeur par défaut :
-- migration purement additive, aucune donnée existante n'est touchée.
-- AlterTable
ALTER TABLE "SystemState" ADD COLUMN     "controlGroupJid" TEXT,
ADD COLUMN     "controlGroupName" TEXT;

