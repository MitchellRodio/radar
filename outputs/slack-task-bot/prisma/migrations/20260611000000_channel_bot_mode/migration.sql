CREATE TYPE "ChannelBotMode" AS ENUM ('FULL', 'KYC_ONLY');

ALTER TABLE "Channel"
  ADD COLUMN "botMode" "ChannelBotMode" NOT NULL DEFAULT 'FULL';
