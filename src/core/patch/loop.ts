import type { ModelProvider } from "../../models/provider.js";
import { buildFailureReport } from "./analyzers.js";
import { applyProposedPatch, readTargetSnapshot } from "./apply.js";
import {
	checkRegression,
	guardDiff,
	guardProposedPatch,
	reviewPatchIntent,
} from "./guards.js";
import {
	maybeSupplementFailureReport,
	requestPatchIntent,
	requestProposedPatch,
} from "./model.js";
import { savePatchTrace } from "./trace.js";
import type {
	PatchCallbacks,
	PatchOptions,
	PatchTrace,
	PatchTraceIteration,
	ValidationResult,
} from "./types.js";
import {
	allValidationsPassed,
	firstFailedOrLast,
	resolveValidationCommands,
	runValidation,
} from "./validation.js";

export async function runPatchLoop(
	provider: ModelProvider,
	opts: PatchOptions,
	callbacks: PatchCallbacks = {},
): Promise<PatchTrace> {
	const checks = await resolveValidationCommands({
		explicitChecks: opts.checks,
		cwd: opts.cwd,
	});
	callbacks.onStatus?.(`Checks: ${checks.join(" && ")}`);

	const baselineValidation = await runValidation(checks, { cwd: opts.cwd });
	for (const result of baselineValidation) callbacks.onValidation?.(result);

	const trace: PatchTrace = {
		goal: opts.goal,
		checks,
		baselineValidation,
		iterations: [],
		finalOutcome: "failed",
	};

	if (allValidationsPassed(baselineValidation)) {
		trace.finalOutcome = "success";
		trace.stopReason = "baseline_validation_passed";
		return await finalizeTrace(trace, opts);
	}

	let previous = firstFailedOrLast(baselineValidation);
	if (!previous) {
		trace.finalOutcome = "failed";
		trace.stopReason = "no_validation_results";
		callbacks.onStop?.(trace.stopReason);
		return await finalizeTrace(trace, opts);
	}

	let noImprovementRounds = 0;
	for (let round = 1; round <= opts.maxRounds; round++) {
		callbacks.onStatus?.(`Round ${round}: diagnosing`);
		const failureReport = await maybeSupplementFailureReport(
			await buildFailureReport(previous, opts),
			provider,
			opts,
		);
		callbacks.onFailureReport?.(failureReport);

		const iteration: PatchTraceIteration = {
			round,
			state: "diagnosing",
			validationResult: previous,
			failureReport,
			changedFiles: [],
			decision: "continue",
		};
		trace.iterations.push(iteration);

		if (
			failureReport.confidence === "low" &&
			failureReport.allowedFilesToEdit.length === 0
		) {
			iteration.decision = "stop";
			iteration.stopReason = "low_confidence_no_allowed_files";
			trace.finalOutcome = "stopped";
			trace.stopReason = iteration.stopReason;
			callbacks.onStop?.(iteration.stopReason);
			return await finalizeTrace(trace, opts);
		}

		callbacks.onStatus?.(`Round ${round}: requesting PatchIntent`);
		const patchIntent = await requestPatchIntent(failureReport, provider, opts);
		const patchIntentReview = reviewPatchIntent(
			patchIntent,
			failureReport,
			opts,
		);
		iteration.patchIntent = patchIntent;
		iteration.patchIntentReview = patchIntentReview;
		callbacks.onIntent?.(patchIntent, patchIntentReview);

		if (patchIntentReview.decision === "reject") {
			iteration.decision = "stop";
			iteration.stopReason = `patch_intent_rejected: ${patchIntentReview.violations.join("; ")}`;
			trace.finalOutcome = "stopped";
			trace.stopReason = iteration.stopReason;
			callbacks.onStop?.(iteration.stopReason);
			return await finalizeTrace(trace, opts);
		}

		if (patchIntentReview.decision === "needs_confirmation") {
			if (opts.nonInteractive || !callbacks.confirm) {
				iteration.decision = "stop";
				iteration.stopReason = "confirmation_required";
				trace.finalOutcome = "stopped";
				trace.stopReason = iteration.stopReason;
				callbacks.onStop?.(iteration.stopReason);
				return await finalizeTrace(trace, opts);
			}
			const confirmed = await callbacks.confirm(
				patchIntentReview,
				patchIntent,
				failureReport,
			);
			if (!confirmed) {
				iteration.decision = "stop";
				iteration.stopReason = "confirmation_declined";
				trace.finalOutcome = "stopped";
				trace.stopReason = iteration.stopReason;
				callbacks.onStop?.(iteration.stopReason);
				return await finalizeTrace(trace, opts);
			}
		}

		const approvedIntent = patchIntentReview.normalizedIntent || patchIntent;
		if (opts.dryRun) {
			iteration.decision = "stop";
			iteration.stopReason = "dry_run_after_patch_intent";
			trace.finalOutcome = "stopped";
			trace.stopReason = iteration.stopReason;
			return await finalizeTrace(trace, opts);
		}

		callbacks.onStatus?.(`Round ${round}: requesting patch`);
		const proposedPatch = await requestProposedPatch(
			failureReport,
			approvedIntent,
			provider,
			opts,
		);
		iteration.proposedPatch = proposedPatch;
		const proposedGuard = guardProposedPatch(
			proposedPatch,
			approvedIntent,
			opts,
		);
		if (!proposedGuard.approved) {
			iteration.decision = "stop";
			iteration.stopReason = `proposed_patch_rejected: ${proposedGuard.violations.join("; ")}`;
			trace.finalOutcome = "stopped";
			trace.stopReason = iteration.stopReason;
			callbacks.onStop?.(iteration.stopReason);
			return await finalizeTrace(trace, opts);
		}

		const beforeSnapshot = await readTargetSnapshot(
			approvedIntent.targetFiles,
			opts.cwd,
		);
		const appliedPatch = await applyProposedPatch(
			proposedPatch,
			approvedIntent,
			opts,
		);
		const afterSnapshot = await readTargetSnapshot(
			approvedIntent.targetFiles,
			opts.cwd,
		);
		iteration.appliedPatch = appliedPatch;
		iteration.changedFiles = appliedPatch.changedFiles;

		const diffGuard = guardDiff(
			beforeSnapshot,
			afterSnapshot,
			approvedIntent,
			appliedPatch,
			opts,
		);
		iteration.diffGuard = diffGuard;
		callbacks.onPatchApplied?.(appliedPatch, diffGuard);
		if (!diffGuard.approved) {
			iteration.decision = "stop";
			iteration.stopReason = `diff_guard_rejected: ${diffGuard.violations.join("; ")}`;
			trace.finalOutcome = "stopped";
			trace.stopReason = iteration.stopReason;
			callbacks.onStop?.(iteration.stopReason);
			return await finalizeTrace(trace, opts);
		}

		callbacks.onStatus?.(`Round ${round}: re-validating`);
		const afterValidationResults = await runValidation(checks, {
			cwd: opts.cwd,
		});
		for (const result of afterValidationResults)
			callbacks.onValidation?.(result);
		const after = firstFailedOrLast(afterValidationResults) as ValidationResult;
		iteration.validationAfterPatch = after;

		if (allValidationsPassed(afterValidationResults)) {
			iteration.decision = "success";
			trace.finalOutcome = "success";
			trace.stopReason = `success_after_${round}_rounds`;
			return await finalizeTrace(trace, opts);
		}

		const regressionCheck = checkRegression(previous, after, appliedPatch);
		iteration.regressionCheck = regressionCheck;
		if (regressionCheck.verdict === "regressed") {
			iteration.decision = "stop";
			iteration.stopReason = "regression_detected";
			trace.finalOutcome = "regressed";
			trace.stopReason = iteration.stopReason;
			callbacks.onStop?.(iteration.stopReason);
			return await finalizeTrace(trace, opts);
		}

		if (regressionCheck.verdict === "unchanged") noImprovementRounds += 1;
		else noImprovementRounds = 0;
		if (noImprovementRounds >= 2) {
			iteration.decision = "stop";
			iteration.stopReason = "no_improvement_for_two_rounds";
			trace.finalOutcome = "stopped";
			trace.stopReason = iteration.stopReason;
			callbacks.onStop?.(iteration.stopReason);
			return await finalizeTrace(trace, opts);
		}

		previous = after;
	}

	trace.finalOutcome = "stopped";
	trace.stopReason = "max_rounds_reached";
	callbacks.onStop?.(trace.stopReason);
	return await finalizeTrace(trace, opts);
}

async function finalizeTrace(
	trace: PatchTrace,
	opts: PatchOptions,
): Promise<PatchTrace> {
	if (opts.saveTrace) {
		try {
			trace.tracePath = await savePatchTrace(trace, opts.cwd);
		} catch {
			// Trace saving should not change the patch outcome.
		}
	}
	return trace;
}
