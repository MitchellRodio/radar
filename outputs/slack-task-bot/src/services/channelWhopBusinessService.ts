import { prisma } from "../lib/prisma";

export async function upsertChannelWhopBusiness(input: {
  slackChannelId: string;
  businessId: string;
  businessName: string;
  apiKey?: string;
}) {
  const apiKey = input.apiKey?.trim();
  return prisma.channelWhopBusiness.upsert({
    where: {
      slackChannelId_businessId: {
        slackChannelId: input.slackChannelId,
        businessId: input.businessId
      }
    },
    update: {
      businessName: input.businessName,
      ...(apiKey ? { apiKey } : {})
    },
    create: {
      slackChannelId: input.slackChannelId,
      businessId: input.businessId,
      businessName: input.businessName,
      apiKey: apiKey ?? ""
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
