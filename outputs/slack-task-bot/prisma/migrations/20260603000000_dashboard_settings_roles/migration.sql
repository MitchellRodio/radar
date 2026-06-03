CREATE TYPE "UserRole" AS ENUM ('ADMIN', 'CSM', 'SALES_REP', 'REQUESTER');

ALTER TABLE "User"
  ADD COLUMN "role" "UserRole" NOT NULL DEFAULT 'REQUESTER';

UPDATE "User"
SET "role" = 'ADMIN'
WHERE "isAdmin" = true;

UPDATE "User"
SET "role" = 'CSM'
WHERE "slackUserId" IN (SELECT "ownerSlackUserId" FROM "ChannelOwnerMapping")
  AND "isAdmin" = false;

CREATE TABLE "ChannelMember" (
  "id" TEXT NOT NULL,
  "slackChannelId" TEXT NOT NULL,
  "slackUserId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "ChannelMember_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AppSetting" (
  "key" TEXT NOT NULL,
  "value" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "AppSetting_pkey" PRIMARY KEY ("key")
);

CREATE UNIQUE INDEX "ChannelMember_slackChannelId_slackUserId_key"
  ON "ChannelMember"("slackChannelId", "slackUserId");

CREATE INDEX "ChannelMember_slackUserId_idx"
  ON "ChannelMember"("slackUserId");

ALTER TABLE "ChannelMember"
  ADD CONSTRAINT "ChannelMember_slackChannelId_fkey"
  FOREIGN KEY ("slackChannelId") REFERENCES "Channel"("slackChannelId")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ChannelMember"
  ADD CONSTRAINT "ChannelMember_slackUserId_fkey"
  FOREIGN KEY ("slackUserId") REFERENCES "User"("slackUserId")
  ON DELETE CASCADE ON UPDATE CASCADE;
