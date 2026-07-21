import { describe, it, expect } from "vitest";
import { checkRegression } from "../src/core/patch/guards.js";
import type {
	AppliedPatch,
	ValidationResult,
} from "../src/core/patch/types.js";

const validation = (
	overrides: Partial<ValidationResult>,
): ValidationResult => ({
	command: "npm test",
	success: false,
	exitCode: 1,
	durationMs: 10,
	stdoutSummary: "",
	stderrSummary: "",
	failingFiles: [],
	failingTests: [],
	primaryError: "error A",
	...overrides,
});

const applied: AppliedPatch = {
	changedFiles: ["src/foo.ts"],
	addedLines: 1,
	deletedLines: 1,
	dryRun: false,
};

describe("regression guard", () => {
	it("marks passing validation as improved", () => {
		const result = checkRegression(
			validation({ primaryError: "error A" }),
			validation({
				success: true,
				exitCode: 0,
				primaryError: "Validation passed",
			}),
			applied,
		);
		expect(result.verdict).toBe("improved");
	});

	it("marks new failures as regressed", () => {
		const result = checkRegression(
			validation({ failingTests: ["test A"], primaryError: "error A" }),
			validation({
				failingTests: ["test A", "test B"],
				primaryError: "error B",
			}),
			applied,
		);
		expect(result.verdict).toBe("regressed");
	});

	it("marks same primary error as unchanged", () => {
		const result = checkRegression(
			validation({ primaryError: "error A" }),
			validation({ primaryError: "error A" }),
			applied,
		);
		expect(result.verdict).toBe("unchanged");
	});

	it("marks fewer failures as improved", () => {
		const result = checkRegression(
			validation({
				failingTests: ["test A", "test B"],
				primaryError: "error A",
			}),
			validation({ failingTests: ["test A"], primaryError: "error A" }),
			applied,
		);
		expect(result.verdict).toBe("improved");
	});
});
