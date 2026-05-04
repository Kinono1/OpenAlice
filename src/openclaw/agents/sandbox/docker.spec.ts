import { describe, expect, it } from "vitest";
import { parseSetupCommandArgv } from "./docker.js";

describe("sandbox docker setupCommand parsing", () => {
  it("parses simple argv without using a shell", () => {
    expect(parseSetupCommandArgv("python -m pip install pytest")).toEqual([
      "python",
      "-m",
      "pip",
      "install",
      "pytest",
    ]);
  });

  it("keeps shell metacharacters as literal argv tokens", () => {
    expect(parseSetupCommandArgv("echo hello; rm -rf /tmp/example")).toEqual([
      "echo",
      "hello;",
      "rm",
      "-rf",
      "/tmp/example",
    ]);
  });

  it("supports quoted arguments", () => {
    expect(parseSetupCommandArgv('python -c "print(1)"')).toEqual([
      "python",
      "-c",
      "print(1)",
    ]);
  });

  it("rejects explicit shell command-string execution", () => {
    expect(() => parseSetupCommandArgv("sh -lc 'echo unsafe'")).toThrow(
      /cannot invoke a shell command string/,
    );
  });

  it("rejects multiline setup commands", () => {
    expect(() => parseSetupCommandArgv("echo one\necho two")).toThrow(
      /control-line characters/,
    );
  });
});
