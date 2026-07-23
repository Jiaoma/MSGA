import { describe, it, expect } from "vitest";
import {
	parsePatchIntent,
	parseProposedPatch,
} from "../src/core/patch/schemas.js";

describe("patch schemas", () => {
	it("parses a valid PatchIntent", () => {
		const result = parsePatchIntent(
			JSON.stringify({
				targetFiles: ["src/foo.ts"],
				changeType: "bug_fix",
				reason: "fix parser",
				expectedEffect: "test passes",
				failureEvidence: ["AssertionError"],
				allowedOperations: ["edit_function"],
				forbiddenOperations: ["Do not modify tests"],
				riskLevel: "low",
				maxChangedFiles: 1,
				maxChangedLines: 20,
			}),
		);
		expect(result.valid).toBe(true);
		expect(result.data?.targetFiles).toEqual(["src/foo.ts"]);
	});

	it("repairs fenced JSON for PatchIntent", () => {
		const raw =
			'```json\n{"targetFiles":["src/foo.ts"],"changeType":"bug_fix","reason":"x","expectedEffect":"y","failureEvidence":[],"allowedOperations":["edit_function"],"forbiddenOperations":[],"riskLevel":"low","maxChangedFiles":1,}\n```';
		const result = parsePatchIntent(raw);
		expect(result.valid).toBe(true);
	});

	it("rejects invalid operations", () => {
		const result = parsePatchIntent(
			JSON.stringify({
				targetFiles: ["src/foo.ts"],
				changeType: "bug_fix",
				reason: "fix parser",
				expectedEffect: "test passes",
				failureEvidence: [],
				allowedOperations: ["delete_everything"],
				forbiddenOperations: [],
				riskLevel: "low",
				maxChangedFiles: 1,
			}),
		);
		expect(result.valid).toBe(false);
	});

	it("parses ProposedPatch", () => {
		const result = parseProposedPatch(
			JSON.stringify({
				edits: [
					{ file: "src/foo.ts", oldText: "old", newText: "new", reason: "fix" },
				],
			}),
		);
		expect(result.valid).toBe(true);
		expect(result.data?.edits[0].file).toBe("src/foo.ts");
	});
});
