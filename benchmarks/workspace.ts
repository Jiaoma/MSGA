import fs from "node:fs/promises";
import path from "node:path";
import type { BenchmarkFixture, RunnerKind } from "./types.js";

export function safeName(value: string): string {
	return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
}

export async function loadFixture(
	fixtureDir: string,
): Promise<BenchmarkFixture> {
	const manifestPath = path.join(fixtureDir, "fixture.json");
	let raw: string;
	try {
		raw = await fs.readFile(manifestPath, "utf-8");
	} catch (error) {
		throw new Error(
			`Unable to read fixture manifest at ${manifestPath}: ${errorMessage(error)}`,
		);
	}
	const parsed = JSON.parse(raw) as Partial<BenchmarkFixture>;
	if (
		!parsed.id ||
		!parsed.name ||
		!parsed.goal ||
		!Array.isArray(parsed.checks)
	) {
		throw new Error(`Invalid fixture manifest: ${manifestPath}`);
	}
	return {
		id: parsed.id,
		name: parsed.name,
		description: parsed.description || parsed.name,
		goal: parsed.goal,
		checks: parsed.checks,
		expectedChangedFiles: parsed.expectedChangedFiles || [],
		tags: parsed.tags || [],
		timeoutMs: parsed.timeoutMs,
	};
}

export async function listFixtures(
	fixturesRoot: string,
	selection: string,
): Promise<Array<{ fixture: BenchmarkFixture; path: string }>> {
	const entries = await fs.readdir(fixturesRoot, { withFileTypes: true });
	const wanted =
		selection === "all"
			? null
			: new Set(
					selection
						.split(",")
						.map((s) => s.trim())
						.filter(Boolean),
				);
	const fixtures: Array<{ fixture: BenchmarkFixture; path: string }> = [];
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		if (wanted && !wanted.has(entry.name)) continue;
		const fixturePath = path.join(fixturesRoot, entry.name);
		fixtures.push({
			fixture: await loadFixture(fixturePath),
			path: fixturePath,
		});
	}
	if (fixtures.length === 0)
		throw new Error(`No fixtures matched selection: ${selection}`);
	return fixtures;
}

export async function prepareWorkspace(opts: {
	runRoot: string;
	fixturePath: string;
	fixtureId: string;
	runner: RunnerKind;
	model: string;
	repeat: number;
}): Promise<string> {
	const workspace = path.join(
		opts.runRoot,
		opts.fixtureId,
		opts.runner,
		safeName(opts.model),
		`repeat-${opts.repeat}`,
	);
	await fs.rm(workspace, { recursive: true, force: true });
	await fs.mkdir(path.dirname(workspace), { recursive: true });
	await fs.cp(path.join(opts.fixturePath, "repo"), workspace, {
		recursive: true,
	});
	return workspace;
}

export async function ensureDir(dir: string): Promise<void> {
	await fs.mkdir(dir, { recursive: true });
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
