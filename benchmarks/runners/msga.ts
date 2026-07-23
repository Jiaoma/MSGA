import { runPatchLoop } from "../../src/core/patch/loop.js";
import { DEFAULT_PATCH_CONFIG } from "../../src/core/patch/types.js";
import type {
	FailureReport,
	PatchIntent,
	PatchIntentReview,
} from "../../src/core/patch/types.js";
import { OpenAIProvider } from "../../src/models/openai.js";
import { isConfigPath, isTestPath, summarizePatchTrace } from "../metrics.js";
import type { BenchmarkResult, BenchmarkRunConfig } from "../types.js";

export async function runMsgaBenchmark(
	config: BenchmarkRunConfig,
): Promise<BenchmarkResult> {
	const provider = new OpenAIProvider({
		id: config.model,
		baseUrl: config.baseUrl,
		model: config.model,
		maxTokens: 4096,
		temperature: 0.2,
		contextWindow: 32768,
		requestTimeoutMs: 600_000,
	});
	const started = Date.now();
	const trace = await runPatchLoop(
		provider,
		{
			goal: config.fixture.goal,
			checks: config.fixture.checks,
			maxRounds: config.maxRounds,
			dryRun: false,
			nonInteractive: false,
			json: true,
			allowTestEdits: config.allowTestEdits,
			allowConfigEdits: config.allowConfigEdits,
			allowDependencyEdits: config.allowDependencyEdits,
			cwd: config.workspace,
			maxChangedFiles: DEFAULT_PATCH_CONFIG.maxChangedFiles,
			maxChangedLines: DEFAULT_PATCH_CONFIG.maxChangedLines,
			saveTrace: true,
		},
		{ confirm: confirmSafeBenchmarkIntent },
	);
	const durationMs = Date.now() - started;
	const metrics = summarizePatchTrace(trace);
	return {
		fixtureId: config.fixture.id,
		runner: "msga",
		model: config.model,
		baseUrl: config.baseUrl,
		success: trace.finalOutcome === "success",
		rounds: trace.iterations.length,
		durationMs,
		finalOutcome: trace.finalOutcome,
		stopReason: trace.stopReason,
		finalError: metrics.finalError,
		patchIntentDecision: metrics.patchIntentDecision,
		patchIntentValid: metrics.patchIntentValid,
		changedFiles: metrics.changedFiles,
		addedLines: metrics.addedLines,
		deletedLines: metrics.deletedLines,
		modifiedTests: metrics.changedFiles.some(isTestPath),
		modifiedConfig: metrics.changedFiles.some(isConfigPath),
		regression: metrics.regression,
		tracePath: trace.tracePath,
		workspace: config.workspace,
		validationResults: metrics.validationResults,
	};
}

async function confirmSafeBenchmarkIntent(
	review: PatchIntentReview,
	intent: PatchIntent,
	_report: FailureReport,
): Promise<boolean> {
	return (
		review.violations.length === 0 &&
		review.requiredFlags.length === 0 &&
		intent.targetFiles.length <= DEFAULT_PATCH_CONFIG.maxChangedFiles &&
		!intent.targetFiles.some((file) => isTestPath(file) || isConfigPath(file))
	);
}
