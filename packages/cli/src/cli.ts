import { closeConfig, loadConfig } from "./config.js";
import { startDashboard } from "./dashboard.js";
import { initProject } from "./init.js";
import { configuredWorker, runConfiguredWorker } from "./worker.js";
import type { CliIo, DurloConfig, RunCliOptions } from "./types.js";

const HELP = `Durlo — durable tasks and workflows on Postgres

Usage:
  durlo init [--force]
  durlo migrate [--config <path>]
  durlo worker [--config <path>]
  durlo dev [--config <path>] [--host <host>] [--port <port>]

Commands:
  init      Create an explicit durlo.config.ts
  migrate   Apply pending Postgres migrations
  worker    Run the registered tasks and workflows
  dev       Run a worker and the local dashboard

Options:
  -c, --config <path>  Use a specific configuration file
  -h, --help           Show this help
  -v, --version        Show the installed version

Package API:
  defineConfig         The only supported programmatic @durlo/cli export
`;

export const cliPackageName = "@durlo/cli";
export const cliVersion = "0.1.0-alpha.1";

export async function runCli(
  argv: readonly string[],
  options: RunCliOptions = {}
): Promise<number> {
  const io: CliIo = {
    cwd: options.cwd ?? process.cwd(),
    stdout: options.stdout ?? process.stdout,
    stderr: options.stderr ?? process.stderr
  };

  try {
    if (argv.length === 0 || argv[0] === "help" || hasFlag(argv, "--help", "-h")) {
      io.stdout.write(HELP);
      return 0;
    }
    if (hasFlag(argv, "--version", "-v")) {
      io.stdout.write(`${cliVersion}\n`);
      return 0;
    }

    const [command, ...args] = argv;
    if (command === "init") {
      assertOnlyFlags(args, ["--force"]);
      const result = await initProject(io.cwd, args.includes("--force"));
      io.stdout.write(`Created ${result.path}\n`);
      io.stdout.write("Next: set DATABASE_URL, then run 'durlo migrate' and 'durlo dev'.\n");
      return 0;
    }

    if (command === "migrate") {
      const parsed = parseConfigFlag(args);
      const loaded = await loadConfig(io.cwd, parsed.configPath);
      try {
        await migrateConfig(loaded.config);
      } finally {
        await closeConfig(loaded.config);
      }
      io.stdout.write(`Applied Durlo migrations using ${loaded.path}\n`);
      return 0;
    }

    if (command === "worker") {
      const parsed = parseConfigFlag(args);
      const loaded = await loadConfig(io.cwd, parsed.configPath);
      try {
        await runConfiguredWorker(loaded.config, { stdout: io.stdout });
      } finally {
        await closeConfig(loaded.config);
      }
      return 0;
    }

    if (command === "dev") {
      const parsed = parseDevFlags(args);
      const loaded = await loadConfig(io.cwd, parsed.configPath);
      try {
        await migrateConfig(loaded.config);
        const worker = configuredWorker(loaded.config);
        const dashboard = await startDashboard(loaded.config, worker, {
          ...(parsed.host === undefined ? {} : { host: parsed.host }),
          ...(parsed.port === undefined ? {} : { port: parsed.port })
        });
        const stop = (): void => worker.stop();
        process.once("SIGINT", stop);
        process.once("SIGTERM", stop);
        io.stdout.write(`Dashboard ${dashboard.url}\n`);
        io.stdout.write(
          `Worker ${worker.id} registered ${loaded.config.tasks?.length ?? 0} task(s) and ${loaded.config.workflows?.length ?? 0} workflow(s)\n`
        );
        try {
          await worker.start();
        } finally {
          process.off("SIGINT", stop);
          process.off("SIGTERM", stop);
          await dashboard.close();
        }
      } finally {
        await closeConfig(loaded.config);
      }
      return 0;
    }
    throw new Error(`unknown command '${command ?? ""}'; run 'durlo --help'`);
  } catch (error) {
    io.stderr.write(`durlo: ${errorMessage(error)}\n`);
    return 1;
  }
}

export async function migrateConfig(config: DurloConfig): Promise<void> {
  const adapter = config.durlo.adapter as { migrate?: () => Promise<void> };
  if (typeof adapter.migrate !== "function") {
    throw new Error("the configured adapter does not support migrations");
  }
  await adapter.migrate();
}

export function parseConfigFlag(args: readonly string[]): { configPath?: string } {
  let configPath: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--config" || argument === "-c") {
      const value = args[index + 1];
      if (!value || value.startsWith("-")) throw new Error(`${argument} requires a path`);
      if (configPath !== undefined) throw new Error("--config may only be provided once");
      configPath = value;
      index += 1;
      continue;
    }
    throw new Error(`unknown option '${argument}'`);
  }
  return configPath === undefined ? {} : { configPath };
}

export function parseDevFlags(args: readonly string[]): {
  configPath?: string;
  host?: string;
  port?: number;
} {
  let configPath: string | undefined;
  let host: string | undefined;
  let port: number | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    const value = args[index + 1];
    if (!["--config", "-c", "--host", "--port"].includes(argument ?? "")) {
      throw new Error(`unknown option '${argument}'`);
    }
    if (!value || value.startsWith("-")) throw new Error(`${argument} requires a value`);
    if (argument === "--config" || argument === "-c") {
      if (configPath !== undefined) throw new Error("--config may only be provided once");
      configPath = value;
    } else if (argument === "--host") {
      if (host !== undefined) throw new Error("--host may only be provided once");
      host = value;
    } else {
      if (port !== undefined) throw new Error("--port may only be provided once");
      port = Number(value);
      if (!Number.isInteger(port) || port < 0 || port > 65_535) {
        throw new Error("--port must be an integer from 0 to 65535");
      }
    }
    index += 1;
  }
  return {
    ...(configPath === undefined ? {} : { configPath }),
    ...(host === undefined ? {} : { host }),
    ...(port === undefined ? {} : { port })
  };
}

function assertOnlyFlags(args: readonly string[], allowed: readonly string[]): void {
  for (const argument of args) {
    if (!allowed.includes(argument)) throw new Error(`unknown option '${argument}'`);
  }
  if (new Set(args).size !== args.length) throw new Error("an option may only be provided once");
}

function hasFlag(args: readonly string[], long: string, short: string): boolean {
  return args.includes(long) || args.includes(short);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
