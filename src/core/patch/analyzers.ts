import fs from "node:fs/promises";
import path from "node:path";
import {
	filterEditableFiles,
	isSourceLikeFile,
	normalizeRelativePath,
	resolveInsideCwd,
	unique,
} from "./path-utils.js";
import type {
	Confidence,
	Diagnostic,
	FailingTest,
	FailureEvidence,
	FailureReport,
	ValidationResult,
} from "./types.js";

export interface AnalyzeContext {
	cwd: string;
	goal?: string;
	allowTestEdits: boolean;
	allowConfigEdits: boolean;
	allowDependencyEdits: boolean;
}

interface AnalysisParts {
	failureType?: FailureReport["failureType"];
	diagnostics: Diagnostic[];
	failingTests: FailingTest[];
	evidence: FailureEvidence[];
	suspectedFiles: string[];
	primaryError?: string;
	confidence?: Confidence;
}

export async function buildFailureReport(
	validation: ValidationResult,
	ctx: AnalyzeContext,
): Promise<FailureReport> {
	const parts: AnalysisParts = {
		diagnostics: [],
		failingTests: [],
		evidence: [],
		suspectedFiles: [],
	};

	mergeParts(parts, analyzeTypeScript(validation, ctx));
	mergeParts(parts, analyzeVitest(validation, ctx));
	mergeParts(parts, analyzeLint(validation, ctx));
	mergeParts(parts, analyzeNpm(validation, ctx));
	mergeParts(parts, analyzeStackTrace(validation, ctx));

	const inferredSourceFiles = await inferSourceFilesFromTests(
		parts.failingTests,
		ctx,
	);
	const suspected = unique([
		...parts.suspectedFiles,
		...inferredSourceFiles,
		...validation.failingFiles.map((f) => normalizeRelativePath(f, ctx.cwd)),
	]).filter(Boolean);
	const { allowed, disallowed } = filterEditableFiles(suspected, ctx);
	const sourceAllowed = allowed.filter(isSourceLikeFile);
	const allowedFilesToEdit = sourceAllowed.length > 0 ? sourceAllowed : allowed;
	const confidence =
		parts.confidence || inferConfidence(parts, allowedFilesToEdit);

	return {
		source: "rule",
		failureType: parts.failureType || inferFailureType(validation),
		command: validation.command,
		exitCode: validation.exitCode,
		primaryError: parts.primaryError || validation.primaryError,
		failingTests: uniqueFailingTests(parts.failingTests),
		diagnostics: uniqueDiagnostics(parts.diagnostics),
		evidence: parts.evidence.slice(0, 12),
		suspectedFiles: suspected,
		allowedFilesToEdit: unique(allowedFilesToEdit),
		disallowedFiles: unique(disallowed),
		disallowedActions: defaultDisallowedActions(ctx),
		confidence,
	};
}

function analyzeTypeScript(
	validation: ValidationResult,
	ctx: AnalyzeContext,
): Partial<AnalysisParts> {
	const text = `${validation.rawStdout || ""}\n${validation.rawStderr || ""}`;
	const diagnostics: Diagnostic[] = [];
	const suspectedFiles: string[] = [];
	const evidence: FailureEvidence[] = [];
	const regex =
		/([^\s()]+\.[cm]?[tj]sx?)\((\d+),(\d+)\):\s*error\s+(TS\d+):\s*(.+)/g;
	for (const match of text.matchAll(regex)) {
		const file = normalizeRelativePath(match[1], ctx.cwd);
		const line = Number.parseInt(match[2], 10);
		const column = Number.parseInt(match[3], 10);
		const code = match[4];
		const message = match[5];
		diagnostics.push({
			file,
			line,
			column,
			code,
			message,
			source: "typescript",
		});
		suspectedFiles.push(file);
		evidence.push({
			kind: "diagnostic",
			text: `${file}(${line},${column}): ${code}: ${message}`,
		});
	}
	if (diagnostics.length === 0) return {};
	return {
		failureType: "type_error",
		diagnostics,
		suspectedFiles,
		evidence,
		primaryError: evidence[0]?.text,
		confidence: "high",
	};
}

function analyzeVitest(
	validation: ValidationResult,
	ctx: AnalyzeContext,
): Partial<AnalysisParts> {
	const text = `${validation.rawStdout || ""}\n${validation.rawStderr || ""}`;
	const failingTests: FailingTest[] = [];
	const suspectedFiles: string[] = [];
	const evidence: FailureEvidence[] = [];

	for (const line of text.split(/\r?\n/)) {
		const fail = line.match(/^\s*FAIL\s+([^>\n]+?)(?:\s*>\s*(.+))?\s*$/);
		if (fail) {
			const file = normalizeRelativePath(fail[1].trim(), ctx.cwd);
			const name = (fail[2] || file).trim();
			failingTests.push({ file, name });
			suspectedFiles.push(file);
			evidence.push({ kind: "test", text: line.trim() });
		}
		const assertion = line.match(
			/AssertionError|TypeError|ReferenceError|SyntaxError/,
		);
		if (assertion) evidence.push({ kind: "stderr", text: line.trim() });
	}

	if (failingTests.length === 0 && !/vitest|FAIL\s+/i.test(text)) return {};

	return {
		failureType: "test_failure",
		failingTests,
		suspectedFiles,
		evidence,
		primaryError:
			evidence.find((e) => e.kind === "stderr")?.text ||
			validation.primaryError,
		confidence: failingTests.length > 0 ? "medium" : undefined,
	};
}

function analyzeLint(
	validation: ValidationResult,
	ctx: AnalyzeContext,
): Partial<AnalysisParts> {
	const text = `${validation.rawStdout || ""}\n${validation.rawStderr || ""}`;
	if (!/biome|eslint|lint/i.test(validation.command + text)) return {};
	const diagnostics: Diagnostic[] = [];
	const suspectedFiles: string[] = [];
	for (const line of text.split(/\r?\n/)) {
		const match = line.match(
			/((?:src|lib|app|packages)\/[^\s:]+\.[cm]?[tj]sx?):(\d+):(\d+)\s+(.+)/,
		);
		if (match) {
			const file = normalizeRelativePath(match[1], ctx.cwd);
			diagnostics.push({
				file,
				line: Number.parseInt(match[2], 10),
				column: Number.parseInt(match[3], 10),
				message: match[4],
				source: /biome/i.test(text) ? "biome" : "eslint",
			});
			suspectedFiles.push(file);
		}
	}
	if (diagnostics.length === 0) return {};
	return {
		failureType: "lint_error",
		diagnostics,
		suspectedFiles,
		confidence: "high",
	};
}

function analyzeNpm(
	validation: ValidationResult,
	_ctx: AnalyzeContext,
): Partial<AnalysisParts> {
	const text = `${validation.rawStdout || ""}\n${validation.rawStderr || ""}`;
	if (!/npm ERR!|Missing script|command not found/i.test(text)) return {};
	return {
		failureType: "command_error",
		evidence: [{ kind: "stderr", text: validation.primaryError }],
		primaryError: validation.primaryError,
		confidence: "low",
	};
}

function analyzeStackTrace(
	validation: ValidationResult,
	ctx: AnalyzeContext,
): Partial<AnalysisParts> {
	const text = `${validation.rawStdout || ""}\n${validation.rawStderr || ""}`;
	const diagnostics: Diagnostic[] = [];
	const suspectedFiles: string[] = [];
	const evidence: FailureEvidence[] = [];
	const regex =
		/(?:at\s+.+?\()?((?:\/?[\w.-]+\/)*(?:src|tests|test|lib|app|packages)\/[^:)]+\.[cm]?[tj]sx?):(\d+):(\d+)\)?/g;
	for (const match of text.matchAll(regex)) {
		const file = normalizeRelativePath(match[1], ctx.cwd);
		const line = Number.parseInt(match[2], 10);
		const column = Number.parseInt(match[3], 10);
		diagnostics.push({
			file,
			line,
			column,
			message: "Stack trace frame",
			source: "node",
		});
		suspectedFiles.push(file);
		evidence.push({ kind: "stack", text: `${file}:${line}:${column}` });
	}
	if (diagnostics.length === 0) return {};
	return {
		failureType: /FAIL|AssertionError/i.test(text)
			? "test_failure"
			: "runtime_error",
		diagnostics,
		suspectedFiles,
		evidence,
		confidence: suspectedFiles.some(isSourceLikeFile) ? "high" : "medium",
	};
}

async function inferSourceFilesFromTests(
	failingTests: FailingTest[],
	ctx: AnalyzeContext,
): Promise<string[]> {
	if (failingTests.length === 0) return [];
	const inferred: string[] = [];
	for (const test of failingTests) {
		if (!test.file) continue;
		const resolved = resolveInsideCwd(test.file, ctx.cwd);
		if (!resolved) continue;
		let content: string;
		try {
			content = await fs.readFile(resolved, "utf-8");
		} catch {
			continue;
		}
		const imported = extractRelativeImports(content);
		for (const specifier of imported) {
			const candidate = await resolveImportSpecifier(
				resolved,
				specifier,
				ctx.cwd,
			);
			if (candidate && isSourceLikeFile(candidate)) inferred.push(candidate);
		}
	}
	return unique(inferred);
}

function extractRelativeImports(content: string): string[] {
	const imports: string[] = [];
	const regex =
		/(?:import\s+(?:[^"']+?\s+from\s+)?|export\s+[^"']+?\s+from\s+|import\s*\()(["'])(\.\.?\/[^"']+)\1/g;
	for (const match of content.matchAll(regex)) {
		if (match[2]) imports.push(match[2]);
	}
	return unique(imports);
}

async function resolveImportSpecifier(
	importer: string,
	specifier: string,
	cwd: string,
): Promise<string | null> {
	const base = path.resolve(path.dirname(importer), specifier);
	const withoutJsExtension = base.replace(/\.(?:mjs|cjs|js|jsx)$/, "");
	const candidates = unique([
		base,
		withoutJsExtension,
		`${withoutJsExtension}.ts`,
		`${withoutJsExtension}.tsx`,
		`${withoutJsExtension}.mts`,
		`${withoutJsExtension}.cts`,
		`${withoutJsExtension}.js`,
		`${withoutJsExtension}.jsx`,
		`${withoutJsExtension}.mjs`,
		`${withoutJsExtension}.cjs`,
		path.join(base, "index.ts"),
		path.join(base, "index.tsx"),
		path.join(base, "index.js"),
	]);
	for (const candidate of candidates) {
		const relative = normalizeRelativePath(candidate, cwd);
		const resolved = resolveInsideCwd(relative, cwd);
		if (!resolved) continue;
		try {
			const stat = await fs.stat(resolved);
			if (stat.isFile()) return relative;
		} catch {
			// try next candidate
		}
	}
	return null;
}

function mergeParts(
	target: AnalysisParts,
	source: Partial<AnalysisParts>,
): void {
	if (!source || Object.keys(source).length === 0) return;
	target.failureType ||= source.failureType;
	target.primaryError ||= source.primaryError;
	target.confidence = higherConfidence(target.confidence, source.confidence);
	target.diagnostics.push(...(source.diagnostics || []));
	target.failingTests.push(...(source.failingTests || []));
	target.evidence.push(...(source.evidence || []));
	target.suspectedFiles.push(...(source.suspectedFiles || []));
}

function higherConfidence(
	a?: Confidence,
	b?: Confidence,
): Confidence | undefined {
	const order: Confidence[] = ["low", "medium", "high"];
	if (!a) return b;
	if (!b) return a;
	return order.indexOf(b) > order.indexOf(a) ? b : a;
}

function inferFailureType(
	validation: ValidationResult,
): FailureReport["failureType"] {
	if (/build|tsc/i.test(validation.command)) return "build_error";
	if (/test|vitest|jest/i.test(validation.command)) return "test_failure";
	if (/lint|biome|eslint/i.test(validation.command)) return "lint_error";
	return "unknown";
}

function inferConfidence(
	parts: AnalysisParts,
	allowedFiles: string[],
): Confidence {
	if (allowedFiles.length === 1 && parts.diagnostics.length > 0) return "high";
	if (allowedFiles.length > 0 && allowedFiles.length <= 3) return "medium";
	return "low";
}

function uniqueDiagnostics(diagnostics: Diagnostic[]): Diagnostic[] {
	const seen = new Set<string>();
	return diagnostics.filter((d) => {
		const key = `${d.source}:${d.file}:${d.line}:${d.column}:${d.code}:${d.message}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

function uniqueFailingTests(tests: FailingTest[]): FailingTest[] {
	const seen = new Set<string>();
	return tests.filter((t) => {
		const key = `${t.file}:${t.line}:${t.name}:${t.message}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

function defaultDisallowedActions(ctx: AnalyzeContext): string[] {
	const actions = [
		"Do not bypass validation",
		"Do not perform broad refactors",
	];
	if (!ctx.allowTestEdits) actions.push("Do not modify tests");
	if (!ctx.allowConfigEdits) actions.push("Do not modify config files");
	if (!ctx.allowDependencyEdits)
		actions.push("Do not modify dependencies or lockfiles");
	return actions;
}
