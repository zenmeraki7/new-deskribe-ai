import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const plans = [
  { name: "free", creditLimit: 100 },
  { name: "basic", creditLimit: 2000 },
  { name: "standard", creditLimit: 10000 },
  { name: "pro", creditLimit: 25000 },
] as const;

async function main() {
  for (const plan of plans) {
    await prisma.plan.upsert({
      where: { name: plan.name },
      create: plan,
      update: { creditLimit: plan.creditLimit },
    });
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
