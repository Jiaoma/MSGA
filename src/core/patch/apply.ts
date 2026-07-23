import fs from "node:fs/promises";
import {
	normalizeRelativePath,
	resolveInsideCwd,
	unique,
} from "./path-utils.js";
import type {
	AppliedPatch,
	PatchIntent,
	PatchOptions,
	ProposedPatch,
	Snapshot,
} from "./types.js";

export async function readTargetSnapshot(
	files: string[],
	cwd: string,
): Promise<Snapshot> {
	const snapshot: Snapshot = { files: new Map() };
	for (const file of unique(files.map((f) => normalizeRelativePath(f, cwd)))) {
		const resolved = resolveInsideCwd(file, cwd);
		if (!resolved) throw new Error(`Path escapes working directory: ${file}`);
		const content = await fs.readFile(resolved, "utf-8");
		snapshot.files.set(file, content);
	}
	return snapshot;
}

export async function applyProposedPatch(
	patch: ProposedPatch,
	intent: PatchIntent,
	opts: PatchOptions,
): Promise<AppliedPatch> {
	const targets = new Set(
		intent.targetFiles.map((f) => normalizeRelativePath(f, opts.cwd)),
	);
	const fileUpdates = new Map<string, { before: string; after: string }>();

	for (const edit of patch.edits) {
		const file = normalizeRelativePath(edit.file, opts.cwd);
		if (!targets.has(file))
			throw new Error(`Patch edit file is outside targetFiles: ${file}`);
		const resolved = resolveInsideCwd(file, opts.cwd);
		if (!resolved) throw new Error(`Path escapes working directory: ${file}`);

		const before =
			fileUpdates.get(file)?.after ?? (await fs.readFile(resolved, "utf-8"));
		const matches = countOccurrences(before, edit.oldText);
		if (matches === 0) throw new Error(`oldText not found in ${file}`);
		if (matches > 1) throw new Error(`oldText is not unique in ${file}`);
		if (edit.oldText === edit.newText)
			throw new Error(`newText is identical to oldText in ${file}`);

		const original = fileUpdates.get(file)?.before ?? before;
		fileUpdates.set(file, {
			before: original,
			after: before.replace(edit.oldText, edit.newText),
		});
	}

	const changedFiles = Array.from(fileUpdates.keys());
	if (
		changedFiles.length > opts.maxChangedFiles ||
		changedFiles.length > intent.maxChangedFiles
	) {
		throw new Error(
			`Patch changes ${changedFiles.length} files, above configured limit.`,
		);
	}

	let addedLines = 0;
	let deletedLines = 0;
	for (const { before, after } of fileUpdates.values()) {
		const counts = countChangedLines(before, after);
		addedLines += counts.added;
		deletedLines += counts.deleted;
	}
	const lineLimit = Math.min(
		intent.maxChangedLines ?? opts.maxChangedLines,
		opts.maxChangedLines,
	);
	if (addedLines + deletedLines > lineLimit) {
		throw new Error(
			`Patch changes ${addedLines + deletedLines} lines, above limit ${lineLimit}.`,
		);
	}

	if (!opts.dryRun) {
		const written: Array<{ file: string; before: string }> = [];
		try {
			for (const [file, update] of fileUpdates) {
				const resolved = resolveInsideCwd(file, opts.cwd);
				if (!resolved)
					throw new Error(`Path escapes working directory: ${file}`);
				await fs.writeFile(resolved, update.after, "utf-8");
				written.push({ file, before: update.before });
			}
		} catch (error) {
			for (const entry of written.reverse()) {
				const resolved = resolveInsideCwd(entry.file, opts.cwd);
				if (resolved) await fs.writeFile(resolved, entry.before, "utf-8");
			}
			throw error;
		}
	}

	return { changedFiles, addedLines, deletedLines, dryRun: opts.dryRun };
}

export function countChangedLines(
	before: string,
	after: string,
): { added: number; deleted: number } {
	const beforeLines = before.split("\n");
	const afterLines = after.split("\n");
	const lcs = longestCommonSubsequenceLength(beforeLines, afterLines);
	return {
		added: Math.max(0, afterLines.length - lcs),
		deleted: Math.max(0, beforeLines.length - lcs),
	};
}

function countOccurrences(haystack: string, needle: string): number {
	if (!needle) return 0;
	let count = 0;
	let index = 0;
	while (true) {
		const found = haystack.indexOf(needle, index);
		if (found === -1) return count;
		count += 1;
		index = found + needle.length;
	}
}

function longestCommonSubsequenceLength(a: string[], b: string[]): number {
	const previous = new Array(b.length + 1).fill(0);
	const current = new Array(b.length + 1).fill(0);
	for (let i = 1; i <= a.length; i++) {
		for (let j = 1; j <= b.length; j++) {
			current[j] =
				a[i - 1] === b[j - 1]
					? previous[j - 1] + 1
					: Math.max(previous[j], current[j - 1]);
		}
		for (let j = 0; j <= b.length; j++) previous[j] = current[j];
	}
	return previous[b.length];
}
