import { QueryClient } from "@tanstack/react-query";

/**
 * One client for the app.
 *
 * `refetchOnWindowFocus` is off because every read here is either immutable
 * (a content-addressed layout) or already pushed by the progress stream, so a
 * refetch on tab focus would be pure noise. The retry predicate lands with the
 * typed API errors - a 401 or a 429 must never be retried.
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: false,
    },
  },
});
