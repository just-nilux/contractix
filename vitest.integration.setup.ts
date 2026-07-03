// Integration tests expect the docker-compose stack (postgres + redis).
// Local dev: `pnpm compose:up` first. CI provides service containers.
process.env.DATABASE_URL ??= "postgres://contractix:contractix@localhost:5432/contractix";
process.env.REDIS_URL ??= "redis://localhost:6379";
process.env.NODE_ENV ??= "test";
