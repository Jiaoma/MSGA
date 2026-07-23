import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { unique } from "./path-utils.js";
import type { ValidationResult } from "./types.js";

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_OUTPUT_BYTES = 96_000;

export async function resolveValidationCommands(opts: {
	explicitChecks?: string[];
	cwd: string;
}): Promise<string[]> {
	if (opts.explicitChecks && opts.explicitChecks.length > 0)
		return opts.explicitChecks;

	const packageJsonPath = path.join(opts.cwd, "package.json");
	try {
		const raw = await fs.readFile(packageJsonPath, "utf-8");
		const pkg = JSON.parse(raw) as {
			scripts?: Record<string, string>;
			dependencies?: Record<string, string>;
			devDependencies?: Record<string, string>;
		};
		const scripts = pkg.scripts || {};
		const commands: string[] = [];
		if (scripts.build) commands.push("npm run build");
		if (scripts.lint) commands.push("npm run lint");
		if (scripts.test) {
			const deps = {
				...(pkg.dependencies || {}),
				...(pkg.devDependencies || {}),
			};
			commands.push(deps.vitest ? "npx vitest run" : "npm test");
		}
		return commands.length > 0 ? commands : ["npm test"];
	} catch {
		return ["npm test"];
	}
}

export async function runValidation(
	commands: string[],
	opts: { cwd: string; timeoutMs?: number; maxOutputBytes?: number },
): Promise<ValidationResult[]> {
	const results: ValidationResult[] = [];
	for (const command of commands) {
		results.push(await runOneValidation(command, opts));
	}
	return results;
}

async function runOneValidation(
	command: string,
	opts: { cwd: string; timeoutMs?: number; maxOutputBytes?: number },
): Promise<ValidationResult> {
	const started = Date.now();
	const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const maxOutputBytes = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;

	return new Promise((resolve) => {
		const child = spawn(command, {
			cwd: opts.cwd,
			shell: true,
			env: process.env,
		});

		let stdout = "";
		let stderr = "";
		let timedOut = false;

		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGTERM");
		}, timeoutMs);

		child.stdout?.on("data", (chunk: Buffer) => {
			stdout = appendCapped(stdout, chunk.toString(), maxOutputBytes);
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			stderr = appendCapped(stderr, chunk.toString(), maxOutputBytes);
		});

		child.on("error", (error) => {
			clearTimeout(timer);
			const durationMs = Date.now() - started;
			const primaryError = error.message;
			resolve({
				command,
				success: false,
				exitCode: null,
				durationMs,
				stdoutSummary: summarizeText(stdout),
				stderrSummary: primaryError,
				rawStdout: stdout,
				rawStderr: stderr || primaryError,
				failingFiles: extractFilePaths(`${stdout}\n${stderr}\n${primaryError}`),
				failingTests: extractFailingTests(`${stdout}\n${stderr}`),
				primaryError,
			});
		});

		child.on("close", (code) => {
			clearTimeout(timer);
			const durationMs = Date.now() - started;
			const combined = `${stdout}\n${stderr}`;
			const primaryError = timedOut
				? `Command timed out after ${timeoutMs}ms`
				: extractPrimaryError(stdout, stderr, code ?? null);
			resolve({
				command,
				success: !timedOut && code === 0,
				exitCode: timedOut ? null : code,
				durationMs,
				stdoutSummary: summarizeText(stdout),
				stderrSummary: summarizeText(stderr),
				rawStdout: stdout,
				rawStderr: stderr,
				failingFiles: extractFilePaths(combined),
				failingTests: extractFailingTests(combined),
				primaryError,
			});
		});
	});
}

function appendCapped(current: string, next: string, maxBytes: number): string {
	const combined = current + next;
	if (Buffer.byteLength(combined) <= maxBytes) return combined;
	return combined.slice(Math.max(0, combined.length - maxBytes));
}

export function firstFailedOrLast(
	results: ValidationResult[],
): ValidationResult | undefined {
	return results.find((r) => !r.success) || results[results.length - 1];
}

export function allValidationsPassed(results: ValidationResult[]): boolean {
	return results.length > 0 && results.every((r) => r.success);
}

export function summarizeText(text: string, maxLines = 20): string {
	const lines = text
		.split(/\r?\n/)
		.map((l) => l.trimEnd())
		.filter(Boolean);
	if (lines.length <= maxLines) return lines.join("\n");
	return [...lines.slice(0, 8), "...", ...lines.slice(-12)].join("\n");
}

function extractPrimaryError(
	stdout: string,
	stderr: string,
	code: number | null,
): string {
	const lines = `${stderr}\n${stdout}`
		.split(/\r?\n/)
		.map((l) => l.trim())
		.filter(Boolean);
	const interesting = lines.find((line) =>
		/\berror\b|AssertionError|TypeError|ReferenceError|SyntaxError|FAIL\b|failed/i.test(
			line,
		),
	);
	return (
		interesting ||
		(code === 0 ? "Validation passed" : `Command failed with exit code ${code}`)
	);
}

export function extractFilePaths(text: string): string[] {
	const files: string[] = [];
	const patterns = [
		/(?:^|\s)((?:src|tests|test|lib|app|packages)\/[^\s:)]+\.[cm]?[tj]sx?)(?::\d+)?(?::\d+)?/gm,
		/(?:^|\s)((?:src|tests|test|lib|app|packages)\/[^\s:)]+\.(?:json|md|yaml|yml))/gm,
		/([\w./-]+\.[cm]?[tj]sx?)\((\d+),(\d+)\):\s*error\s+TS\d+/g,
	];
	for (const pattern of patterns) {
		for (const match of text.matchAll(pattern)) {
			if (match[1]) files.push(match[1].replace(/^\.\//, ""));
		}
	}
	return unique(files);
}

export function extractFailingTests(text: string): string[] {
	const tests: string[] = [];
	for (const line of text.split(/\r?\n/)) {
		const vitest = line.match(/(?:FAIL|×|✗)\s+(.+?)(?:\s+>\s+(.+))?$/);
		if (vitest)
			tests.push(vitest[2] ? `${vitest[1]} > ${vitest[2]}` : vitest[1]);
	}
	return unique(tests);
}
