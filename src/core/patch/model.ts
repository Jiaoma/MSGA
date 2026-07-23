import fs from "node:fs/promises";
import type { Message, ModelProvider } from "../../models/provider.js";
import {
	filterEditableFiles,
	normalizeRelativePath,
	resolveInsideCwd,
} from "./path-utils.js";
import {
	parseFailureModelSupplement,
	parsePatchIntent,
	parseProposedPatch,
} from "./schemas.js";
import type {
	FailureModelSupplement,
	FailureReport,
	PatchIntent,
	PatchOptions,
	ProposedPatch,
} from "./types.js";

const MAX_FILE_CHARS = 16_000;
const FAILURE_SUPPLEMENT_MAX_TOKENS = 512;
const PATCH_INTENT_MAX_TOKENS = 2048;
const PROPOSED_PATCH_MAX_TOKENS = 512;

export async function maybeSupplementFailureReport(
	report: FailureReport,
	provider: ModelProvider,
	opts: PatchOptions,
): Promise<FailureReport> {
	if (report.confidence === "high" && report.modelSupplement) return report;
	if (report.allowedFilesToEdit.length > 0) return report;

	const messages: Message[] = [
		{
			role: "system",
			content: `You supplement deterministic failure reports for a safe patch loop. Return ONLY JSON with this shape: {"suspectedCause":"...","repairHint":"...","riskNotes":["..."],"candidateFiles":[{"file":"src/example.ts","reason":"...","confidence":"high|medium|low"}]}. You may explain facts, but you must not override the provided failure report.`,
		},
		{
			role: "user",
			content: JSON.stringify({
				goal: opts.goal,
				failureReport: compactFailureReport(report),
				rules: [
					"Only suggest existing source files as candidates.",
					"Do not suggest tests, config files, dependencies, generated output, or node_modules unless explicitly allowed.",
					"If unsure, use low confidence.",
				],
			}),
		},
	];

	const response = await provider.chat(messages, [], {
		maxTokens: FAILURE_SUPPLEMENT_MAX_TOKENS,
		responseFormat: "json_object",
	});
	const parsed = parseFailureModelSupplement(response.content || "");
	if (!parsed.valid || !parsed.data || typeof parsed.data !== "object")
		return report;

	const supplement = parsed.data as FailureModelSupplement;
	const candidateFiles = (supplement.candidateFiles || [])
		.map((candidate) => normalizeRelativePath(candidate.file, opts.cwd))
		.filter(Boolean);
	const { allowed, disallowed } = filterEditableFiles(candidateFiles, opts);

	return {
		...report,
		source: report.source === "rule" ? "rule+model" : report.source,
		modelSupplement: supplement,
		suspectedFiles: [...new Set([...report.suspectedFiles, ...candidateFiles])],
		allowedFilesToEdit:
			report.allowedFilesToEdit.length > 0
				? report.allowedFilesToEdit
				: allowed,
		disallowedFiles: [...new Set([...report.disallowedFiles, ...disallowed])],
		confidence:
			report.confidence === "low" && allowed.length > 0
				? "medium"
				: report.confidence,
	};
}

export async function requestPatchIntent(
	report: FailureReport,
	provider: ModelProvider,
	opts: PatchOptions,
): Promise<PatchIntent> {
	const messages: Message[] = [
		{
			role: "system",
			content: `You generate PatchIntent for a safe code patch loop. Return ONLY valid JSON. targetFiles MUST be a subset of allowedFilesToEdit. Prefer low-risk, minimal source edits. If the safe fix is unclear, set riskLevel to "high" and changeType to "unknown".`,
		},
		{
			role: "user",
			content: JSON.stringify({
				goal: opts.goal,
				failureReport: compactFailureReport(report),
				allowedFilesToEdit: report.allowedFilesToEdit,
				disallowedFiles: report.disallowedFiles,
				safeOperations: [
					"edit_function",
					"add_guard",
					"adjust_type",
					"update_import",
				],
				maxChangedFiles: opts.maxChangedFiles,
				maxChangedLines: opts.maxChangedLines,
				requiredJsonShape: {
					targetFiles: ["src/file.ts"],
					changeType:
						"bug_fix|type_fix|test_fix|lint_fix|build_fix|dependency_fix|unknown",
					reason: "why this patch is needed",
					expectedEffect: "what should pass after the patch",
					failureEvidence: ["evidence from failure report"],
					allowedOperations: ["edit_function"],
					forbiddenOperations: ["Do not modify tests"],
					riskLevel: "low|medium|high",
					maxChangedFiles: 1,
					maxChangedLines: 20,
				},
			}),
		},
	];
	const response = await provider.chat(messages, [], {
		maxTokens: PATCH_INTENT_MAX_TOKENS,
		responseFormat: "json_object",
	});
	const parsed = parsePatchIntent(response.content || "");
	if (!parsed.valid || !parsed.data) {
		const fallback = buildFallbackPatchIntent(report, opts);
		if (fallback) return fallback;
		throw new Error(
			`Model did not return a valid PatchIntent: ${parsed.errors.map((e) => e.path).join(", ")}`,
		);
	}
	return normalizePatchIntent(parsed.data, opts);
}

function buildFallbackPatchIntent(
	report: FailureReport,
	opts: PatchOptions,
): PatchIntent | null {
	const candidates = report.allowedFilesToEdit.filter(Boolean);
	if (candidates.length !== 1) return null;
	const changeType =
		report.failureType === "type_error"
			? "type_fix"
			: report.failureType === "lint_error"
				? "lint_fix"
				: report.failureType === "build_error"
					? "build_fix"
					: "bug_fix";
	return normalizePatchIntent(
		{
			targetFiles: candidates,
			changeType,
			reason: report.primaryError || "Repair the failing validation.",
			expectedEffect: "Validation passes after a minimal source edit.",
			failureEvidence: report.evidence.slice(0, 3).map((e) => e.text),
			allowedOperations: ["edit_function"],
			forbiddenOperations: report.disallowedActions,
			riskLevel: "low",
			maxChangedFiles: candidates.length,
			maxChangedLines: opts.maxChangedLines,
		},
		opts,
	);
}

function normalizePatchIntent(
	intent: PatchIntent,
	opts: PatchOptions,
): PatchIntent {
	const targetFileCount = Math.max(1, intent.targetFiles.length);
	const fallbackMaxChangedFiles = Math.min(
		opts.maxChangedFiles,
		targetFileCount,
	);
	const maxChangedFiles =
		Number.isInteger(intent.maxChangedFiles) && intent.maxChangedFiles > 0
			? Math.min(intent.maxChangedFiles, opts.maxChangedFiles)
			: fallbackMaxChangedFiles;
	const maxChangedLines =
		intent.maxChangedLines !== undefined &&
		Number.isInteger(intent.maxChangedLines) &&
		intent.maxChangedLines > 0
			? Math.min(intent.maxChangedLines, opts.maxChangedLines)
			: undefined;

	return {
		...intent,
		maxChangedFiles,
		maxChangedLines,
	};
}

export async function requestProposedPatch(
	report: FailureReport,
	intent: PatchIntent,
	provider: ModelProvider,
	opts: PatchOptions,
): Promise<ProposedPatch> {
	const fileContexts = await Promise.all(
		intent.targetFiles.map(async (file) => {
			const normalized = normalizeRelativePath(file, opts.cwd);
			const resolved = resolveInsideCwd(normalized, opts.cwd);
			if (!resolved)
				throw new Error(`Target file escapes working directory: ${file}`);
			const content = await fs.readFile(resolved, "utf-8");
			return {
				file: normalized,
				content:
					content.length > MAX_FILE_CHARS
						? `${content.slice(0, MAX_FILE_CHARS)}\n/* FILE TRUNCATED: ask for a narrower goal if exact oldText is unavailable. */`
						: content,
			};
		}),
	);

	const messages: Message[] = [
		{
			role: "system",
			content: `You generate exact text edits for a safe patch loop. Return ONLY compact JSON and nothing else. Your entire response must be under 1200 characters. Use this exact shape: {"edits":[{"file":"src/file.ts","oldText":"exact text from file","newText":"replacement text","reason":"why"}]}. Prefer one minimal edit. oldText must be copied verbatim and appear exactly once. oldText must include a full unique line or small block, not a repeated identifier/expression. Keep reason under 80 characters. Do not explain. Do not use markdown or unified diff. Do not include <think> tags or hidden reasoning. Stop immediately after the JSON object.`,
		},
		{
			role: "user",
			content: JSON.stringify({
				goal: opts.goal,
				failureReport: compactFailureReport(report),
				approvedPatchIntent: intent,
				files: fileContexts,
				constraints: [
					"Return only a single compact JSON object; no prose before or after it.",
					"Do not include <think> tags, reasoning, markdown, or explanations.",
					"Keep the whole response under 1200 characters.",
					"Prefer exactly one edit when one edit can fix the failure.",
					"Only edit files listed in approvedPatchIntent.targetFiles.",
					"Use the smallest unique oldText/newText replacement.",
					"oldText must include a full line or small block that appears once in the file.",
					"Keep oldText/newText short, but exact; do not include whole files.",
					"Do not modify tests, config, dependencies, or validation commands unless explicitly included in targetFiles.",
					"If exact oldText is unavailable, return an edit that will fail rather than guessing broadly.",
				],
			}),
		},
	];
	const response = await provider.chat(messages, [], {
		maxTokens: PROPOSED_PATCH_MAX_TOKENS,
		responseFormat: "json_object",
	});
	const parsed = parseProposedPatch(response.content || "");
	if (!parsed.valid || !parsed.data) {
		throw new Error(
			`Model did not return a valid ProposedPatch: ${parsed.errors.map((e) => e.path).join(", ")}`,
		);
	}
	return parsed.data;
}

function compactFailureReport(report: FailureReport) {
	return {
		source: report.source,
		failureType: report.failureType,
		command: report.command,
		exitCode: report.exitCode,
		primaryError: report.primaryError,
		failingTests: report.failingTests,
		diagnostics: report.diagnostics.slice(0, 8),
		evidence: report.evidence.slice(0, 8),
		suspectedFiles: report.suspectedFiles,
		allowedFilesToEdit: report.allowedFilesToEdit,
		disallowedFiles: report.disallowedFiles,
		disallowedActions: report.disallowedActions,
		confidence: report.confidence,
		modelSupplement: report.modelSupplement,
	};
}
