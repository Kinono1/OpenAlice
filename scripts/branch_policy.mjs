#!/usr/bin/env node

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const EXIT_OK = 0;
const EXIT_POLICY_FAIL = 2;
const EXIT_TOOL_ERROR = 3;

function parseArgs(argv) {
  const out = {
    config: "data/config/branch_workflow.v1.json",
    show: false,
    checkCurrent: false,
    checkMerge: false,
    source: undefined,
    target: undefined,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--config" && argv[i + 1]) {
      out.config = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === "--show") {
      out.show = true;
      continue;
    }
    if (arg === "--check-current") {
      out.checkCurrent = true;
      continue;
    }
    if (arg === "--check-merge") {
      out.checkMerge = true;
      continue;
    }
    if (arg === "--source" && argv[i + 1]) {
      out.source = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === "--target" && argv[i + 1]) {
      out.target = argv[i + 1];
      i += 1;
      continue;
    }
  }

  return out;
}

function loadPolicy(configPath) {
  const abs = resolve(process.cwd(), configPath);
  const raw = readFileSync(abs, "utf-8");
  return JSON.parse(raw);
}

function getCurrentBranch() {
  return execSync("git rev-parse --abbrev-ref HEAD", {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf-8",
  }).trim();
}

function sameDirection(a, b) {
  return a.from === b.from && a.to === b.to;
}

function showPolicy(policy, configPath) {
  const payload = {
    configPath,
    policyName: policy.policyName,
    version: policy.version,
    branches: policy.branches,
    defaultDevelopmentBranch: policy.rules.defaultDevelopmentBranch,
    allowedMergeDirections: policy.rules.allowedMergeDirections,
    forbiddenMergeDirections: policy.rules.forbiddenMergeDirections,
    enforcement: policy.enforcement ?? {},
  };
  console.log(JSON.stringify(payload, null, 2));
}

function checkCurrentBranch(policy) {
  const current = getCurrentBranch();
  const knownBranches = new Set(Object.values(policy.branches));
  const defaultBranch = policy.rules.defaultDevelopmentBranch;

  if (!knownBranches.has(current)) {
    console.error(
      `POLICY_FAIL: current branch "${current}" is not in configured workflow branches.`
    );
    return EXIT_POLICY_FAIL;
  }

  if (current === defaultBranch) {
    console.log(`PASS: current branch is default development branch (${current}).`);
    return EXIT_OK;
  }

  console.log(
    `PASS: current branch "${current}" is a valid workflow branch (default dev is "${defaultBranch}").`
  );
  return EXIT_OK;
}

function checkMergeDirection(policy, source, target) {
  const direction = { from: source, to: target };

  if (policy.rules.forbiddenMergeDirections.some((x) => sameDirection(x, direction))) {
    console.error(
      `POLICY_FAIL: merge direction ${source} -> ${target} is explicitly forbidden.`
    );
    return EXIT_POLICY_FAIL;
  }

  if (policy.rules.allowedMergeDirections.some((x) => sameDirection(x, direction))) {
    console.log(`PASS: merge direction ${source} -> ${target} is allowed.`);
    return EXIT_OK;
  }

  console.error(
    `POLICY_FAIL: merge direction ${source} -> ${target} is not in allowedMergeDirections.`
  );
  return EXIT_POLICY_FAIL;
}

function main() {
  try {
    const args = parseArgs(process.argv.slice(2));
    const policy = loadPolicy(args.config);
    const noActionRequested =
      !args.show && !args.checkCurrent && !args.checkMerge;

    if (args.show || noActionRequested) {
      showPolicy(policy, args.config);
    }

    if (args.checkCurrent || noActionRequested) {
      const code = checkCurrentBranch(policy);
      if (code !== EXIT_OK) {
        process.exit(code);
      }
    }

    if (args.checkMerge) {
      if (!args.source || !args.target) {
        console.error(
          "POLICY_FAIL: --check-merge requires both --source <branch> and --target <branch>."
        );
        process.exit(EXIT_POLICY_FAIL);
      }
      const code = checkMergeDirection(policy, args.source, args.target);
      process.exit(code);
    }

    process.exit(EXIT_OK);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`TOOL_ERROR: ${message}`);
    process.exit(EXIT_TOOL_ERROR);
  }
}

main();
