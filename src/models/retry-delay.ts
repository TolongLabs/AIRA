/** Delay before a retryable provider request. The caller owns the deadline. */
export function retryDelayMs(retry: number): number {
  return Math.min(4_000, 250 * 2 ** retry)
}
