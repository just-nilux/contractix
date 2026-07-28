import { QueryClient } from "@tanstack/react-query";

import { NotFoundError, RateLimitError, ResponseShapeError, SessionError } from "./errors.js";

/**
 * One client for the app.
 *
 * The retry predicate is the reason this is React Query rather than hand-rolled
 * hooks: "never retry a 401 or a 429" has to hold everywhere, and here it is
 * three lines in one place. Retrying a 429 would spend the budget that produced
 * it; retrying a 401 cannot succeed, because only two routes mint a session.
 * A 404 is frequently a *state* here (no narrative generated yet), and a schema
 * mismatch will mismatch identically the second time.
 *
 * `refetchOnWindowFocus` is off because every read is either immutable (a
 * content-addressed layout) or already pushed by the progress stream.
 */
export function isTerminalError(error: unknown): boolean {
  return (
    error instanceof SessionError ||
    error instanceof RateLimitError ||
    error instanceof NotFoundError ||
    error instanceof ResponseShapeError
  );
}

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (failureCount, error) => failureCount < 2 && !isTerminalError(error),
      staleTime: 30_000,
      refetchOnWindowFocus: false,
    },
    mutations: {
      retry: false,
    },
  },
});
