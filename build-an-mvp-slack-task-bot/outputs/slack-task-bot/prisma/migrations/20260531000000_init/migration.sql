CREATE TYPE "RequestType" AS ENUM (
  'CHECKOUT_LINK',
  'SPLITIT_WHITELIST',
  'REFUND_PAYMENT',
  'BUG_REPORT',
  'ENHANCEMENT_REQUEST',
  'KYC_KYB',
  'PAYMENT_ISSUE',
  'ACCOUNT_SETTINGS',
  'OTHER'
);

CREATE TYPE "RequestStatus" AS ENUM ('SUBMITTED', 'IN_PROGRESS', 'DONE', 'CUSTOM');

CREATE TYPE "RequestUpdateKind" AS ENUM (
  'CREATED',
  'STATUS_CHANGED',
  'DUE_DATE_CHANGED',
  'BLOCKER_CHANGED',
  'NOTE_ADDED',
  'REASSIGNED',
  'REQUESTER_NOTIFIED'
);

CREATE TABLE "User" (
  "id" TEXT NOT NULL,
  "slackUserId" TEXT NOT NULL,
  "name" TEXT,
  "isAdmin" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Channel" (
  "id" TEXT NOT NULL,
  "slackChannelId" TEXT NOT NULL,
  "name" TEXT,
  "companyName" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Channel_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ChannelOwnerMapping" (
  "id" TEXT NOT NULL,
  "slackChannelId" TEXT NOT NULL,
  "ownerSlackUserId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ChannelOwnerMapping_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Request" (
  "id" SERIAL NOT NULL,
  "title" TEXT NOT NULL,
  "description" TEXT NOT NULL,
  "type" "RequestType" NOT NULL DEFAULT 'OTHER',
  "status" "RequestStatus" NOT NULL DEFAULT 'SUBMITTED',
  "customStatus" TEXT,
  "requesterSlackUserId" TEXT NOT NULL,
  "ownerSlackUserId" TEXT NOT NULL,
  "channelId" TEXT NOT NULL,
  "threadTs" TEXT NOT NULL,
  "messageTs" TEXT NOT NULL,
  "dueDate" TIMESTAMP(3),
  "blocker" TEXT,
  "lastReminderSentAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Request_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "InternalNote" (
  "id" TEXT NOT NULL,
  "requestId" INTEGER NOT NULL,
  "authorSlackUserId" TEXT NOT NULL,
  "body" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "InternalNote_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "RequestUpdate" (
  "id" TEXT NOT NULL,
  "requestId" INTEGER NOT NULL,
  "actorSlackUserId" TEXT,
  "kind" "RequestUpdateKind" NOT NULL,
  "message" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "RequestUpdate_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "User_slackUserId_key" ON "User"("slackUserId");
CREATE UNIQUE INDEX "Channel_slackChannelId_key" ON "Channel"("slackChannelId");
CREATE UNIQUE INDEX "ChannelOwnerMapping_slackChannelId_key" ON "ChannelOwnerMapping"("slackChannelId");
CREATE INDEX "Request_ownerSlackUserId_status_idx" ON "Request"("ownerSlackUserId", "status");
CREATE INDEX "Request_channelId_idx" ON "Request"("channelId");
CREATE INDEX "Request_dueDate_idx" ON "Request"("dueDate");

ALTER TABLE "ChannelOwnerMapping"
  ADD CONSTRAINT "ChannelOwnerMapping_slackChannelId_fkey"
  FOREIGN KEY ("slackChannelId") REFERENCES "Channel"("slackChannelId") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ChannelOwnerMapping"
  ADD CONSTRAINT "ChannelOwnerMapping_ownerSlackUserId_fkey"
  FOREIGN KEY ("ownerSlackUserId") REFERENCES "User"("slackUserId") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Request"
  ADD CONSTRAINT "Request_requesterSlackUserId_fkey"
  FOREIGN KEY ("requesterSlackUserId") REFERENCES "User"("slackUserId") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Request"
  ADD CONSTRAINT "Request_ownerSlackUserId_fkey"
  FOREIGN KEY ("ownerSlackUserId") REFERENCES "User"("slackUserId") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Request"
  ADD CONSTRAINT "Request_channelId_fkey"
  FOREIGN KEY ("channelId") REFERENCES "Channel"("slackChannelId") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "InternalNote"
  ADD CONSTRAINT "InternalNote_requestId_fkey"
  FOREIGN KEY ("requestId") REFERENCES "Request"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "InternalNote"
  ADD CONSTRAINT "InternalNote_authorSlackUserId_fkey"
  FOREIGN KEY ("authorSlackUserId") REFERENCES "User"("slackUserId") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "RequestUpdate"
  ADD CONSTRAINT "RequestUpdate_requestId_fkey"
  FOREIGN KEY ("requestId") REFERENCES "Request"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "RequestUpdate"
  ADD CONSTRAINT "RequestUpdate_actorSlackUserId_fkey"
  FOREIGN KEY ("actorSlackUserId") REFERENCES "User"("slackUserId") ON DELETE SET NULL ON UPDATE CASCADE;
