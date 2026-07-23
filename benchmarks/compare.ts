#!/usr/bin/env tsx
import fs from "node:fs/promises";
import path from "node:path";
import { buildSummary } from "./metrics.js";
import { runBaselineBenchmark } from "./runners/baseline.js";
import { runMsgaBenchmark } from "./runners/msga.js";
import type {
	BenchmarkResult,
	BenchmarkRunConfig,
	RunnerKind,
} from "./types.js";
import {
	ensureDir,
	listFixtures,
	prepareWorkspace,
	safeName,
} from "./workspace.js";

interface CliOptions {
	model: string;
	baseUrl: string;
	fixtures: string;
	runners: RunnerKind[];
	maxRounds: number;
	repeat: number;
	out: string;
	dryRunPlan: boolean;
}

async function main(): Promise<void> {
	const opts = parseArgs(process.argv.slice(2));
	const startedAt = new Date().toISOString();
	const runId = safeName(startedAt);
	const repoRoot = process.cwd();
	const fixtures = await listFixtures(
		path.join(repoRoot, "benchmarks", "fixtures"),
		opts.fixtures,
	);
	const runRoot = path.join(repoRoot, opts.out, runId);

	const matrix = [];
	for (const { fixture, path: fixturePath } of fixtures) {
		for (const runner of opts.runners) {
			for (let repeat = 1; repeat <= opts.repeat; repeat++) {
				matrix.push({ fixture, fixturePath, runner, repeat });
			}
		}
	}

	if (opts.dryRunPlan) {
		console.log(
			JSON.stringify(
				{
					model: opts.model,
					baseUrl: opts.baseUrl,
					runs: matrix.map((m) => ({
						fixture: m.fixture.id,
						runner: m.runner,
						repeat: m.repeat,
					})),
				},
				null,
				2,
			),
		);
		return;
	}

	await ensureDir(runRoot);
	const resultsPath = path.join(runRoot, "results.jsonl");
	const results: BenchmarkResult[] = [];
	const suiteStarted = Date.now();

	for (const item of matrix) {
		const workspace = await prepareWorkspace({
			runRoot,
			fixturePath: item.fixturePath,
			fixtureId: item.fixture.id,
			runner: item.runner,
			model: opts.model,
			repeat: item.repeat,
		});
		const config: BenchmarkRunConfig = {
			runner: item.runner,
			model: opts.model,
			baseUrl: opts.baseUrl,
			fixture: item.fixture,
			fixturePath: item.fixturePath,
			workspace,
			maxRounds: opts.maxRounds,
			allowTestEdits: false,
			allowConfigEdits: false,
			allowDependencyEdits: false,
		};
		console.error(`[bench] ${item.fixture.id} ${item.runner} ${opts.model}`);
		const result =
			item.runner === "msga"
				? await runMsgaBenchmark(config)
				: await runBaselineBenchmark(config);
		results.push(result);
		await fs.appendFile(resultsPath, `${JSON.stringify(result)}\n`, "utf-8");
	}

	const summary = buildSummary(
		runId,
		startedAt,
		Date.now() - suiteStarted,
		results,
		resultsPath,
	);
	await fs.writeFile(
		path.join(runRoot, "summary.json"),
		JSON.stringify(summary, null, 2),
		"utf-8",
	);
	console.log(JSON.stringify(summary, null, 2));
}

function parseArgs(args: string[]): CliOptions {
	const opts: CliOptions = {
		model: "qwen3:8b",
		baseUrl: "http://127.0.0.1:11434/v1",
		fixtures: "all",
		runners: ["msga", "baseline"],
		maxRounds: 3,
		repeat: 1,
		out: ".msga-bench/runs",
		dryRunPlan: false,
	};
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		const next = args[i + 1];
		if (arg === "--model" && next) opts.model = args[++i];
		else if (arg === "--base-url" && next) opts.baseUrl = args[++i];
		else if (arg === "--fixtures" && next) opts.fixtures = args[++i];
		else if (arg === "--runners" && next)
			opts.runners = args[++i]
				.split(",")
				.map((r) => r.trim())
				.filter(Boolean) as RunnerKind[];
		else if (arg === "--max-rounds" && next)
			opts.maxRounds = Number.parseInt(args[++i], 10);
		else if (arg === "--repeat" && next)
			opts.repeat = Number.parseInt(args[++i], 10);
		else if (arg === "--out" && next) opts.out = args[++i];
		else if (arg === "--dry-run-plan") opts.dryRunPlan = true;
	}
	return opts;
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
});
