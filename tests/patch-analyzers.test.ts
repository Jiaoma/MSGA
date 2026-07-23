import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
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

async function withTempRepo<T>(fn: (cwd: string) => Promise<T>): Promise<T> {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "msga-analyzers-"));
	try {
		await fs.mkdir(path.join(cwd, "src"), { recursive: true });
		await fs.mkdir(path.join(cwd, "tests"), { recursive: true });
		return await fn(cwd);
	} finally {
		await fs.rm(cwd, { recursive: true, force: true });
	}
}

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

	it("infers editable source files imported by failing tests", async () => {
		await withTempRepo(async (cwd) => {
			await fs.writeFile(
				path.join(cwd, "src/calc.ts"),
				"export function clamp() { return 0; }\n",
			);
			await fs.writeFile(
				path.join(cwd, "tests/calc.test.ts"),
				'import { clamp } from "../src/calc.js";\n',
			);

			const report = await buildFailureReport(
				base({
					command: "npx vitest run",
					rawStdout:
						"FAIL tests/calc.test.ts > clamp > uses max\nAssertionError: expected +0 to be 10",
					primaryError: "AssertionError: expected +0 to be 10",
				}),
				{ ...ctx, cwd },
			);

			expect(report.disallowedFiles).toContain("tests/calc.test.ts");
			expect(report.allowedFilesToEdit).toContain("src/calc.ts");
			expect(report.confidence).toBe("medium");
		});
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
