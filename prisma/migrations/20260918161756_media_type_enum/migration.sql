-- CreateEnum
CREATE TYPE "MediaType" AS ENUM ('IMAGE', 'VIDEO', 'AUDIO', 'DOCUMENT', 'STICKER', 'CONTACT', 'LOCATION');

-- AlterTable
ALTER TABLE "Message" ALTER COLUMN "mediaType" TYPE "MediaType" USING upper("mediaType")::"MediaType";
