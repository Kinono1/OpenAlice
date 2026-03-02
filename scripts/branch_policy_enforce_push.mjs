#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const EXIT_OK = 0;
const EXIT_POLICY_FAIL = 2;
const EXIT_TOOL_ERROR = 3;

function parseArgs(argv) {
  const out = {
    config: "data/config/branch_workflow.v1.json",
    remoteName: "",
    remoteUrl: "",
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--config" && argv[i + 1]) {
      out.config = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === "--remote-name" && argv[i + 1]) {
      out.remoteName = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === "--remote-url" && argv[i + 1]) {
      out.remoteUrl = argv[i + 1];
      i += 1;
      continue;
    }
  }

  return out;
}

function loadPolicy(configPath) {
  const abs = resolve(process.cwd(), configPath);
  return JSON.parse(readFileSync(abs, "utf-8"));
}

function readStdin() {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function refToBranch(ref) {
  if (!ref) {
    return null;
  }
  const prefix = "refs/heads/";
  if (ref.startsWith(prefix)) {
    return ref.slice(prefix.length);
  }
  return null;
}

function sameDirection(a, b) {
  return a.from === b.from && a.to === b.to;
}

function parsePushUpdates(input) {
  return input
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.split(/\s+/))
    .filter((parts) => parts.length >= 4)
    .map(([localRef, localSha, remoteRef, remoteSha]) => ({
      localRef,
      localSha,
      remoteRef,
      remoteSha,
      from: refToBranch(localRef),
      to: refToBranch(remoteRef),
    }));
}

function enforce(policy, args, updates) {
  const enforcement = policy.enforcement ?? {};
  const prePush = enforcement.prePush ?? {};

  if (!enforcement.enabled || !prePush.enabled) {
    console.log("PASS: branch policy pre-push enforcement is disabled.");
    return EXIT_OK;
  }

  if (updates.length === 0) {
    console.log("PASS: no refs to validate.");
    return EXIT_OK;
  }

  const knownBranches = new Set(Object.values(policy.branches ?? {}));
  const roleByRemoteName = new Map(
    Object.entries(policy.remotes ?? {}).map(([role, remoteName]) => [
      remoteName,
      role,
    ])
  );
  const remoteRole = roleByRemoteName.get(args.remoteName) ?? "";
  const allowedPushDirections = prePush.allowedPushDirections ?? [];
  const forbiddenPushDirections = prePush.forbiddenPushDirections ?? [];
  const branchRemotePolicy = prePush.branchRemotePolicy ?? [];
  const violations = [];

  for (const update of updates) {
    if (!update.to) {
      continue;
    }

    if (!update.from) {
      violations.push(
        `non-branch source ref "${update.localRef}" cannot update protected branch ${update.to}; use refs/heads/<branch> as source.`
      );
      continue;
    }

    const direction = { from: update.from, to: update.to };

    if (
      prePush.blockUnknownBranches &&
      (!knownBranches.has(update.from) || !knownBranches.has(update.to))
    ) {
      violations.push(
        `unknown branch in push direction ${update.from} -> ${update.to}.`
      );
      continue;
    }

    if (forbiddenPushDirections.some((x) => sameDirection(x, direction))) {
      violations.push(
        `forbidden push direction ${update.from} -> ${update.to}.`
      );
      continue;
    }

    if (
      allowedPushDirections.length > 0 &&
      !allowedPushDirections.some((x) => sameDirection(x, direction))
    ) {
      violations.push(
        `direction ${update.from} -> ${update.to} is not in allowedPushDirections.`
      );
      continue;
    }

    const remoteRule = branchRemotePolicy.find(
      (rule) => rule.branch === update.to
    );
    if (remoteRule) {
      if (!remoteRole) {
        violations.push(
          `remote "${args.remoteName}" is not mapped in policy.remotes for branch ${update.to}.`
        );
        continue;
      }
      if (!remoteRule.allowedRemoteRoles.includes(remoteRole)) {
        violations.push(
          `remote role "${remoteRole}" is not allowed for branch ${update.to} (allowed: ${remoteRule.allowedRemoteRoles.join(", ")}).`
        );
      }
    }
  }

  if (violations.length > 0) {
    console.error("POLICY_FAIL: pre-push validation failed.");
    for (const violation of violations) {
      console.error(`- ${violation}`);
    }
    return EXIT_POLICY_FAIL;
  }

  console.log(
    `PASS: pre-push policy passed for remote "${args.remoteName || "unknown"}".`
  );
  return EXIT_OK;
}

function main() {
  try {
    const args = parseArgs(process.argv.slice(2));
    const policy = loadPolicy(args.config);
    const updates = parsePushUpdates(readStdin());
    const code = enforce(policy, args, updates);
    process.exit(code);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`TOOL_ERROR: ${message}`);
    process.exit(EXIT_TOOL_ERROR);
  }
}

main();
