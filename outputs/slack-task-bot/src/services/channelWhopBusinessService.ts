import { prisma } from "../lib/prisma";

export async function upsertChannelWhopBusiness(input: {
  slackChannelId: string;
  businessId: string;
  businessName: string;
}) {
  return prisma.channelWhopBusiness.upsert({
    where: {
      slackChannelId_businessId: {
        slackChannelId: input.slackChannelId,
        businessId: input.businessId
      }
    },
    update: { businessName: input.businessName },
    create: {
      slackChannelId: input.slackChannelId,
      businessId: input.businessId,
      businessName: input.businessName
    }
  });
}

export async function deleteChannelWhopBusiness(id: string) {
  return prisma.channelWhopBusiness.deleteMany({ where: { id } });
}

export async function listChannelWhopBusinesses(slackChannelId: string) {
  return prisma.channelWhopBusiness.findMany({
    where: { slackChannelId },
    orderBy: [{ businessName: "asc" }, { businessId: "asc" }]
  });
}
