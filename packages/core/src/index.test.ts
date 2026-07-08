import { describe, expect, it } from "vitest";
import { Durlo } from "@durlo/core";

describe("@durlo/core", () => {
  it("exports Durlo", () => {
    const durlo = new Durlo({ id: "test-app" });

    expect(durlo.id).toBe("test-app");
  });
});
