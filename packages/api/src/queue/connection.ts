import { Redis } from "ioredis";

/** BullMQ requires maxRetriesPerRequest: null on shared connections. */
export function createRedis(url: string): Redis {
  return new Redis(url, { maxRetriesPerRequest: null });
}

/**
 * An evicting Redis silently destroys BullMQ job state under memory pressure.
 * Compose pins --maxmemory-policy noeviction; this assert catches every other
 * environment (CI service containers, a future managed Redis) at boot.
 */
export async function assertNoEviction(redis: Redis): Promise<void> {
  const reply = (await redis.config("GET", "maxmemory-policy")) as string[];
  const policy = reply[1];
  if (policy !== "noeviction") {
    throw new Error(
      `redis maxmemory-policy is '${policy ?? "unknown"}' but BullMQ requires 'noeviction'`,
    );
  }
}
