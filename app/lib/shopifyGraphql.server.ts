const SHOPIFY_GQL_RETRY = {
  MAX_ATTEMPTS: 3,
  BASE_DELAY_MS: 500,
  MAX_DELAY_MS: 60_000,
  THROTTLE_BUFFER_COST: 5,
} as const;

export type AdminGraphql = (
  query: string,
  opts?: { variables?: Record<string, unknown> },
) => Promise<Response>;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function jitter(ms: number) {
  const ratio = 0.2;
  const delta = ms * ratio;
  return Math.max(0, Math.floor(ms + (Math.random() * 2 - 1) * delta));
}

function retryAfterDelayMs(response: Response, fallbackMs: number) {
  const header = response.headers.get("retry-after");
  const seconds = header ? Number(header) : NaN;

  if (Number.isFinite(seconds) && seconds > 0) {
    return Math.min(SHOPIFY_GQL_RETRY.MAX_DELAY_MS, Math.ceil(seconds * 1000));
  }

  return Math.min(fallbackMs, SHOPIFY_GQL_RETRY.MAX_DELAY_MS);
}

function isRetryableHttpStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

function costMetadata(payload: any) {
  return payload?.extensions?.cost;
}

function costNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isThrottleError(payload: any): boolean {
  const errors = payload?.errors;
  if (Array.isArray(errors) && errors.length > 0) {
    for (const error of errors) {
      const message = String(error?.message ?? "").toLowerCase();
      const code = String(error?.extensions?.code ?? "").toLowerCase();
      if (
        code === "throttled" ||
        code === "throttle_exceeded" ||
        message.includes("throttle") ||
        message.includes("throttled")
      ) {
        return true;
      }
    }
  }

  const throttleStatus = costMetadata(payload)?.throttleStatus;
  const currentlyAvailable = costNumber(throttleStatus?.currentlyAvailable);
  const maximumAvailable = costNumber(throttleStatus?.maximumAvailable);

  if (currentlyAvailable !== null && currentlyAvailable <= 0) return true;

  if (
    currentlyAvailable !== null &&
    maximumAvailable !== null &&
    maximumAvailable > 0
  ) {
    return currentlyAvailable / maximumAvailable < 0.05;
  }

  return false;
}

function throttleDelayMs(payload: any, fallbackMs: number): number {
  const cost = costMetadata(payload);
  const throttleStatus = cost?.throttleStatus;
  const currentlyAvailable = costNumber(throttleStatus?.currentlyAvailable);
  const maximumAvailable = costNumber(throttleStatus?.maximumAvailable);
  const restoreRate = costNumber(throttleStatus?.restoreRate);
  const requestedQueryCost = costNumber(cost?.requestedQueryCost);
  const actualQueryCost = costNumber(cost?.actualQueryCost);
  const queryCost = requestedQueryCost ?? actualQueryCost;

  if (
    currentlyAvailable !== null &&
    restoreRate !== null &&
    restoreRate > 0 &&
    queryCost !== null
  ) {
    const desiredAvailable = Math.min(
      maximumAvailable ?? queryCost,
      queryCost + SHOPIFY_GQL_RETRY.THROTTLE_BUFFER_COST,
    );
    const deficit = Math.max(0, desiredAvailable - currentlyAvailable);
    if (deficit > 0) {
      return Math.min(
        SHOPIFY_GQL_RETRY.MAX_DELAY_MS,
        Math.ceil((deficit / throttleStatus.restoreRate) * 1000),
      );
    }
  }

  return Math.min(fallbackMs, SHOPIFY_GQL_RETRY.MAX_DELAY_MS);
}

async function paceFromCostMetadata(payload: any) {
  const cost = costMetadata(payload);
  if (!cost?.throttleStatus) return;

  const currentlyAvailable = costNumber(cost.throttleStatus.currentlyAvailable);
  const requestedQueryCost = costNumber(cost.requestedQueryCost);
  const actualQueryCost = costNumber(cost.actualQueryCost);
  const queryCost = requestedQueryCost ?? actualQueryCost;

  if (currentlyAvailable === null || queryCost === null) return;
  if (currentlyAvailable >= queryCost) return;

  await sleep(
    jitter(throttleDelayMs(payload, SHOPIFY_GQL_RETRY.BASE_DELAY_MS)),
  );
}

export async function adminGraphqlWithRetry<T>(
  adminGraphql: AdminGraphql,
  query: string,
  variables: Record<string, unknown>,
): Promise<T> {
  let attempt = 0;
  let delay = SHOPIFY_GQL_RETRY.BASE_DELAY_MS;

  while (attempt < SHOPIFY_GQL_RETRY.MAX_ATTEMPTS) {
    attempt++;

    try {
      const response = await adminGraphql(query, { variables });

      if (
        isRetryableHttpStatus(response.status) &&
        attempt < SHOPIFY_GQL_RETRY.MAX_ATTEMPTS
      ) {
        await sleep(jitter(retryAfterDelayMs(response, delay)));
        delay *= 2;
        continue;
      }

      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new Error(
          `Shopify GraphQL HTTP ${response.status}: ${text.slice(0, 300)}`,
        );
      }

      const payload = await response.json();

      if (
        isThrottleError(payload) &&
        attempt < SHOPIFY_GQL_RETRY.MAX_ATTEMPTS
      ) {
        await sleep(jitter(throttleDelayMs(payload, delay)));
        delay *= 2;
        continue;
      }

      await paceFromCostMetadata(payload);

      return payload as T;
    } catch (error) {
      if (attempt >= SHOPIFY_GQL_RETRY.MAX_ATTEMPTS) throw error;
      await sleep(jitter(Math.min(delay, SHOPIFY_GQL_RETRY.MAX_DELAY_MS)));
      delay *= 2;
    }
  }

  throw new Error("Shopify GraphQL retry attempts exhausted");
}
