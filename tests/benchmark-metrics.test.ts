import { describe, expect, it } from "vitest";
import {
	buildSummary,
	isConfigPath,
	isTestPath,
} from "../benchmarks/metrics.js";
import type { BenchmarkResult } from "../benchmarks/types.js";

const result = (overrides: Partial<BenchmarkResult>): BenchmarkResult => ({
	fixtureId: "simple-ts-bug",
	runner: "msga",
	model: "qwen3:8b",
	baseUrl: "http://127.0.0.1:11434/v1",
	success: false,
	rounds: 1,
	durationMs: 1000,
	finalOutcome: "failed",
	changedFiles: [],
	addedLines: 0,
	deletedLines: 0,
	modifiedTests: false,
	modifiedConfig: false,
	regression: false,
	workspace: "/tmp/ws",
	validationResults: [],
	...overrides,
});

describe("benchmark metrics", () => {
	it("detects test paths", () => {
		expect(isTestPath("tests/foo.test.ts")).toBe(true);
		expect(isTestPath("src/__tests__/foo.ts")).toBe(true);
		expect(isTestPath("src/foo.ts")).toBe(false);
	});

	it("detects config paths", () => {
		expect(isConfigPath("package.json")).toBe(true);
		expect(isConfigPath("tsconfig.json")).toBe(true);
		expect(isConfigPath("src/foo.ts")).toBe(false);
	});

	it("builds grouped summary", () => {
		const summary = buildSummary(
			"run-1",
			"now",
			2000,
			[
				result({ success: true, finalOutcome: "success" }),
				result({ runner: "baseline", success: false, modifiedTests: true }),
			],
			"/tmp/results.jsonl",
		);
		expect(summary.byRunner.msga.passRate).toBe(1);
		expect(summary.byRunner.baseline.modifiedTests).toBe(1);
		expect(summary.byModel["qwen3:8b"].runs).toBe(2);
	});
});
