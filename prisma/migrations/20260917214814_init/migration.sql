-- CreateEnum
CREATE TYPE "ContactMode" AS ENUM ('OFF', 'DRAFT', 'AUTO');

-- CreateEnum
CREATE TYPE "Direction" AS ENUM ('IN', 'OUT');

-- CreateEnum
CREATE TYPE "MessageSource" AS ENUM ('HUMAN', 'AUTO', 'IMPORT');

-- CreateEnum
CREATE TYPE "FactSource" AS ENUM ('QUESTIONNAIRE', 'INFERRED');

-- CreateEnum
CREATE TYPE "RiskCategory" AS ENUM ('ENGAGEMENT', 'FACT', 'EMOTIONAL', 'MONEY', 'INTIMATE', 'THIRD_PARTY', 'LOW_CONFIDENCE', 'NON_TEXT');

-- CreateEnum
CREATE TYPE "DecisionOutcome" AS ENUM ('AUTO_SENT', 'DRAFTED', 'ESCALATED', 'IGNORED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "EscalationStatus" AS ENUM ('OPEN', 'RESOLVED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "ProviderKind" AS ENUM ('ANTHROPIC', 'OPENAI', 'GOOGLE', 'OPENAI_COMPATIBLE', 'OLLAMA');

-- CreateTable
CREATE TABLE "Contact" (
    "id" TEXT NOT NULL,
    "jid" TEXT NOT NULL,
    "pushName" TEXT,
    "alias" TEXT,
    "isAdult" BOOLEAN NOT NULL DEFAULT false,
    "mode" "ContactMode" NOT NULL DEFAULT 'OFF',
    "activatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Contact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContactPolicy" (
    "id" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "guardEngagement" BOOLEAN NOT NULL DEFAULT true,
    "guardFacts" BOOLEAN NOT NULL DEFAULT true,
    "guardEmotional" BOOLEAN NOT NULL DEFAULT true,
    "guardMoney" BOOLEAN NOT NULL DEFAULT true,
    "guardIntimate" BOOLEAN NOT NULL DEFAULT true,
    "guardThirdParty" BOOLEAN NOT NULL DEFAULT true,
    "intimateOverride" BOOLEAN NOT NULL DEFAULT false,
    "quietHoursStart" INTEGER,
    "quietHoursEnd" INTEGER,
    "timezone" TEXT NOT NULL DEFAULT 'Africa/Abidjan',
    "maxAutoStreak" INTEGER NOT NULL DEFAULT 6,
    "minDelaySec" INTEGER NOT NULL DEFAULT 45,
    "maxDelaySec" INTEGER NOT NULL DEFAULT 600,
    "styleLength" TEXT NOT NULL DEFAULT 'moyen',
    "styleEmoji" TEXT NOT NULL DEFAULT 'parfois',
    "styleFormality" TEXT NOT NULL DEFAULT 'tutoiement',
    "styleLanguage" TEXT NOT NULL DEFAULT 'fr',
    "styleInitiative" TEXT NOT NULL DEFAULT 'rare',
    "providerRouteId" TEXT,

    CONSTRAINT "ContactPolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Thread" (
    "id" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "rollingSummary" TEXT NOT NULL DEFAULT '',
    "lastSummarizedMessageId" TEXT,
    "relationStage" TEXT NOT NULL DEFAULT 'inconnu',
    "medianReplyDelaySec" INTEGER,
    "autoStreak" INTEGER NOT NULL DEFAULT 0,
    "lastMessageAt" TIMESTAMP(3),

    CONSTRAINT "Thread_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Message" (
    "id" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "waMessageId" TEXT NOT NULL,
    "direction" "Direction" NOT NULL,
    "source" "MessageSource" NOT NULL,
    "text" TEXT,
    "mediaType" TEXT,
    "timestamp" TIMESTAMP(3) NOT NULL,
    "replyToWaId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PersonaProfile" (
    "id" TEXT NOT NULL DEFAULT 'self',
    "styleGuide" JSONB NOT NULL DEFAULT '{}',
    "hardLimits" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PersonaProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PersonaFact" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "shareable" BOOLEAN NOT NULL DEFAULT false,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "source" "FactSource" NOT NULL DEFAULT 'QUESTIONNAIRE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PersonaFact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContactProfile" (
    "id" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "observedTone" TEXT,
    "observedRhythm" TEXT,
    "topics" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "proposedParams" JSONB NOT NULL DEFAULT '{}',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ContactProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Decision" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "risks" "RiskCategory"[],
    "ruleFired" TEXT NOT NULL,
    "outcome" "DecisionOutcome" NOT NULL,
    "classifierProvider" TEXT,
    "composerProvider" TEXT,
    "latencyMs" INTEGER,
    "costUsd" DOUBLE PRECISION,
    "rawClassification" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Decision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Escalation" (
    "id" TEXT NOT NULL,
    "decisionId" TEXT NOT NULL,
    "status" "EscalationStatus" NOT NULL DEFAULT 'OPEN',
    "controlMessageWaId" TEXT,
    "proposedText" TEXT,
    "resolution" TEXT,
    "resolvedText" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Escalation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProviderConfig" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "ProviderKind" NOT NULL,
    "apiKeyEncrypted" TEXT,
    "baseUrl" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "healthyAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProviderConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProviderRoute" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "entries" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "ProviderRoute_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SystemState" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "globalPaused" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "SystemState_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Contact_jid_key" ON "Contact"("jid");

-- CreateIndex
CREATE UNIQUE INDEX "ContactPolicy_contactId_key" ON "ContactPolicy"("contactId");

-- CreateIndex
CREATE UNIQUE INDEX "Thread_contactId_key" ON "Thread"("contactId");

-- CreateIndex
CREATE UNIQUE INDEX "Message_waMessageId_key" ON "Message"("waMessageId");

-- CreateIndex
CREATE INDEX "Message_threadId_timestamp_idx" ON "Message"("threadId", "timestamp");

-- CreateIndex
CREATE UNIQUE INDEX "PersonaFact_key_key" ON "PersonaFact"("key");

-- CreateIndex
CREATE UNIQUE INDEX "ContactProfile_contactId_key" ON "ContactProfile"("contactId");

-- CreateIndex
CREATE UNIQUE INDEX "Decision_messageId_key" ON "Decision"("messageId");

-- CreateIndex
CREATE INDEX "Decision_contactId_createdAt_idx" ON "Decision"("contactId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Escalation_decisionId_key" ON "Escalation"("decisionId");

-- CreateIndex
CREATE INDEX "Escalation_status_expiresAt_idx" ON "Escalation"("status", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "ProviderConfig_name_key" ON "ProviderConfig"("name");

-- CreateIndex
CREATE UNIQUE INDEX "ProviderRoute_name_key" ON "ProviderRoute"("name");

-- AddForeignKey
ALTER TABLE "ContactPolicy" ADD CONSTRAINT "ContactPolicy_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Thread" ADD CONSTRAINT "Thread_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "Thread"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContactProfile" ADD CONSTRAINT "ContactProfile_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Decision" ADD CONSTRAINT "Decision_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Decision" ADD CONSTRAINT "Decision_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Escalation" ADD CONSTRAINT "Escalation_decisionId_fkey" FOREIGN KEY ("decisionId") REFERENCES "Decision"("id") ON DELETE CASCADE ON UPDATE CASCADE;
