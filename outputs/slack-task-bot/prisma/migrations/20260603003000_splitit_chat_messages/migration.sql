CREATE TYPE "SplititMessageSender" AS ENUM ('AGENT', 'SPLITIT', 'CSM', 'SYSTEM');

CREATE TABLE "SplititAutomationMessage" (
  "id" TEXT NOT NULL,
  "jobId" TEXT NOT NULL,
  "sender" "SplititMessageSender" NOT NULL,
  "body" TEXT NOT NULL,
  "createdBySlackUserId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "SplititAutomationMessage_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "SplititAutomationMessage_jobId_createdAt_idx" ON "SplititAutomationMessage"("jobId", "createdAt");

ALTER TABLE "SplititAutomationMessage"
  ADD CONSTRAINT "SplititAutomationMessage_jobId_fkey"
  FOREIGN KEY ("jobId") REFERENCES "SplititAutomationJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;
