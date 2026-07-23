import { describe, it, expect } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { applyProposedPatch } from "../src/core/patch/apply.js";
import type { PatchIntent, PatchOptions } from "../src/core/patch/types.js";

async function fixture() {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "msga-patch-"));
	await fs.mkdir(path.join(dir, "src"));
	await fs.writeFile(
		path.join(dir, "src/foo.ts"),
		"export const x = 1;\n",
		"utf-8",
	);
	return dir;
}

function opts(cwd: string, dryRun = false): PatchOptions {
	return {
		checks: ["npm test"],
		maxRounds: 3,
		dryRun,
		nonInteractive: true,
		json: false,
		allowTestEdits: false,
		allowConfigEdits: false,
		allowDependencyEdits: false,
		cwd,
		maxChangedFiles: 2,
		maxChangedLines: 40,
		saveTrace: false,
	};
}

const intent: PatchIntent = {
	targetFiles: ["src/foo.ts"],
	changeType: "bug_fix",
	reason: "fix",
	expectedEffect: "pass",
	failureEvidence: [],
	allowedOperations: ["edit_function"],
	forbiddenOperations: [],
	riskLevel: "low",
	maxChangedFiles: 1,
	maxChangedLines: 10,
};

describe("applyProposedPatch", () => {
	it("applies unique oldText replacement", async () => {
		const cwd = await fixture();
		const applied = await applyProposedPatch(
			{
				edits: [
					{
						file: "src/foo.ts",
						oldText: "export const x = 1;",
						newText: "export const x = 2;",
						reason: "fix",
					},
				],
			},
			intent,
			opts(cwd),
		);
		const content = await fs.readFile(path.join(cwd, "src/foo.ts"), "utf-8");
		expect(content).toContain("x = 2");
		expect(applied.changedFiles).toEqual(["src/foo.ts"]);
	});

	it("rejects missing oldText", async () => {
		const cwd = await fixture();
		await expect(
			applyProposedPatch(
				{
					edits: [
						{
							file: "src/foo.ts",
							oldText: "missing",
							newText: "new",
							reason: "fix",
						},
					],
				},
				intent,
				opts(cwd),
			),
		).rejects.toThrow(/oldText not found/);
	});

	it("does not write in dry-run mode", async () => {
		const cwd = await fixture();
		await applyProposedPatch(
			{
				edits: [
					{
						file: "src/foo.ts",
						oldText: "export const x = 1;",
						newText: "export const x = 2;",
						reason: "fix",
					},
				],
			},
			intent,
			opts(cwd, true),
		);
		const content = await fs.readFile(path.join(cwd, "src/foo.ts"), "utf-8");
		expect(content).toContain("x = 1");
	});

	it("rejects path traversal", async () => {
		const cwd = await fixture();
		await expect(
			applyProposedPatch(
				{
					edits: [
						{
							file: "../outside.ts",
							oldText: "x",
							newText: "y",
							reason: "bad",
						},
					],
				},
				{ ...intent, targetFiles: ["../outside.ts"] },
				opts(cwd),
			),
		).rejects.toThrow(/escapes working directory/);
	});
});
