import { describe, expect, it } from "vitest";
import {
  getBlockedBindReason,
  validateSandboxSecurity,
} from "./validate-sandbox-security.js";

describe("validateSandboxSecurity", () => {
  it("rejects bind mounts that expose host system paths or Docker sockets", () => {
    expect(getBlockedBindReason("/:workspace")?.kind).toBe("covers");
    expect(() => validateSandboxSecurity({ binds: ["/etc:/host-etc:ro"] })).toThrow(
      /blocked path "\/etc"/,
    );
    expect(() =>
      validateSandboxSecurity({ binds: ["/var/run/docker.sock:/var/run/docker.sock"] }),
    ).toThrow(/blocked path "\/var\/run"/);
  });

  it("rejects non-absolute bind sources because they cannot be safely bounded", () => {
    expect(() => validateSandboxSecurity({ binds: ["workspace-volume:/workspace"] })).toThrow(
      /non-absolute source path/,
    );
  });

  it("rejects isolation bypass settings", () => {
    expect(() => validateSandboxSecurity({ network: "host" })).toThrow(/network mode/);
    expect(() => validateSandboxSecurity({ seccompProfile: "unconfined" })).toThrow(
      /seccomp profile/,
    );
    expect(() => validateSandboxSecurity({ apparmorProfile: "unconfined" })).toThrow(
      /apparmor profile/,
    );
  });

  it("allows project-scoped absolute bind mounts with container isolation defaults", () => {
    expect(() =>
      validateSandboxSecurity({
        binds: ["/Users/kino/Files/work_projects/code:/workspace:ro"],
        network: "bridge",
      }),
    ).not.toThrow();
  });
});
