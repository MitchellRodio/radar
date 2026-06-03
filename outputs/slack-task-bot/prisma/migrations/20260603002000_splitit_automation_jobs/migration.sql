ALTER TYPE "RequestUpdateKind" ADD VALUE IF NOT EXISTS 'AUTOMATION_UPDATED';

CREATE TYPE "SplititAutomationStatus" AS ENUM ('QUEUED', 'RUNNING', 'WAITING_ON_SPLITIT', 'DONE', 'BLOCKED', 'FAILED');
CREATE TYPE "SplititAutomationStep" AS ENUM ('QUEUED', 'SENT_NAME', 'SENT_ROLE', 'SENT_STORE_AND_EMAIL', 'SENT_WHITELIST_REQUEST', 'WAITING_FOR_REPLY', 'COMPLETED', 'BLOCKED');

CREATE TABLE "SplititAutomationJob" (
  "id" TEXT NOT NULL,
  "requestId" INTEGER NOT NULL,
  "targetEmail" TEXT NOT NULL,
  "csmName" TEXT NOT NULL DEFAULT 'Mitchell Rodio',
  "merchantRole" TEXT NOT NULL DEFAULT 'Merchant',
  "storeName" TEXT NOT NULL DEFAULT 'Whop.com',
  "merchantEmail" TEXT NOT NULL DEFAULT 'mitchell.rodio@whop.com',
  "riskAcknowledgement" TEXT NOT NULL DEFAULT 'Please whitelist, I understand the risks',
  "status" "SplititAutomationStatus" NOT NULL DEFAULT 'QUEUED',
  "step" "SplititAutomationStep" NOT NULL DEFAULT 'QUEUED',
  "approvedBySlackUserId" TEXT,
  "lastMessage" TEXT,
  "lastResponse" TEXT,
  "error" TEXT,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "nextRunAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "startedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "SplititAutomationJob_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SplititAutomationJob_requestId_key" ON "SplititAutomationJob"("requestId");
CREATE INDEX "SplititAutomationJob_status_nextRunAt_idx" ON "SplititAutomationJob"("status", "nextRunAt");

ALTER TABLE "SplititAutomationJob"
  ADD CONSTRAINT "SplititAutomationJob_requestId_fkey"
  FOREIGN KEY ("requestId") REFERENCES "Request"("id") ON DELETE CASCADE ON UPDATE CASCADE;
