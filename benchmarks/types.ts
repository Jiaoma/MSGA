import type { ValidationResult } from "../src/core/patch/types.js";

export type RunnerKind = "msga" | "baseline";

export interface BenchmarkFixture {
	id: string;
	name: string;
	description: string;
	goal: string;
	checks: string[];
	expectedChangedFiles?: string[];
	tags?: string[];
	timeoutMs?: number;
}

export interface BenchmarkRunConfig {
	runner: RunnerKind;
	model: string;
	baseUrl: string;
	fixture: BenchmarkFixture;
	fixturePath: string;
	workspace: string;
	maxRounds: number;
	allowTestEdits: boolean;
	allowConfigEdits: boolean;
	allowDependencyEdits: boolean;
}

export interface BenchmarkResult {
	fixtureId: string;
	runner: RunnerKind;
	model: string;
	baseUrl: string;
	success: boolean;
	rounds: number;
	durationMs: number;
	finalOutcome: string;
	stopReason?: string;
	finalError?: string;
	patchIntentDecision?: string;
	patchIntentValid?: boolean;
	changedFiles: string[];
	addedLines: number;
	deletedLines: number;
	modifiedTests: boolean;
	modifiedConfig: boolean;
	regression: boolean;
	tracePath?: string;
	workspace: string;
	validationResults: ValidationResult[];
}

export interface BenchmarkSummaryGroup {
	runs: number;
	successes: number;
	passRate: number;
	avgRounds: number;
	avgDurationMs: number;
	regressions: number;
	modifiedTests: number;
	modifiedConfig: number;
}

export interface BenchmarkSummary {
	runId: string;
	startedAt: string;
	durationMs: number;
	models: string[];
	fixtures: string[];
	runners: RunnerKind[];
	byRunner: Record<string, BenchmarkSummaryGroup>;
	byModel: Record<string, BenchmarkSummaryGroup>;
	byFixture: Record<string, BenchmarkSummaryGroup>;
	resultsPath: string;
}
