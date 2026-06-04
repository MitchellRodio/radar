CREATE TABLE "ChannelWhopBusiness" (
  "id" TEXT NOT NULL,
  "slackChannelId" TEXT NOT NULL,
  "businessId" TEXT NOT NULL,
  "businessName" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "ChannelWhopBusiness_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ChannelWhopBusiness_slackChannelId_businessId_key" ON "ChannelWhopBusiness"("slackChannelId", "businessId");
CREATE INDEX "ChannelWhopBusiness_businessId_idx" ON "ChannelWhopBusiness"("businessId");

ALTER TABLE "ChannelWhopBusiness"
  ADD CONSTRAINT "ChannelWhopBusiness_slackChannelId_fkey"
  FOREIGN KEY ("slackChannelId") REFERENCES "Channel"("slackChannelId") ON DELETE CASCADE ON UPDATE CASCADE;
