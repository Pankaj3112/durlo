import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  cliVersion,
  closeConfig,
  cliPackageName,
  defineConfig,
  findConfigPath,
  initProject,
  loadConfig,
  migrateConfig,
  parseConfigFlag,
  parseDevFlags,
  runCli
} from "@durlo/cli";
import type { DurloConfig } from "@durlo/cli";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

describe("@durlo/cli configuration", () => {
  it("exports the canonical package marker and preserves typed configuration", () => {
    const config = { durlo: { id: "test" } } as unknown as DurloConfig;
    expect(cliPackageName).toBe("@durlo/cli");
    expect(defineConfig(config)).toBe(config);
  });

  it("discovers supported configuration names and honors an explicit path", async () => {
    const cwd = await temporaryDirectory();
    await writeFile(join(cwd, "custom.mjs"), validConfigModule("custom"));
    await writeFile(join(cwd, "durlo.config.mjs"), validConfigModule("default"));

    expect(await findConfigPath(cwd)).toBe(join(cwd, "durlo.config.mjs"));
    expect(await findConfigPath(cwd, "custom.mjs")).toBe(join(cwd, "custom.mjs"));
    expect(await findConfigPath(cwd, join(cwd, "custom.mjs"))).toBe(join(cwd, "custom.mjs"));
    await expect(findConfigPath(cwd, "missing.ts")).rejects.toThrow(/not found/);
  });

  it("loads and validates a default-exported configuration", async () => {
    const cwd = await temporaryDirectory();
    await writeFile(join(cwd, "durlo.config.mjs"), validConfigModule("loaded"));

    const loaded = await loadConfig(cwd);
    expect(loaded.config.durlo.id).toBe("loaded");
    expect(loaded.path).toBe(join(cwd, "durlo.config.mjs"));
    await expect(closeConfig(loaded.config)).resolves.toBeUndefined();
  });

  it("rejects missing and malformed configurations with actionable errors", async () => {
    const cwd = await temporaryDirectory();
    await expect(loadConfig(cwd)).rejects.toThrow(/durlo init/);
    await writeFile(join(cwd, "durlo.config.mjs"), "export default { tasks: [] };\n");
    await expect(loadConfig(cwd)).rejects.toThrow(/provide a Durlo instance/);
  });

  it("accepts named configs and rejects broken modules and every malformed config section", async () => {
    const cwd = await temporaryDirectory();
    const cases = [
      ["broken.mjs", "export default {", /could not load/],
      ["missing.mjs", "export const unrelated = true;", /default-export/],
      ["tasks.mjs", configSource("tasks: {},"), /tasks.*array/],
      [
        "task.mjs",
        configSource("tasks: [{ kind: 'workflow', id: 'bad', version: '1', _durlo: {} }],"),
        /invalid task/
      ],
      ["workflows.mjs", configSource("workflows: {},"), /workflows.*array/],
      [
        "workflow.mjs",
        configSource("workflows: [{ kind: 'task', id: 'bad', version: '1', _durlo: {} }],"),
        /invalid workflow/
      ],
      ["worker.mjs", configSource("worker: [],"), /worker.*object/],
      ["dashboard.mjs", configSource("dashboard: [],"), /dashboard.*object/]
    ] as const;
    for (const [filename, source, expected] of cases) {
      await writeFile(join(cwd, filename), source);
      await expect(loadConfig(cwd, filename), filename).rejects.toThrow(expected);
    }

    await writeFile(
      join(cwd, "named.mjs"),
      "export const config = { durlo: { id: 'named', adapter: {} }, tasks: [], workflows: [] };"
    );
    await expect(loadConfig(cwd, "named.mjs")).resolves.toMatchObject({
      config: { durlo: { id: "named" } }
    });
  });
});

describe("durlo init", () => {
  it("creates a usable explicit configuration without overwriting by default", async () => {
    const cwd = await temporaryDirectory();
    const created = await initProject(cwd);
    const source = await readFile(created.path, "utf8");
    expect(source).toContain('from "@durlo/core"');
    expect(source).toContain('from "@durlo/cli"');
    expect(source).toContain("export const adapter");
    expect(source).toContain("tasks: [hello]");

    await expect(initProject(cwd)).rejects.toThrow(/--force/);
    await writeFile(created.path, "changed\n");
    await initProject(cwd, true);
    expect(await readFile(created.path, "utf8")).not.toBe("changed\n");
    await expect(initProject(join(cwd, "missing"))).rejects.toThrow();
  });

  it("reports created files and next commands", async () => {
    const cwd = await temporaryDirectory();
    const output = capture();
    expect(await runCli(["init"], { cwd, ...output })).toBe(0);
    expect(output.stdoutText()).toContain("durlo.config.ts");
    expect(output.stdoutText()).toContain("durlo migrate");
    expect(output.stderrText()).toBe("");
  });
});

describe("durlo migrate", () => {
  it("applies migrations and closes the configured adapter", async () => {
    const calls: string[] = [];
    const config = {
      durlo: {
        adapter: {
          migrate: async () => calls.push("migrate"),
          close: async () => calls.push("close")
        }
      }
    } as unknown as DurloConfig;
    await migrateConfig(config);
    await (config.durlo.adapter as unknown as { close: () => Promise<void> }).close();
    expect(calls).toEqual(["migrate", "close"]);
  });

  it("rejects adapters without migration support", async () => {
    const config = { durlo: { adapter: {} } } as unknown as DurloConfig;
    await expect(migrateConfig(config)).rejects.toThrow(/does not support migrations/);
  });

  it("parses one explicit config flag and rejects ambiguous options", () => {
    expect(parseConfigFlag(["--config", "custom.ts"])).toEqual({ configPath: "custom.ts" });
    expect(parseConfigFlag(["-c", "custom.ts"])).toEqual({ configPath: "custom.ts" });
    expect(() => parseConfigFlag(["--config"])).toThrow(/requires a path/);
    expect(() => parseConfigFlag(["--config", "a", "-c", "b"])).toThrow(/only be provided once/);
    expect(() => parseConfigFlag(["--wat"])).toThrow(/unknown option/);
  });

  it("parses dashboard overrides without accepting unknown or invalid values", () => {
    expect(parseDevFlags(["-c", "custom.ts", "--host", "localhost", "--port", "4321"])).toEqual({
      configPath: "custom.ts",
      host: "localhost",
      port: 4321
    });
    expect(() => parseDevFlags(["--port", "nope"])).toThrow(/integer/);
    expect(() => parseDevFlags(["--port", "70000"])).toThrow(/65535/);
    expect(() => parseDevFlags(["--port", "-1"])).toThrow(/requires a value/);
    expect(() => parseDevFlags(["--host"])).toThrow(/requires a value/);
    expect(() => parseDevFlags(["--wat", "value"])).toThrow(/unknown option/);
    expect(() => parseDevFlags(["--host", "a", "--host", "b"])).toThrow(/only be provided once/);
    expect(() => parseDevFlags(["--port", "1", "--port", "2"])).toThrow(/only be provided once/);
    expect(() => parseDevFlags(["--config", "a", "-c", "b"])).toThrow(/only be provided once/);
  });
});

describe("CLI shell", () => {
  it("prints help and reports unknown commands without throwing", async () => {
    const help = capture();
    expect(await runCli([], help)).toBe(0);
    expect(help.stdoutText()).toContain("durlo dev");

    const invalid = capture();
    expect(await runCli(["unknown"], invalid)).toBe(1);
    expect(invalid.stderrText()).toContain("unknown command");
  });

  it("prints version aliases and rejects invalid init options", async () => {
    for (const flag of ["--version", "-v"]) {
      const output = capture();
      expect(await runCli([flag], output)).toBe(0);
      expect(output.stdoutText()).toBe(`${cliVersion}\n`);
    }
    for (const args of [
      ["init", "--wat"],
      ["init", "--force", "--force"]
    ]) {
      const output = capture();
      expect(await runCli(args, output)).toBe(1);
      expect(output.stderrText()).toContain("option");
    }
  });

  it("runs migrate, worker, and dev through a loaded configuration and always closes it", async () => {
    const cwd = await temporaryDirectory();
    const marker = join(cwd, "commands.log");
    await writeFile(join(cwd, "commands.mjs"), commandConfigModule(marker));

    const expectations = [
      { args: ["migrate", "-c", "commands.mjs"], events: ["migrate", "close"] },
      { args: ["worker", "-c", "commands.mjs"], events: ["start", "close"] },
      {
        args: ["dev", "-c", "commands.mjs", "--host", "127.0.0.1", "--port", "0"],
        events: ["migrate", "start", "close"]
      }
    ];
    for (const { args, events } of expectations) {
      await writeFile(marker, "");
      const output = capture();
      expect(await runCli(args, { cwd, ...output }), args[0]).toBe(0);
      expect((await readFile(marker, "utf8")).trim().split("\n")).toEqual(events);
      expect(output.stderrText()).toBe("");
    }
  });

  it("closes a loaded config when command execution fails", async () => {
    const cwd = await temporaryDirectory();
    const marker = join(cwd, "failure.log");
    await writeFile(
      join(cwd, "failure.mjs"),
      `
        import { appendFile } from "node:fs/promises";
        export default {
          durlo: {
            id: "failure",
            adapter: { close: () => appendFile(${JSON.stringify(marker)}, "close\\n") }
          }
        };
      `
    );
    const output = capture();
    expect(await runCli(["migrate", "-c", "failure.mjs"], { cwd, ...output })).toBe(1);
    expect(await readFile(marker, "utf8")).toBe("close\n");
    expect(output.stderrText()).toContain("does not support migrations");
  });
});

function validConfigModule(id: string): string {
  return `
    export default {
      durlo: { id: ${JSON.stringify(id)}, adapter: {} },
      tasks: [],
      workflows: []
    };
  `;
}

function configSource(section: string): string {
  return `export default { durlo: { id: "invalid", adapter: {} }, ${section} };`;
}

function commandConfigModule(marker: string): string {
  return `
    import { appendFile } from "node:fs/promises";
    const record = (event) => appendFile(${JSON.stringify(marker)}, event + "\\n");
    const worker = {
      id: "command-worker",
      start: () => record("start"),
      stop: () => undefined,
      getHealth: () => ({ status: "running", activeRuns: 0, concurrency: 1 }),
      getCompatibilityReport: async () => ({ unavailableRuns: [], truncated: false })
    };
    export default {
      durlo: {
        id: "command-app",
        adapter: {
          migrate: () => record("migrate"),
          close: () => record("close")
        },
        worker: () => worker
      },
      tasks: [],
      workflows: [],
      dashboard: { host: "127.0.0.1", port: 0 }
    };
  `;
}

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "durlo-cli-test-"));
  temporaryDirectories.push(path);
  return path;
}

function capture(): {
  stdout: { write: (chunk: string | Uint8Array) => boolean };
  stderr: { write: (chunk: string | Uint8Array) => boolean };
  stdoutText: () => string;
  stderrText: () => string;
} {
  let stdout = "";
  let stderr = "";
  return {
    stdout: {
      write: (chunk) => {
        stdout += chunk.toString();
        return true;
      }
    },
    stderr: {
      write: (chunk) => {
        stderr += chunk.toString();
        return true;
      }
    },
    stdoutText: () => stdout,
    stderrText: () => stderr
  };
}
