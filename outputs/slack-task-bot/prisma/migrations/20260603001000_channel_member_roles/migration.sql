ALTER TABLE "ChannelMember" ADD COLUMN "role" "UserRole" NOT NULL DEFAULT 'REQUESTER';

UPDATE "ChannelMember"
SET "role" = 'CSM'
FROM "ChannelOwnerMapping"
WHERE "ChannelMember"."slackChannelId" = "ChannelOwnerMapping"."slackChannelId"
  AND "ChannelMember"."slackUserId" = "ChannelOwnerMapping"."ownerSlackUserId";
