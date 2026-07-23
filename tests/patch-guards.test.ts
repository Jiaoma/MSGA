import { describe, it, expect } from "vitest";
import { reviewPatchIntent } from "../src/core/patch/guards.js";
import type {
	FailureReport,
	PatchIntent,
	PatchOptions,
} from "../src/core/patch/types.js";

const opts: PatchOptions = {
	checks: ["npm test"],
	maxRounds: 3,
	dryRun: false,
	nonInteractive: true,
	json: false,
	allowTestEdits: false,
	allowConfigEdits: false,
	allowDependencyEdits: false,
	cwd: process.cwd(),
	maxChangedFiles: 2,
	maxChangedLines: 40,
	saveTrace: false,
};

const report: FailureReport = {
	source: "rule",
	failureType: "type_error",
	command: "npm run build",
	exitCode: 1,
	primaryError: "TS2322",
	failingTests: [],
	diagnostics: [],
	evidence: [],
	suspectedFiles: ["src/foo.ts"],
	allowedFilesToEdit: ["src/foo.ts"],
	disallowedFiles: [],
	disallowedActions: ["Do not modify tests"],
	confidence: "high",
};

const intent: PatchIntent = {
	targetFiles: ["src/foo.ts"],
	changeType: "type_fix",
	reason: "fix type",
	expectedEffect: "build passes",
	failureEvidence: ["TS2322"],
	allowedOperations: ["adjust_type"],
	forbiddenOperations: ["Do not modify tests"],
	riskLevel: "low",
	maxChangedFiles: 1,
	maxChangedLines: 20,
};

describe("PatchIntent guard", () => {
	it("auto-approves low-risk source edits", () => {
		const review = reviewPatchIntent(intent, report, opts);
		expect(review.decision).toBe("auto_approve");
	});

	it("rejects targets outside allowedFilesToEdit", () => {
		const review = reviewPatchIntent(
			{ ...intent, targetFiles: ["src/bar.ts"] },
			report,
			opts,
		);
		expect(review.decision).toBe("reject");
		expect(review.violations.join("\n")).toContain(
			"outside allowedFilesToEdit",
		);
	});

	it("rejects test edits by default", () => {
		const testReport = { ...report, allowedFilesToEdit: ["tests/foo.test.ts"] };
		const review = reviewPatchIntent(
			{ ...intent, targetFiles: ["tests/foo.test.ts"] },
			testReport,
			opts,
		);
		expect(review.decision).toBe("reject");
		expect(review.violations.join("\n")).toContain(
			"Test file edits are disabled",
		);
	});

	it("rejects dangerous validation bypass patterns", () => {
		const review = reviewPatchIntent(
			{ ...intent, reason: "skip validation to make it pass" },
			report,
			opts,
		);
		expect(review.decision).toBe("reject");
	});
});
