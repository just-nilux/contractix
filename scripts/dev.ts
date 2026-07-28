/**
 * Runs the whole local stack: API, ingestion worker, and web.
 *
 * The worker is not optional. Uploads enqueue a BullMQ ingest job, and without
 * a worker consuming it a document sits in `uploaded` forever - which reads as
 * "the app is broken" rather than "you forgot a process". One command, three
 * processes, prefixed output.
 *
 * Postgres and Redis are still yours to start: `pnpm compose:up`.
 */
import { type ChildProcess, spawn } from "node:child_process";
import path from "node:path";
import readline from "node:readline";

const ROOT = path.resolve(import.meta.dirname, "..");
const RESET = "\u001b[0m";

interface Service {
  name: string;
  color: string;
  args: string[];
}

const SERVICES: Service[] = [
  { name: "api   ", color: "\u001b[36m", args: ["--filter", "@contractix/api", "dev"] },
  { name: "worker", color: "\u001b[35m", args: ["--filter", "@contractix/api", "dev:worker"] },
  { name: "web   ", color: "\u001b[32m", args: ["--filter", "@contractix/web", "dev"] },
];

const children: ChildProcess[] = [];
let shuttingDown = false;

function shutdown(code: number): void {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) child.kill("SIGTERM");
  // Give tsx watch a moment to tear its own children down before we go.
  setTimeout(() => process.exit(code), 500);
}

for (const service of SERVICES) {
  const child = spawn("pnpm", service.args, {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, FORCE_COLOR: "1" },
  });
  children.push(child);

  const prefix = `${service.color}${service.name}${RESET} │ `;
  for (const stream of [child.stdout, child.stderr]) {
    if (!stream) continue;
    readline.createInterface({ input: stream }).on("line", (line) => {
      process.stdout.write(`${prefix}${line}\n`);
    });
  }

  // One process dying leaves a half-stack that silently misbehaves; take the
  // whole thing down so the failure is the thing you see.
  child.on("exit", (code, signal) => {
    if (shuttingDown) return;
    process.stdout.write(`${prefix}exited (${signal ?? code}) - stopping the rest\n`);
    shutdown(code ?? 1);
  });
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    shutdown(0);
  });
}
