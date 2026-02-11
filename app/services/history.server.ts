import  prisma  from "../db.server";

export async function getHistory() {
  return prisma.history.findMany({
    orderBy: { createdAt: "desc" },
  });
}

export async function addHistoryEntry(data: any) {
  return prisma.history.create({
    data,
  });
}

export async function clearHistory() {
  await prisma.history.deleteMany();
}

export async function deleteHistoryEntry(id: string) {
  await prisma.history.delete({
    where: { id },
  });
}
