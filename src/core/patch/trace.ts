import fs from "node:fs/promises";
import path from "node:path";
import type { PatchTrace, ValidationResult } from "./types.js";

export async function savePatchTrace(
	trace: PatchTrace,
	cwd: string,
): Promise<string> {
	const traceDir = path.join(cwd, ".msga", "traces");
	await fs.mkdir(traceDir, { recursive: true });
	const file = path.join(
		traceDir,
		`patch-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
	);
	const sanitized = sanitizeTrace(trace);
	await fs.writeFile(file, JSON.stringify(sanitized, null, 2), "utf-8");
	return file;
}

export function sanitizeTrace(trace: PatchTrace): PatchTrace {
	return {
		...trace,
		baselineValidation: trace.baselineValidation.map(sanitizeValidation),
		iterations: trace.iterations.map((iteration) => ({
			...iteration,
			validationResult: iteration.validationResult
				? sanitizeValidation(iteration.validationResult)
				: undefined,
			validationAfterPatch: iteration.validationAfterPatch
				? sanitizeValidation(iteration.validationAfterPatch)
				: undefined,
			proposedPatch: iteration.proposedPatch
				? {
						edits: iteration.proposedPatch.edits.map((edit) => ({
							file: edit.file,
							reason: edit.reason,
							oldText: `[${edit.oldText.length} chars omitted]`,
							newText: `[${edit.newText.length} chars omitted]`,
						})),
					}
				: undefined,
		})),
	};
}

function sanitizeValidation(result: ValidationResult): ValidationResult {
	return {
		...result,
		rawStdout: result.rawStdout ? truncate(result.rawStdout) : undefined,
		rawStderr: result.rawStderr ? truncate(result.rawStderr) : undefined,
	};
}

function truncate(text: string, max = 4000): string {
	if (text.length <= max) return text;
	return `${text.slice(0, 1500)}\n...\n${text.slice(-1500)}`;
}
