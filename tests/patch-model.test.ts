import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { reviewPatchIntent } from "../src/core/patch/guards.js";
import {
	requestPatchIntent,
	requestProposedPatch,
} from "../src/core/patch/model.js";
import type { FailureReport, PatchOptions } from "../src/core/patch/types.js";
import type {
	ChatOptions,
	ChatResponse,
	ChatStreamChunk,
	Message,
	ModelProvider,
	ProviderConfig,
	ToolDefinition,
} from "../src/models/provider.js";

const opts: PatchOptions = {
	checks: ["npm test"],
	maxRounds: 3,
	dryRun: false,
	nonInteractive: true,
	json: false,
	allowTestEdits: false,
	allowConfigEdits: false,
	allowDependencyEdits: false,
	cwd: process.cwd(),
	maxChangedFiles: 2,
	maxChangedLines: 40,
	saveTrace: false,
};

const report: FailureReport = {
	source: "rule",
	failureType: "test_failure",
	command: "npm test",
	exitCode: 1,
	primaryError: "AssertionError",
	failingTests: [],
	diagnostics: [],
	evidence: [],
	suspectedFiles: ["src/foo.ts"],
	allowedFilesToEdit: ["src/foo.ts", "src/bar.ts", "src/baz.ts"],
	disallowedFiles: [],
	disallowedActions: ["Do not modify tests"],
	confidence: "high",
};

class FakeProvider implements ModelProvider {
	readonly config: ProviderConfig = {
		id: "fake",
		baseUrl: "http://example.test",
		model: "fake",
		maxTokens: 128,
		temperature: 0,
		contextWindow: 4096,
	};
	lastMessages: Message[] = [];
	lastOptions: ChatOptions | undefined;

	constructor(private readonly content: string) {}

	async chat(
		messages: Message[],
		_tools?: ToolDefinition[],
		options?: ChatOptions,
	): Promise<ChatResponse> {
		this.lastMessages = messages;
		this.lastOptions = options;
		return {
			content: this.content,
			toolCalls: [],
			usage: { inputTokens: 0, outputTokens: 0 },
			finishReason: "stop",
		};
	}

	async *chatStream(
		_messages: Message[],
		_tools?: ToolDefinition[],
	): AsyncIterable<ChatStreamChunk> {
		yield { type: "done", finishReason: "stop" };
	}
}

function intentJson(overrides: Record<string, unknown> = {}): string {
	return JSON.stringify({
		targetFiles: ["src/foo.ts"],
		changeType: "bug_fix",
		reason: "fix clamp",
		expectedEffect: "test passes",
		failureEvidence: ["AssertionError"],
		allowedOperations: ["edit_function"],
		forbiddenOperations: ["Do not modify tests"],
		riskLevel: "low",
		maxChangedLines: 20,
		...overrides,
	});
}

async function withTempRepo<T>(fn: (cwd: string) => Promise<T>): Promise<T> {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "msga-patch-model-"));
	try {
		await fs.mkdir(path.join(cwd, "src"), { recursive: true });
		await fs.writeFile(
			path.join(cwd, "src/foo.ts"),
			"export function clamp(value: number, min: number, max: number): number {\n\tif (value > max) return min;\n\treturn value;\n}\n",
		);
		return await fn(cwd);
	} finally {
		await fs.rm(cwd, { recursive: true, force: true });
	}
}

describe("patch model intent normalization", () => {
	it("defaults missing maxChangedFiles to one target file", async () => {
		const intent = await requestPatchIntent(
			report,
			new FakeProvider(intentJson()),
			opts,
		);

		expect(intent.maxChangedFiles).toBe(1);
	});

	it("caps missing maxChangedFiles by configured limit", async () => {
		const intent = await requestPatchIntent(
			report,
			new FakeProvider(
				intentJson({
					targetFiles: ["src/foo.ts", "src/bar.ts", "src/baz.ts"],
				}),
			),
			opts,
		);
		const review = reviewPatchIntent(intent, report, opts);

		expect(intent.maxChangedFiles).toBe(2);
		expect(review.decision).toBe("reject");
	});

	it("clamps model-provided maxChangedFiles to configured limit", async () => {
		const intent = await requestPatchIntent(
			report,
			new FakeProvider(intentJson({ maxChangedFiles: 99 })),
			opts,
		);

		expect(intent.maxChangedFiles).toBe(2);
	});

	it("falls back safely for invalid maxChangedFiles", async () => {
		const intent = await requestPatchIntent(
			report,
			new FakeProvider(intentJson({ maxChangedFiles: 0 })),
			opts,
		);

		expect(intent.maxChangedFiles).toBe(1);
	});

	it("clamps model-provided maxChangedLines to configured limit", async () => {
		const intent = await requestPatchIntent(
			report,
			new FakeProvider(intentJson({ maxChangedFiles: 1, maxChangedLines: 99 })),
			opts,
		);

		expect(intent.maxChangedLines).toBe(40);
	});
});

describe("patch model proposal generation", () => {
	it("caps ProposedPatch output tokens and prompts for compact JSON", async () => {
		await withTempRepo(async (cwd) => {
			const provider = new FakeProvider(
				JSON.stringify({
					edits: [
						{
							file: "src/foo.ts",
							oldText: "if (value > max) return min;",
							newText: "if (value > max) return max;",
							reason: "fix upper clamp",
						},
					],
				}),
			);
			await requestProposedPatch(
				report,
				{
					targetFiles: ["src/foo.ts"],
					changeType: "bug_fix",
					reason: "fix clamp",
					expectedEffect: "test passes",
					failureEvidence: ["AssertionError"],
					allowedOperations: ["edit_function"],
					forbiddenOperations: ["Do not modify tests"],
					riskLevel: "low",
					maxChangedFiles: 1,
					maxChangedLines: 20,
				},
				provider,
				{ ...opts, cwd },
			);

			expect(provider.lastOptions).toEqual({
				maxTokens: 512,
				responseFormat: "json_object",
			});
			expect(provider.lastMessages[0]?.content).toContain(
				"Return ONLY compact JSON",
			);
			expect(provider.lastMessages[0]?.content).toContain(
				"under 1200 characters",
			);
			expect(provider.lastMessages[1]?.content).toContain(
				"Return only a single compact JSON object",
			);
		});
	});
});
