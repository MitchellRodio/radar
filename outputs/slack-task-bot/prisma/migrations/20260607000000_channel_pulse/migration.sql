CREATE TABLE "SlackMessageInsight" (
  "id" TEXT NOT NULL,
  "slackChannelId" TEXT NOT NULL,
  "slackUserId" TEXT,
  "messageTs" TEXT NOT NULL,
  "threadTs" TEXT,
  "text" TEXT NOT NULL,
  "businessIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "riskScore" INTEGER NOT NULL DEFAULT 0,
  "churnRisk" TEXT NOT NULL DEFAULT 'LOW',
  "sentiment" TEXT NOT NULL DEFAULT 'NEUTRAL',
  "blockerType" TEXT,
  "blockerSummary" TEXT NOT NULL DEFAULT '',
  "dissatisfactionSignals" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "aiTags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "suggestedCsmAction" TEXT NOT NULL DEFAULT '',
  "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "needsAttention" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "SlackMessageInsight_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ChannelPulse" (
  "id" TEXT NOT NULL,
  "slackChannelId" TEXT NOT NULL,
  "riskScore" INTEGER NOT NULL DEFAULT 0,
  "churnRisk" TEXT NOT NULL DEFAULT 'LOW',
  "sentiment" TEXT NOT NULL DEFAULT 'NEUTRAL',
  "blockerSummary" TEXT NOT NULL DEFAULT '',
  "unhappySummary" TEXT NOT NULL DEFAULT '',
  "suggestedCsmAction" TEXT NOT NULL DEFAULT '',
  "openBlockers" JSONB NOT NULL DEFAULT '[]',
  "topSignals" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "lastMessageAt" TIMESTAMP(3),
  "lastAnalyzedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "ChannelPulse_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ChannelPulseNote" (
  "id" TEXT NOT NULL,
  "slackChannelId" TEXT NOT NULL,
  "authorSlackUserId" TEXT NOT NULL,
  "body" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ChannelPulseNote_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SlackMessageInsight_slackChannelId_messageTs_key" ON "SlackMessageInsight"("slackChannelId", "messageTs");
CREATE INDEX "SlackMessageInsight_slackChannelId_createdAt_idx" ON "SlackMessageInsight"("slackChannelId", "createdAt");
CREATE INDEX "SlackMessageInsight_riskScore_idx" ON "SlackMessageInsight"("riskScore");
CREATE INDEX "SlackMessageInsight_needsAttention_idx" ON "SlackMessageInsight"("needsAttention");
CREATE UNIQUE INDEX "ChannelPulse_slackChannelId_key" ON "ChannelPulse"("slackChannelId");
CREATE INDEX "ChannelPulseNote_slackChannelId_createdAt_idx" ON "ChannelPulseNote"("slackChannelId", "createdAt");

ALTER TABLE "SlackMessageInsight"
  ADD CONSTRAINT "SlackMessageInsight_slackChannelId_fkey"
  FOREIGN KEY ("slackChannelId") REFERENCES "Channel"("slackChannelId") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ChannelPulse"
  ADD CONSTRAINT "ChannelPulse_slackChannelId_fkey"
  FOREIGN KEY ("slackChannelId") REFERENCES "Channel"("slackChannelId") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ChannelPulseNote"
  ADD CONSTRAINT "ChannelPulseNote_slackChannelId_fkey"
  FOREIGN KEY ("slackChannelId") REFERENCES "Channel"("slackChannelId") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ChannelPulseNote"
  ADD CONSTRAINT "ChannelPulseNote_authorSlackUserId_fkey"
  FOREIGN KEY ("authorSlackUserId") REFERENCES "User"("slackUserId") ON DELETE RESTRICT ON UPDATE CASCADE;
