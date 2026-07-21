import { describe, it, expect } from "vitest";
import { buildFailureReport } from "../src/core/patch/analyzers.js";
import type { ValidationResult } from "../src/core/patch/types.js";

const base = (overrides: Partial<ValidationResult>): ValidationResult => ({
	command: "npm run build",
	success: false,
	exitCode: 1,
	durationMs: 10,
	stdoutSummary: "",
	stderrSummary: "",
	rawStdout: "",
	rawStderr: "",
	failingFiles: [],
	failingTests: [],
	primaryError: "failed",
	...overrides,
});

const ctx = {
	cwd: process.cwd(),
	allowTestEdits: false,
	allowConfigEdits: false,
	allowDependencyEdits: false,
};

describe("patch failure analyzers", () => {
	it("extracts TypeScript diagnostics as high confidence source edits", async () => {
		const report = await buildFailureReport(
			base({
				rawStderr:
					"src/foo.ts(10,5): error TS2322: Type 'string' is not assignable to type 'number'.",
				primaryError: "TS2322",
			}),
			ctx,
		);
		expect(report.failureType).toBe("type_error");
		expect(report.confidence).toBe("high");
		expect(report.allowedFilesToEdit).toContain("src/foo.ts");
		expect(report.diagnostics[0].code).toBe("TS2322");
	});

	it("excludes test files but allows source stack frames for Vitest failures", async () => {
		const report = await buildFailureReport(
			base({
				command: "npx vitest run",
				rawStdout:
					"FAIL tests/foo.test.ts > Foo > works\nAssertionError: expected false to be true\n    at Foo.run (src/foo.ts:12:3)",
				primaryError: "AssertionError: expected false to be true",
			}),
			ctx,
		);
		expect(report.failureType).toBe("test_failure");
		expect(report.disallowedFiles).toContain("tests/foo.test.ts");
		expect(report.allowedFilesToEdit).toContain("src/foo.ts");
		expect(report.confidence).toBe("high");
	});

	it("treats missing npm scripts as low confidence command errors", async () => {
		const report = await buildFailureReport(
			base({
				rawStderr: 'npm ERR! Missing script: "test"',
				primaryError: 'npm ERR! Missing script: "test"',
			}),
			ctx,
		);
		expect(report.failureType).toBe("command_error");
		expect(report.confidence).toBe("low");
		expect(report.allowedFilesToEdit).toEqual([]);
	});
});
