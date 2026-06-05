CREATE TABLE "WhopWebhookRoute" (
  "id" TEXT NOT NULL,
  "eventType" TEXT NOT NULL,
  "slackChannelId" TEXT NOT NULL,
  "businessId" TEXT,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "WhopWebhookRoute_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "WhopWebhookDelivery" (
  "id" TEXT NOT NULL,
  "webhookId" TEXT,
  "eventType" TEXT NOT NULL,
  "businessId" TEXT,
  "slackChannelId" TEXT,
  "status" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "WhopWebhookDelivery_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "WhopWebhookDelivery_webhookId_key" ON "WhopWebhookDelivery"("webhookId");
CREATE INDEX "WhopWebhookRoute_eventType_enabled_idx" ON "WhopWebhookRoute"("eventType", "enabled");
CREATE INDEX "WhopWebhookRoute_slackChannelId_idx" ON "WhopWebhookRoute"("slackChannelId");
CREATE INDEX "WhopWebhookRoute_businessId_idx" ON "WhopWebhookRoute"("businessId");
CREATE INDEX "WhopWebhookDelivery_eventType_createdAt_idx" ON "WhopWebhookDelivery"("eventType", "createdAt");
CREATE INDEX "WhopWebhookDelivery_businessId_idx" ON "WhopWebhookDelivery"("businessId");

ALTER TABLE "WhopWebhookRoute"
  ADD CONSTRAINT "WhopWebhookRoute_slackChannelId_fkey"
  FOREIGN KEY ("slackChannelId") REFERENCES "Channel"("slackChannelId") ON DELETE CASCADE ON UPDATE CASCADE;
