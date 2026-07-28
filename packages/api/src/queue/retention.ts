import { Queue } from "bullmq";
import { type Redis } from "ioredis";

export const RETENTION_QUEUE = "retention";

/** No payload: the job is "sweep whatever has expired by now". */
export type RetentionJobData = Record<string, never>;

export function createRetentionQueue(connection: Redis) {
  return new Queue<RetentionJobData>(RETENTION_QUEUE, {
    connection,
    defaultJobOptions: {
      // A missed sweep is picked up by the next one, so retrying a failed run
      // buys nothing over waiting an hour.
      attempts: 1,
      removeOnComplete: { count: 48 },
      removeOnFail: { count: 48 },
    },
  });
}

export type RetentionQueue = ReturnType<typeof createRetentionQueue>;

/**
 * Hourly rather than nightly: sessions expire 24 h after they are minted, at
 * whatever time of day that was, so a nightly job would leave some sessions
 * alive for up to 24 h past their expiry. The repeat key is stable, so
 * restarting the worker re-registers rather than accumulating schedulers.
 */
export async function scheduleRetentionSweep(queue: RetentionQueue): Promise<void> {
  await queue.upsertJobScheduler("retention-hourly", { pattern: "0 * * * *" }, { name: "purge" });
}
