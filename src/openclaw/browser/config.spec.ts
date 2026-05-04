import { describe, expect, it } from "vitest";
import { resolveBrowserConfig } from "./config.js";

describe("resolveBrowserConfig", () => {
  it("disables arbitrary browser evaluate by default", () => {
    expect(resolveBrowserConfig(undefined).evaluateEnabled).toBe(false);
  });

  it("allows explicit opt-in for browser evaluate", () => {
    expect(resolveBrowserConfig({ evaluateEnabled: true }).evaluateEnabled).toBe(true);
  });
});
