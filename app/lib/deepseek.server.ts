// // FILE: app/lib/deepseek.server.ts

// import { z } from "zod";

// const KeywordSchema = z.array(z.string().min(1)).max(40);

// export async function suggestKeywords(
//   title: string,
//   vendor: string,
//   productType: string,
//   tags: string[],
// ): Promise<string[]> {
//   // TODO: replace with real DeepSeek call
//   // This is safe deterministic fallback for now

//   const synthetic = [
//     title,
//     vendor,
//     productType,
//     ...tags.slice(0, 5),
//   ]
//     .filter(Boolean)
//     .map((s) => s.toLowerCase())
//     .slice(0, 10);

//   const parsed = KeywordSchema.safeParse(synthetic);

//   if (!parsed.success) {
//     throw new Error("Invalid keyword output");
//   }

//   return parsed.data;
// }
