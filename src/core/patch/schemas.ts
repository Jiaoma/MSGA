import { z } from "zod";
import { type ValidationResult, validateToolCallArgs } from "../validator.js";
import type { PatchIntent, ProposedPatch } from "./types.js";

export const PatchOperationSchema = z.enum([
	"edit_function",
	"add_guard",
	"adjust_type",
	"update_import",
	"add_test",
	"update_test",
	"update_config",
	"rename_symbol",
	"small_refactor",
	"dependency_fix",
]);

export const PatchIntentSchema = z.object({
	targetFiles: z.array(z.string()).min(1),
	changeType: z.enum([
		"bug_fix",
		"type_fix",
		"test_fix",
		"lint_fix",
		"build_fix",
		"dependency_fix",
		"unknown",
	]),
	reason: z.string(),
	expectedEffect: z.string(),
	failureEvidence: z.array(z.string()),
	allowedOperations: z.array(PatchOperationSchema),
	forbiddenOperations: z.array(z.string()),
	riskLevel: z.enum(["low", "medium", "high"]),
	maxChangedFiles: z.number().int().positive(),
	maxChangedLines: z.number().int().positive().optional(),
});

export const ProposedPatchSchema = z.object({
	edits: z
		.array(
			z.object({
				file: z.string(),
				oldText: z.string().min(1),
				newText: z.string(),
				reason: z.string(),
			}),
		)
		.min(1),
});

export const FailureModelSupplementSchema = z.object({
	suspectedCause: z.string(),
	repairHint: z.string(),
	riskNotes: z.array(z.string()),
	candidateFiles: z
		.array(
			z.object({
				file: z.string(),
				reason: z.string(),
				confidence: z.enum(["high", "medium", "low"]),
			}),
		)
		.optional(),
});

export function parsePatchIntent(raw: string): ValidationResult<PatchIntent> {
	return validateToolCallArgs(
		raw,
		PatchIntentSchema,
	) as ValidationResult<PatchIntent>;
}

export function parseProposedPatch(
	raw: string,
): ValidationResult<ProposedPatch> {
	return validateToolCallArgs(
		raw,
		ProposedPatchSchema,
	) as ValidationResult<ProposedPatch>;
}

export function parseFailureModelSupplement(raw: string) {
	return validateToolCallArgs(raw, FailureModelSupplementSchema);
}
