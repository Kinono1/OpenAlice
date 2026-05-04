import { afterEach, describe, expect, it } from "vitest";
import {
  assertSafeBrowserNavigationUrl,
  assertSafeBrowserNavigationUrlResolved,
} from "./browser-tool.js";

describe("assertSafeBrowserNavigationUrl", () => {
  afterEach(() => {
    delete process.env.OPENCLAW_BROWSER_ALLOW_PRIVATE_NAV;
  });

  it("allows public http and https URLs", () => {
    expect(() => assertSafeBrowserNavigationUrl("https://example.com/path")).not.toThrow();
    expect(() => assertSafeBrowserNavigationUrl("http://example.com/path")).not.toThrow();
  });

  it("rejects non-web URL schemes", () => {
    expect(() => assertSafeBrowserNavigationUrl("file:///etc/passwd")).toThrow(/http or https/);
    expect(() => assertSafeBrowserNavigationUrl("javascript:alert(1)")).toThrow(/http or https/);
  });

  it("rejects localhost and private literal IP targets by default", () => {
    expect(() => assertSafeBrowserNavigationUrl("http://localhost:3000")).toThrow(/private host/);
    expect(() => assertSafeBrowserNavigationUrl("http://127.0.0.1:3000")).toThrow(/private IP/);
    expect(() => assertSafeBrowserNavigationUrl("http://[::1]:3000")).toThrow(/private IP/);
    expect(() => assertSafeBrowserNavigationUrl("http://10.0.0.1")).toThrow(/private IP/);
    expect(() => assertSafeBrowserNavigationUrl("http://169.254.169.254")).toThrow(/private IP/);
  });

  it("rejects public hostnames that resolve to private addresses", async () => {
    await expect(
      assertSafeBrowserNavigationUrlResolved("http://metadata.example.test", async () => [
        { address: "169.254.169.254", family: 4 },
      ]),
    ).rejects.toThrow(/resolved to private IP/);
  });

  it("allows hostnames whose resolved addresses are public", async () => {
    await expect(
      assertSafeBrowserNavigationUrlResolved("https://example.test", async () => [
        { address: "93.184.216.34", family: 4 },
      ]),
    ).resolves.toBeUndefined();
  });

  it("allows private targets only with explicit opt-in", () => {
    process.env.OPENCLAW_BROWSER_ALLOW_PRIVATE_NAV = "1";

    expect(() => assertSafeBrowserNavigationUrl("http://localhost:3000")).not.toThrow();
  });
});
