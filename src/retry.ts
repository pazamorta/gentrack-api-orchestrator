/**
 * Retry logic with exponential backoff and configurable policies.
 */

export interface RetryPolicy {
  /** Max number of retry attempts (0 = no retries) */
  maxRetries: number;
  /** Initial delay in ms before first retry */
  initialDelayMs: number;
  /** Multiplier for exponential backoff */
  backoffMultiplier: number;
  /** Maximum delay between retries */
  maxDelayMs: number;
  /** HTTP status codes that should trigger a retry */
  retryableStatusCodes: number[];
  /** Whether to retry on network/timeout errors */
  retryOnNetworkError: boolean;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxRetries: 3,
  initialDelayMs: 500,
  backoffMultiplier: 2,
  maxDelayMs: 10_000,
  retryableStatusCodes: [408, 429, 500, 502, 503, 504],
  retryOnNetworkError: true,
};

export interface RetryResult<T> {
  success: boolean;
  result?: T;
  error?: Error;
  attempts: number;
  totalDurationMs: number;
}

/**
 * Execute a function with retry logic.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  policy: Partial<RetryPolicy> = {},
  isRetryable?: (error: unknown) => boolean
): Promise<RetryResult<T>> {
  const config: RetryPolicy = { ...DEFAULT_RETRY_POLICY, ...policy };
  const startTime = Date.now();
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
    try {
      const result = await fn();
      return {
        success: true,
        result,
        attempts: attempt + 1,
        totalDurationMs: Date.now() - startTime,
      };
    } catch (error: unknown) {
      lastError = error instanceof Error ? error : new Error(String(error));

      // Check if we should retry
      const shouldRetry = attempt < config.maxRetries && shouldRetryError(error, config, isRetryable);

      if (!shouldRetry) {
        break;
      }

      // Calculate delay with exponential backoff + jitter
      const baseDelay = config.initialDelayMs * Math.pow(config.backoffMultiplier, attempt);
      const jitter = Math.random() * baseDelay * 0.1; // 10% jitter
      const delay = Math.min(baseDelay + jitter, config.maxDelayMs);

      console.log(
        `[retry] Attempt ${attempt + 1} failed, retrying in ${Math.round(delay)}ms... (${lastError.message})`
      );

      await sleep(delay);
    }
  }

  return {
    success: false,
    error: lastError,
    attempts: config.maxRetries + 1,
    totalDurationMs: Date.now() - startTime,
  };
}

function shouldRetryError(
  error: unknown,
  config: RetryPolicy,
  customCheck?: (error: unknown) => boolean
): boolean {
  // Custom retry check takes priority
  if (customCheck) {
    return customCheck(error);
  }

  // Check for network/timeout errors
  if (isNetworkError(error)) {
    return config.retryOnNetworkError;
  }

  // Check for retryable HTTP status codes
  const statusCode = extractStatusCode(error);
  if (statusCode !== null) {
    return config.retryableStatusCodes.includes(statusCode);
  }

  return false;
}

function isNetworkError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const networkCodes = ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN'];
  const axiosError = error as { code?: string; message?: string };
  if (axiosError.code && networkCodes.includes(axiosError.code)) return true;
  if (axiosError.message?.includes('timeout')) return true;
  return false;
}

function extractStatusCode(error: unknown): number | null {
  const axiosError = error as { response?: { status?: number } };
  return axiosError.response?.status ?? null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
