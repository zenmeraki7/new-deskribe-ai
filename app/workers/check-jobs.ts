import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const jobs = await prisma.generationJob.findMany({
    orderBy: { createdAt: "desc" },
    take: 5,
    select: {
      id: true,
      status: true,
      productId: true,
      productTitle: true,
      errorMessage: true,
      createdAt: true,
      bullJobId: true,
      shopDomain: true,
    }
  });

  console.log("LAST 5 JOBS:");
  console.log(JSON.stringify(jobs, null, 2));
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
