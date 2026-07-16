import { closeConfig, loadConfig } from "./config.js";
import { initProject } from "./init.js";
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
`;

export const cliPackageName = "@durlo/cli";
export const cliVersion = "0.0.0";

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

    if (command === "worker" || command === "dev") {
      throw new Error(`'durlo ${command}' is not available in this build`);
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
