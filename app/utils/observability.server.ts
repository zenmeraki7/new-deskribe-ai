type LogLevel = "info" | "warn" | "error";

export type OperationLogContext = {
  operation: string;
  shop?: string | null;
  jobId?: string | null;
  bulkId?: string | null;
  requestId?: string | null;
  productId?: string | null;
  durationMs?: number;
  status?: string;
  error?: unknown;
  [key: string]: unknown;
};

export function durationSince(startedAt: number) {
  return Math.max(0, Date.now() - startedAt);
}

function serializeError(error: unknown) {
  if (!error) return undefined;
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  }
  return { message: String(error) };
}

function write(level: LogLevel, message: string, context: OperationLogContext) {
  const payload = {
    level,
    message,
    timestamp: new Date().toISOString(),
    ...context,
    error: serializeError(context.error),
  };

  if (level === "error") {
    console.error(JSON.stringify(payload));
    return;
  }

  if (level === "warn") {
    console.warn(JSON.stringify(payload));
    return;
  }

  console.log(JSON.stringify(payload));
}

export const appLog = {
  info(message: string, context: OperationLogContext) {
    write("info", message, context);
  },
  warn(message: string, context: OperationLogContext) {
    write("warn", message, context);
  },
  error(message: string, context: OperationLogContext) {
    write("error", message, context);
  },
};
