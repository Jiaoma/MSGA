import type { PatchTrace, ValidationResult } from "../src/core/patch/types.js";
import type {
	BenchmarkResult,
	BenchmarkSummary,
	BenchmarkSummaryGroup,
} from "./types.js";

export function isTestPath(file: string): boolean {
	return (
		file.includes("/tests/") ||
		file.startsWith("tests/") ||
		file.includes("/__tests__/") ||
		/\.(test|spec)\.[cm]?[tj]sx?$/.test(file)
	);
}

export function isConfigPath(file: string): boolean {
	return /(^|\/)(package(?:-lock)?\.json|tsconfig\.json|biome\.json|vitest\.config\.[cm]?[tj]s|vite\.config\.[cm]?[tj]s|eslint\.config\.[cm]?[tj]s)$/.test(
		file,
	);
}

export function summarizePatchTrace(trace: PatchTrace): {
	changedFiles: string[];
	addedLines: number;
	deletedLines: number;
	patchIntentDecision?: string;
	patchIntentValid?: boolean;
	regression: boolean;
	finalError?: string;
	validationResults: ValidationResult[];
} {
	const changedFiles = [
		...new Set(trace.iterations.flatMap((i) => i.changedFiles)),
	];
	const addedLines = trace.iterations.reduce(
		(sum, i) => sum + (i.appliedPatch?.addedLines || 0),
		0,
	);
	const deletedLines = trace.iterations.reduce(
		(sum, i) => sum + (i.appliedPatch?.deletedLines || 0),
		0,
	);
	const lastIntentReview = [...trace.iterations]
		.reverse()
		.find((i) => i.patchIntentReview)?.patchIntentReview;
	const validations = [
		...trace.baselineValidation,
		...trace.iterations.flatMap((i) =>
			i.validationAfterPatch ? [i.validationAfterPatch] : [],
		),
	];
	const lastFailed = [...validations].reverse().find((v) => !v.success);
	return {
		changedFiles,
		addedLines,
		deletedLines,
		patchIntentDecision: lastIntentReview?.decision,
		patchIntentValid: lastIntentReview
			? lastIntentReview.decision !== "reject"
			: undefined,
		regression:
			trace.finalOutcome === "regressed" ||
			trace.iterations.some((i) => i.regressionCheck?.verdict === "regressed"),
		finalError: lastFailed?.primaryError,
		validationResults: validations,
	};
}

export function buildSummary(
	runId: string,
	startedAt: string,
	durationMs: number,
	results: BenchmarkResult[],
	resultsPath: string,
): BenchmarkSummary {
	return {
		runId,
		startedAt,
		durationMs,
		models: [...new Set(results.map((r) => r.model))],
		fixtures: [...new Set(results.map((r) => r.fixtureId))],
		runners: [...new Set(results.map((r) => r.runner))],
		byRunner: groupBy(results, (r) => r.runner),
		byModel: groupBy(results, (r) => r.model),
		byFixture: groupBy(results, (r) => r.fixtureId),
		resultsPath,
	};
}

function groupBy(
	results: BenchmarkResult[],
	keyFn: (result: BenchmarkResult) => string,
): Record<string, BenchmarkSummaryGroup> {
	const groups: Record<string, BenchmarkResult[]> = {};
	for (const result of results) {
		const key = keyFn(result);
		groups[key] ||= [];
		groups[key].push(result);
	}
	return Object.fromEntries(
		Object.entries(groups).map(([key, group]) => [key, summarizeGroup(group)]),
	);
}

function summarizeGroup(results: BenchmarkResult[]): BenchmarkSummaryGroup {
	const runs = results.length;
	const successes = results.filter((r) => r.success).length;
	return {
		runs,
		successes,
		passRate: runs === 0 ? 0 : successes / runs,
		avgRounds: avg(results.map((r) => r.rounds)),
		avgDurationMs: avg(results.map((r) => r.durationMs)),
		regressions: results.filter((r) => r.regression).length,
		modifiedTests: results.filter((r) => r.modifiedTests).length,
		modifiedConfig: results.filter((r) => r.modifiedConfig).length,
	};
}

function avg(values: number[]): number {
	if (values.length === 0) return 0;
	return Math.round(
		values.reduce((sum, value) => sum + value, 0) / values.length,
	);
}
