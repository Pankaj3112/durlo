import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  cliPackageName,
  defineConfig,
  findConfigPath,
  initProject,
  loadConfig,
  migrateConfig,
  parseConfigFlag,
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
    await expect(findConfigPath(cwd, "missing.ts")).rejects.toThrow(/not found/);
  });

  it("loads and validates a default-exported configuration", async () => {
    const cwd = await temporaryDirectory();
    await writeFile(join(cwd, "durlo.config.mjs"), validConfigModule("loaded"));

    const loaded = await loadConfig(cwd);
    expect(loaded.config.durlo.id).toBe("loaded");
    expect(loaded.path).toBe(join(cwd, "durlo.config.mjs"));
  });

  it("rejects missing and malformed configurations with actionable errors", async () => {
    const cwd = await temporaryDirectory();
    await expect(loadConfig(cwd)).rejects.toThrow(/durlo init/);
    await writeFile(join(cwd, "durlo.config.mjs"), "export default { tasks: [] };\n");
    await expect(loadConfig(cwd)).rejects.toThrow(/provide a Durlo instance/);
  });
});

describe("durlo init", () => {
  it("creates a usable explicit configuration without overwriting by default", async () => {
    const cwd = await temporaryDirectory();
    const created = await initProject(cwd);
    const source = await readFile(created.path, "utf8");
    expect(source).toContain('from "@durlo/core"');
    expect(source).toContain('from "@durlo/cli"');
    expect(source).toContain("tasks: [hello]");

    await expect(initProject(cwd)).rejects.toThrow(/--force/);
    await writeFile(created.path, "changed\n");
    await initProject(cwd, true);
    expect(await readFile(created.path, "utf8")).not.toBe("changed\n");
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
