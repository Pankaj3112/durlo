import { spawnSync } from "node:child_process";

const docker = process.platform === "win32" ? "docker.exe" : "docker";
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const container = `durlo-test-${process.pid}-${Date.now()}`;
const image = process.env.DURLO_TEST_POSTGRES_IMAGE ?? "postgres:17-alpine";
const testScript = process.argv[2] ?? "test:all";

function command(executable, args, options = {}) {
  return spawnSync(executable, args, {
    encoding: "utf8",
    ...options
  });
}

function requireSuccess(result, description) {
  if (result.status === 0) return result;
  const detail = result.error?.message ?? result.stderr?.trim() ?? `exit code ${result.status}`;
  throw new Error(`${description} failed: ${detail}`);
}

const dockerVersion = command(docker, ["version", "--format", "{{.Server.Version}}"]).status;
if (dockerVersion !== 0) {
  throw new Error("Docker must be running for 'pnpm test:local'");
}

try {
  requireSuccess(
    command(docker, [
      "run",
      "--rm",
      "--detach",
      "--name",
      container,
      "--env",
      "POSTGRES_USER=durlo",
      "--env",
      "POSTGRES_PASSWORD=durlo",
      "--env",
      "POSTGRES_DB=durlo_test",
      "--publish",
      "127.0.0.1::5432",
      image
    ]),
    "starting disposable Postgres"
  );

  const deadline = Date.now() + 30_000;
  let consecutiveReadyChecks = 0;
  while (Date.now() < deadline) {
    const ready = command(docker, [
      "exec",
      container,
      "pg_isready",
      "-U",
      "durlo",
      "-d",
      "durlo_test"
    ]);
    consecutiveReadyChecks = ready.status === 0 ? consecutiveReadyChecks + 1 : 0;
    if (consecutiveReadyChecks >= 2) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  if (consecutiveReadyChecks < 2) {
    const logs = command(docker, ["logs", container]);
    const detail = [logs.stdout, logs.stderr].filter(Boolean).join("\n").trim();
    throw new Error(`disposable Postgres did not become ready${detail ? `:\n${detail}` : ""}`);
  }

  const portResult = requireSuccess(
    command(docker, ["port", container, "5432/tcp"]),
    "discovering disposable Postgres port"
  );
  const port = portResult.stdout.trim().match(/:(\d+)$/)?.[1];
  if (!port) throw new Error(`could not parse Postgres port from '${portResult.stdout.trim()}'`);

  const tests = command(pnpm, [testScript], {
    env: {
      ...process.env,
      DURLO_TEST_DATABASE_URL: `postgres://durlo:durlo@127.0.0.1:${port}/durlo_test`
    },
    stdio: "inherit"
  });
  if (tests.status !== 0) process.exitCode = tests.status ?? 1;
} finally {
  command(docker, ["rm", "--force", container]);
}
