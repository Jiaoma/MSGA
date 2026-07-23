import { readFile } from "node:fs/promises";
import { applyProposedPatch } from "../../src/core/patch/apply.js";
import { parseProposedPatch } from "../../src/core/patch/schemas.js";
import type {
	PatchIntent,
	PatchOptions,
	ProposedPatch,
	ValidationResult,
} from "../../src/core/patch/types.js";
import {
	allValidationsPassed,
	firstFailedOrLast,
	runValidation,
} from "../../src/core/patch/validation.js";
import { OpenAIProvider } from "../../src/models/openai.js";
import type { Message } from "../../src/models/provider.js";
import { isConfigPath, isTestPath } from "../metrics.js";
import type { BenchmarkResult, BenchmarkRunConfig } from "../types.js";

export async function runBaselineBenchmark(
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
	const validations: ValidationResult[] = [];
	const changedFiles = new Set<string>();
	let addedLines = 0;
	let deletedLines = 0;
	let finalOutcome = "failed";
	let stopReason: string | undefined;
	let lastError: string | undefined;
	let rounds = 0;

	const opts: PatchOptions = {
		goal: config.fixture.goal,
		checks: config.fixture.checks,
		maxRounds: config.maxRounds,
		dryRun: false,
		nonInteractive: true,
		json: true,
		allowTestEdits: config.allowTestEdits,
		allowConfigEdits: config.allowConfigEdits,
		allowDependencyEdits: config.allowDependencyEdits,
		cwd: config.workspace,
		maxChangedFiles: 4,
		maxChangedLines: 120,
		saveTrace: false,
	};

	for (let round = 0; round <= config.maxRounds; round++) {
		const validation = await runValidation(config.fixture.checks, {
			cwd: config.workspace,
		});
		validations.push(...validation);
		if (allValidationsPassed(validation)) {
			finalOutcome = "success";
			break;
		}
		const failed = firstFailedOrLast(validation);
		lastError = failed?.primaryError;
		if (round === config.maxRounds) {
			stopReason = "max_rounds_reached";
			break;
		}
		rounds += 1;
		const patch = await requestBaselinePatch(provider, config, failed);
		const intent = buildBaselineIntent(patch, config, opts);
		const applied = await applyProposedPatch(patch, intent, opts);
		for (const file of applied.changedFiles) changedFiles.add(file);
		addedLines += applied.addedLines;
		deletedLines += applied.deletedLines;
	}

	const changed = [...changedFiles];
	return {
		fixtureId: config.fixture.id,
		runner: "baseline",
		model: config.model,
		baseUrl: config.baseUrl,
		success: finalOutcome === "success",
		rounds,
		durationMs: Date.now() - started,
		finalOutcome,
		stopReason,
		finalError: lastError,
		changedFiles: changed,
		addedLines,
		deletedLines,
		modifiedTests: changed.some(isTestPath),
		modifiedConfig: changed.some(isConfigPath),
		regression: false,
		workspace: config.workspace,
		validationResults: validations,
	};
}

async function requestBaselinePatch(
	provider: OpenAIProvider,
	config: BenchmarkRunConfig,
	failed?: ValidationResult,
): Promise<ProposedPatch> {
	const sourceFiles = await readLikelySourceFiles(config);
	const messages: Message[] = [
		{
			role: "system",
			content:
				'You are a direct coding baseline. Return ONLY JSON: {"edits":[{"file":"src/file.ts","oldText":"exact text","newText":"replacement","reason":"why"}]}. Do not use markdown.',
		},
		{
			role: "user",
			content: JSON.stringify({
				goal: config.fixture.goal,
				failedValidation: failed,
				files: sourceFiles,
				constraints: [
					"Use exact oldText copied from the file.",
					"Prefer source files only.",
					"Do not modify tests or config unless unavoidable.",
				],
			}),
		},
	];
	const response = await provider.chat(messages, []);
	const parsed = parseProposedPatch(response.content || "");
	if (!parsed.valid || !parsed.data)
		throw new Error("baseline_model_invalid_patch_json");
	return parsed.data;
}

async function readLikelySourceFiles(
	config: BenchmarkRunConfig,
): Promise<Array<{ file: string; content: string }>> {
	const files = [
		...new Set([
			...(config.fixture.expectedChangedFiles || []),
			"src/index.ts",
			"src/main.ts",
			"src/calc.ts",
			"src/parser.ts",
		]),
	].filter((file) => !isTestPath(file) && !isConfigPath(file));
	const result: Array<{ file: string; content: string }> = [];
	for (const file of files) {
		try {
			result.push({
				file,
				content: await readFile(`${config.workspace}/${file}`, "utf-8"),
			});
		} catch {
			// Fixture may not include every conventional file.
		}
	}
	return result;
}

function buildBaselineIntent(
	patch: ProposedPatch,
	config: BenchmarkRunConfig,
	opts: PatchOptions,
): PatchIntent {
	return {
		targetFiles: [...new Set(patch.edits.map((edit) => edit.file))],
		changeType: "bug_fix",
		reason: "baseline direct patch",
		expectedEffect: "validation passes",
		failureEvidence: [],
		allowedOperations: ["edit_function"],
		forbiddenOperations: [],
		riskLevel: "low",
		maxChangedFiles: opts.maxChangedFiles,
		maxChangedLines: opts.maxChangedLines,
	};
}
