CREATE TABLE "RequestAttachment" (
  "id" TEXT NOT NULL,
  "requestId" INTEGER NOT NULL,
  "slackFileId" TEXT NOT NULL,
  "name" TEXT,
  "mimetype" TEXT,
  "filetype" TEXT,
  "urlPrivate" TEXT,
  "permalink" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "RequestAttachment_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "RequestAttachment_requestId_slackFileId_key" ON "RequestAttachment"("requestId", "slackFileId");
CREATE INDEX "RequestAttachment_slackFileId_idx" ON "RequestAttachment"("slackFileId");

ALTER TABLE "RequestAttachment"
  ADD CONSTRAINT "RequestAttachment_requestId_fkey"
  FOREIGN KEY ("requestId") REFERENCES "Request"("id") ON DELETE CASCADE ON UPDATE CASCADE;
