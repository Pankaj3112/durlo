import { describe, expect, it } from "vitest";
import { postgresPackageName } from "@durlo/postgres";

describe("@durlo/postgres", () => {
  it("exports the package marker", () => {
    expect(postgresPackageName).toBe("@durlo/postgres");
  });
});
