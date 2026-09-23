-- Kimi (Moonshot) devient un choix nommé plutôt qu'un « compatible OpenAI »
-- dont il fallait connaître l'adresse de base. Ajout de valeur d'énumération :
-- purement additif, aucune ligne existante n'est touchée.
-- AlterEnum
ALTER TYPE "ProviderKind" ADD VALUE 'KIMI';

