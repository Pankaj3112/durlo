import { describe, expect, it } from "vitest";
import { cliPackageName } from "durlo";

describe("durlo", () => {
  it("exports the package marker", () => {
    expect(cliPackageName).toBe("durlo");
  });
});
