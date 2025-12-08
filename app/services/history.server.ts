

interface HistoryEntry {
  id: string;
  productId: string;
  productTitle: string;
  description: string;
  vibe: string;
  format: string;
  keywords?: string;
  includeSocials: boolean;
  socials?: {
    twitter?: string;
    instagram?: string;
  };
  createdAt: string;
}

// In-memory storage (replace with database later)
let historyStore: HistoryEntry[] = [];

export async function getHistory(): Promise<HistoryEntry[]> {
  // Sort by most recent first
  return historyStore.sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );
}

export async function addHistoryEntry(entry: Omit<HistoryEntry, "id" | "createdAt">): Promise<HistoryEntry> {
  const newEntry: HistoryEntry = {
    ...entry,
    id: `hist_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
    createdAt: new Date().toISOString(),
  };

  historyStore.push(newEntry);
  
  // Keep only last 50 entries to prevent memory issues
  if (historyStore.length > 50) {
    historyStore = historyStore.slice(-50);
  }

  return newEntry;
}

export async function clearHistory(): Promise<void> {
  historyStore = [];
}

export async function deleteHistoryEntry(id: string): Promise<boolean> {
  const initialLength = historyStore.length;
  historyStore = historyStore.filter(entry => entry.id !== id);
  return historyStore.length < initialLength;
}
