import type {
  BackoffPolicy,
  NormalizedBackoffPolicy,
  NormalizedRetryPolicy,
  RetryPolicy
} from "./types.js";
import { parseDuration, validateBackoff } from "./validation.js";

export const DEFAULT_RETRY_POLICY: NormalizedRetryPolicy = {
  attempts: 3,
  backoff: { type: "exponential", delay: 10_000, factor: 2, jitter: 0.2 }
};

export function normalizeBackoff(
  policy: BackoffPolicy | undefined,
  fallback: NormalizedBackoffPolicy = DEFAULT_RETRY_POLICY.backoff
): NormalizedBackoffPolicy {
  if (!policy) return { ...fallback };
  validateBackoff(policy);
  if (policy.type === "fixed") {
    return { type: "fixed", delay: parseDuration(policy.delay), jitter: policy.jitter ?? 0 };
  }
  return {
    type: "exponential",
    delay: parseDuration(policy.delay),
    factor: policy.factor ?? 2,
    ...(policy.maxDelay === undefined ? {} : { maxDelay: parseDuration(policy.maxDelay) }),
    jitter: policy.jitter ?? 0
  };
}

export function normalizeRetryPolicy(
  policy: RetryPolicy | undefined,
  fallback: NormalizedRetryPolicy = DEFAULT_RETRY_POLICY
): NormalizedRetryPolicy {
  const attempts = policy?.attempts ?? fallback.attempts;
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 100) {
    throw new Error("attempts must be an integer from 1 to 100");
  }
  return { attempts, backoff: normalizeBackoff(policy?.backoff, fallback.backoff) };
}

export function calculateRetryDelay(
  backoff: NormalizedBackoffPolicy,
  attemptNumber: number,
  random: () => number = Math.random
): number {
  const base =
    backoff.type === "fixed"
      ? backoff.delay
      : Math.min(
          backoff.delay * backoff.factor ** Math.max(0, attemptNumber - 1),
          backoff.maxDelay ?? Infinity
        );
  const spread = base * backoff.jitter;
  return Math.max(0, Math.round(base - spread + random() * spread * 2));
}
