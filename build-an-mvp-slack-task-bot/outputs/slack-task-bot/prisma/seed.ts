import { PrismaClient, RequestType } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const admin = await prisma.user.upsert({
    where: { slackUserId: "U123ADMIN" },
    update: { isAdmin: true, name: "Example Admin CSM" },
    create: {
      slackUserId: "U123ADMIN",
      name: "Example Admin CSM",
      isAdmin: true
    }
  });

  const csm = await prisma.user.upsert({
    where: { slackUserId: "U234CSM" },
    update: { name: "Example CSM" },
    create: {
      slackUserId: "U234CSM",
      name: "Example CSM"
    }
  });

  const requester = await prisma.user.upsert({
    where: { slackUserId: "U345CUSTOMER" },
    update: { name: "Example Customer" },
    create: {
      slackUserId: "U345CUSTOMER",
      name: "Example Customer"
    }
  });

  await prisma.channel.upsert({
    where: { slackChannelId: "C123CUSTOMER" },
    update: { name: "acme-customer", companyName: "Acme Co" },
    create: {
      slackChannelId: "C123CUSTOMER",
      name: "acme-customer",
      companyName: "Acme Co"
    }
  });

  await prisma.channelOwnerMapping.upsert({
    where: { slackChannelId: "C123CUSTOMER" },
    update: { ownerSlackUserId: csm.slackUserId },
    create: {
      slackChannelId: "C123CUSTOMER",
      ownerSlackUserId: csm.slackUserId
    }
  });

  const existing = await prisma.request.findFirst({
    where: { channelId: "C123CUSTOMER", messageTs: "1717090000.000000" }
  });

  if (!existing) {
    await prisma.request.create({
      data: {
        title: "Checkout link for $10,000 Splitit",
        description: "I need a checkout link for $10,000 Splitit",
        type: RequestType.CHECKOUT_LINK,
        requesterSlackUserId: requester.slackUserId,
        ownerSlackUserId: csm.slackUserId,
        channelId: "C123CUSTOMER",
        threadTs: "1717090000.000000",
        messageTs: "1717090000.000000",
        updates: {
          create: {
            actorSlackUserId: admin.slackUserId,
            kind: "CREATED",
            message: "Seed request created"
          }
        }
      }
    });
  }
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
