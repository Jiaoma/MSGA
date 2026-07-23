import {
	isConfigFile,
	isDependencyFile,
	isGeneratedOrVendorPath,
	isTestFile,
	normalizeRelativePath,
	unique,
} from "./path-utils.js";
import type {
	AppliedPatch,
	DiffGuardResult,
	FailureReport,
	PatchIntent,
	PatchIntentReview,
	PatchOptions,
	ProposedPatch,
	RegressionCheck,
	Snapshot,
	ValidationResult,
} from "./types.js";
import { SAFE_OPERATIONS } from "./types.js";

const DANGEROUS_TEXT_PATTERNS = [
	/\.skip\s*\(/,
	/\.only\s*\(/,
	/expect\s*\(\s*true\s*\)\.toBe\s*\(\s*true\s*\)/,
	/assert\s*\(\s*true\s*\)/,
	/process\.exit\s*\(\s*0\s*\)/,
	/noEmitOnError\s*[:=]\s*false/,
	/disable\s+(?:test|validation|check)/i,
	/skip\s+(?:test|validation|check)/i,
	/remove\s+assertion/i,
	/comment\s+out/i,
];

export function reviewPatchIntent(
	intent: PatchIntent,
	report: FailureReport,
	opts: PatchOptions,
): PatchIntentReview {
	const reasons: string[] = [];
	const violations: string[] = [];
	const requiredFlags: PatchIntentReview["requiredFlags"] = [];
	let riskScore = 0;

	const normalizedTargetFiles = unique(
		intent.targetFiles.map((f) => normalizeRelativePath(f, opts.cwd)),
	);
	const allowedSet = new Set(
		report.allowedFilesToEdit.map((f) => normalizeRelativePath(f, opts.cwd)),
	);

	if (normalizedTargetFiles.length === 0)
		violations.push("PatchIntent has no target files.");
	if (normalizedTargetFiles.length > opts.maxChangedFiles) {
		riskScore += 25;
		violations.push(
			`Patch targets ${normalizedTargetFiles.length} files, above max ${opts.maxChangedFiles}.`,
		);
	}

	for (const file of normalizedTargetFiles) {
		if (!allowedSet.has(file))
			violations.push(`Target file ${file} is outside allowedFilesToEdit.`);
		if (isGeneratedOrVendorPath(file))
			violations.push(`Target file ${file} is generated/vendor output.`);
		if (isTestFile(file)) {
			if (!opts.allowTestEdits)
				violations.push(`Test file edits are disabled: ${file}.`);
			else {
				riskScore += 30;
				requiredFlags.push("allow_test_edits");
				reasons.push(`Patch touches test file ${file}.`);
			}
		}
		if (isConfigFile(file)) {
			if (!opts.allowConfigEdits)
				violations.push(`Config file edits are disabled: ${file}.`);
			else {
				riskScore += 35;
				requiredFlags.push("allow_config_edits");
				reasons.push(`Patch touches config file ${file}.`);
			}
		}
		if (isDependencyFile(file)) {
			if (!opts.allowDependencyEdits)
				violations.push(`Dependency edits are disabled: ${file}.`);
			else {
				riskScore += 50;
				requiredFlags.push("allow_dependency_edits");
				reasons.push(`Patch touches dependency file ${file}.`);
			}
		}
	}

	if (report.confidence === "medium") riskScore += 10;
	if (report.confidence === "low") {
		riskScore += 35;
		reasons.push("FailureReport confidence is low.");
	}

	if (intent.riskLevel === "medium") riskScore += 25;
	if (intent.riskLevel === "high") {
		riskScore += 60;
		violations.push("High-risk PatchIntent is not auto-executable in v0.2.");
	}

	const unsafeOps = intent.allowedOperations.filter(
		(op) => !SAFE_OPERATIONS.includes(op),
	);
	if (unsafeOps.length > 0) {
		riskScore += 40;
		reasons.push(`Patch uses non-default operations: ${unsafeOps.join(", ")}.`);
	}
	if (unsafeOps.includes("dependency_fix"))
		violations.push("Dependency fix operation is disabled by default.");

	const maxChangedLines = intent.maxChangedLines ?? opts.maxChangedLines;
	if (maxChangedLines > opts.maxChangedLines) {
		riskScore += 20;
		reasons.push(
			`Patch may change ${maxChangedLines} lines, above max ${opts.maxChangedLines}.`,
		);
	}
	if (maxChangedLines > 120)
		violations.push("Patch changed line budget is too large for v0.2.");

	const intentText = JSON.stringify(intent);
	if (hasDangerousPattern(intentText))
		violations.push(
			"PatchIntent contains dangerous validation-bypass language.",
		);

	const normalizedIntent = { ...intent, targetFiles: normalizedTargetFiles };
	let decision: PatchIntentReview["decision"];
	if (violations.length > 0) decision = "reject";
	else if (
		riskScore < 30 &&
		intent.riskLevel === "low" &&
		report.confidence !== "low"
	)
		decision = "auto_approve";
	else if (riskScore < 70) decision = "needs_confirmation";
	else decision = "reject";

	if (decision === "auto_approve")
		reasons.push("Low-risk PatchIntent auto-approved.");
	if (decision === "needs_confirmation")
		reasons.push("PatchIntent requires confirmation.");

	return {
		decision,
		riskScore,
		reasons: unique(reasons),
		violations: unique(violations),
		requiredFlags: unique(requiredFlags),
		normalizedIntent,
	};
}

export function guardProposedPatch(
	patch: ProposedPatch,
	intent: PatchIntent,
	opts: PatchOptions,
): { approved: boolean; violations: string[] } {
	const violations: string[] = [];
	const targets = new Set(
		intent.targetFiles.map((f) => normalizeRelativePath(f, opts.cwd)),
	);
	for (const edit of patch.edits) {
		const file = normalizeRelativePath(edit.file, opts.cwd);
		if (!targets.has(file))
			violations.push(
				`Patch edit file ${file} is outside PatchIntent targetFiles.`,
			);
		if (!edit.oldText)
			violations.push(`Patch edit for ${file} has empty oldText.`);
		if (edit.oldText === edit.newText)
			violations.push(`Patch edit for ${file} does not change text.`);
		if (
			hasDangerousPattern(`${edit.oldText}\n${edit.newText}\n${edit.reason}`)
		) {
			violations.push(
				`Patch edit for ${file} contains dangerous validation-bypass pattern.`,
			);
		}
	}
	return { approved: violations.length === 0, violations: unique(violations) };
}

export function guardDiff(
	before: Snapshot,
	after: Snapshot,
	intent: PatchIntent,
	applied: AppliedPatch,
	opts: PatchOptions,
): DiffGuardResult {
	const violations: string[] = [];
	const targets = new Set(
		intent.targetFiles.map((f) => normalizeRelativePath(f, opts.cwd)),
	);
	for (const file of applied.changedFiles) {
		const normalized = normalizeRelativePath(file, opts.cwd);
		if (!targets.has(normalized))
			violations.push(
				`Changed file ${normalized} is outside PatchIntent targetFiles.`,
			);
		if (isGeneratedOrVendorPath(normalized))
			violations.push(`Changed file ${normalized} is generated/vendor output.`);
		if (!opts.allowTestEdits && isTestFile(normalized))
			violations.push(`Changed test file without permission: ${normalized}.`);
		if (!opts.allowConfigEdits && isConfigFile(normalized))
			violations.push(`Changed config file without permission: ${normalized}.`);
		if (!opts.allowDependencyEdits && isDependencyFile(normalized))
			violations.push(
				`Changed dependency file without permission: ${normalized}.`,
			);
	}
	if (
		applied.changedFiles.length > intent.maxChangedFiles ||
		applied.changedFiles.length > opts.maxChangedFiles
	) {
		violations.push("Changed file count exceeds configured limits.");
	}
	const lineLimit = Math.min(
		intent.maxChangedLines ?? opts.maxChangedLines,
		opts.maxChangedLines,
	);
	if (applied.addedLines + applied.deletedLines > lineLimit)
		violations.push("Changed line count exceeds configured limits.");

	for (const [file, content] of after.files) {
		if (before.files.get(file) !== content && hasDangerousPattern(content)) {
			violations.push(
				`Changed file ${file} contains dangerous validation-bypass pattern.`,
			);
		}
	}

	return {
		approved: violations.length === 0,
		changedFiles: applied.changedFiles,
		addedLines: applied.addedLines,
		deletedLines: applied.deletedLines,
		violations: unique(violations),
	};
}

export function checkRegression(
	before: ValidationResult,
	after: ValidationResult,
	applied: AppliedPatch,
): RegressionCheck {
	const previousFailures = failureKeys(before);
	const currentFailures = failureKeys(after);
	const newFailures = currentFailures.filter(
		(f) => !previousFailures.includes(f),
	);
	const fixedFailures = previousFailures.filter(
		(f) => !currentFailures.includes(f),
	);
	let verdict: RegressionCheck["verdict"] = "unchanged";
	if (after.success) verdict = "improved";
	else if (
		newFailures.length > 0 &&
		currentFailures.length >= previousFailures.length
	)
		verdict = "regressed";
	else if (
		currentFailures.length < previousFailures.length ||
		fixedFailures.length > 0
	)
		verdict = "improved";
	else if (after.primaryError !== before.primaryError) verdict = "improved";

	return {
		previousFailingCount: previousFailures.length,
		currentFailingCount: currentFailures.length,
		newFailures,
		fixedFailures,
		changedFilesDelta: applied.changedFiles,
		verdict,
	};
}

function failureKeys(result: ValidationResult): string[] {
	if (result.success) return [];
	const keys = [
		...result.failingTests,
		...result.failingFiles,
		result.primaryError,
	].filter(Boolean);
	return unique(
		keys.length > 0 ? keys : [`${result.command}:${result.exitCode}`],
	);
}

function hasDangerousPattern(text: string): boolean {
	return DANGEROUS_TEXT_PATTERNS.some((pattern) => pattern.test(text));
}
