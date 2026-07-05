import "dotenv/config";

const required = [
  "DATABASE_URL",
  "SHOPIFY_API_KEY",
  "SHOPIFY_API_SECRET",
  "SHOPIFY_APP_URL",
  "SCOPES",
];

const missing = required.filter((name) => !process.env[name]?.trim());

if (missing.length > 0) {
  console.error("\nMissing required environment variables:");
  for (const name of missing) {
    console.error(`- ${name}`);
  }
  console.error(
    "\nFill these in your .env file. DATABASE_URL must be a PostgreSQL connection string.",
  );
  process.exit(1);
}
