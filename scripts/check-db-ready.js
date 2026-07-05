import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const requiredTables = [
  "Session",
  "History",
  "GenerationJob",
  "ShopCredit",
  "CreditTransaction",
];

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

try {
  const rows = await prisma.$queryRaw`
    select table_name
    from information_schema.tables
    where table_schema = 'public'
  `;
  const tables = new Set(rows.map((row) => row.table_name));
  const missing = requiredTables.filter((table) => !tables.has(table));

  if (missing.length > 0) {
    console.error("\nDatabase is reachable, but required tables are missing:");
    for (const table of missing) {
      console.error(`- ${table}`);
    }
    console.error(
      "\nApply the Prisma migrations to this database before starting the app.",
    );
    process.exit(1);
  }
} catch (error) {
  console.error("\nCould not connect to the database.");
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
} finally {
  await prisma.$disconnect();
}
