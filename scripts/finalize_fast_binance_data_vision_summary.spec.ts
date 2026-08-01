import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

async function tempRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "openalice-binance-finalize-"));
}

function runFinalize(outDir: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise(resolve => {
    const proc = spawn(
      join(process.cwd(), "node_modules/.bin/tsx"),
      [
        "scripts/finalize_fast_binance_data_vision_summary.ts",
        "--outDir",
        outDir,
      ],
      {
        cwd: process.cwd(),
        env: { ...process.env, NODE_NO_WARNINGS: "1" },
      }
    );
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    proc.stdout.on("data", chunk => stdout.push(Buffer.from(chunk)));
    proc.stderr.on("data", chunk => stderr.push(Buffer.from(chunk)));
    proc.on("close", code => {
      resolve({
        code,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });
}

describe("finalize_fast_binance_data_vision_summary", () => {
  it("finalizes a missing canonical summary when manifest latest zip paths all exist", async () => {
    const root = await tempRoot();
    const outDir = join(root, "spot-all-usdt-aggTrades");
    const zipPath = join(outDir, "spot/aggTrades/BTCUSDT/BTCUSDT-aggTrades-2024-01.zip");
    const manifestPath = join(outDir, "manifest.fast-binance-download.jsonl");
    await mkdir(join(outDir, "spot/aggTrades/BTCUSDT"), { recursive: true });
    await writeFile(zipPath, "zip", "utf8");
    await writeFile(
      manifestPath,
      [
        JSON.stringify({ zipPath, status: "failed", error: "timeout" }),
        JSON.stringify({ zipPath, status: "downloaded", httpStatus: 200 }),
        "",
      ].join("\n"),
      "utf8"
    );
    await writeFile(
      join(outDir, "summary.fast-binance-download.retry.json"),
      JSON.stringify(
        {
          startedAt: "2026-05-06T00:00:00.000Z",
          endedAt: "2026-05-06T00:01:00.000Z",
          mode: "retry_manifest",
          args: { market: "spot", dataType: "aggTrades" },
          files: 1,
          totals: { downloaded: 1, exists: 0, missing: 0, failed: 0 },
          manifestPath,
          coverage: "complete",
        },
        null,
        2
      ),
      "utf8"
    );

    const result = await runFinalize(outDir);

    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("finalized summary:");
    const summary = JSON.parse(await readFile(join(outDir, "summary.fast-binance-download.json"), "utf8"));
    expect(summary).toMatchObject({
      mode: "manifest_reconciliation",
      files: 1,
      totals: { downloaded: 0, exists: 1, missing: 0, failed: 0 },
      coverage: "complete",
      finalizedFrom: {
        method: "local_manifest_zip_reconciliation",
        manifest: {
          records: 2,
          uniqueZipPaths: 1,
          latestStatusCounts: { downloaded: 1 },
          missingZipPaths: 0,
        },
      },
    });
  });

  it("refuses to finalize from manifest when the zip file is missing", async () => {
    const root = await tempRoot();
    const outDir = join(root, "spot-all-usdt-aggTrades");
    const zipPath = join(outDir, "spot/aggTrades/BTCUSDT/BTCUSDT-aggTrades-2024-01.zip");
    const manifestPath = join(outDir, "manifest.fast-binance-download.jsonl");
    await mkdir(outDir, { recursive: true });
    await writeFile(manifestPath, `${JSON.stringify({ zipPath, status: "downloaded" })}\n`, "utf8");
    await writeFile(
      join(outDir, "summary.fast-binance-download.retry.json"),
      JSON.stringify(
        {
          files: 1,
          totals: { downloaded: 1, exists: 0, missing: 0, failed: 0 },
          manifestPath,
          coverage: "complete",
        },
        null,
        2
      ),
      "utf8"
    );

    const result = await runFinalize(outDir);

    expect(result.code).toBe(2);
    expect(result.stderr).toContain("cannot finalize summary from manifest");
    expect(result.stderr).toContain("allManifestZipPathsExist");
  });
});
