/**
 * MSGA Execution Engine
 * Core loop: user input → model call → tool execution → validation → response
 *
 * Key differences from Claude Code:
 * 1. Output validation layer auto-fixes format errors
 * 2. Context is rebuilt per turn (not accumulated)
 * 3. Tool results are compressed before injection
 * 4. Max 5 tool call rounds per task (prevents runaway)
 */

import type { z } from "zod";
import type { Message } from "../context/manager.js";
import { ContextManager, type DEFAULT_BUDGET } from "../context/manager.js";
import type { ModelProvider } from "../models/provider.js";
import type { ToolCall } from "../models/provider.js";
import type { ToolDefinition } from "../models/provider.js";
import type { ModelRegistry } from "../models/registry.js";
import { ALL_TOOLS, zodToJsonSchema } from "../tools/index.js";
import { analyzeTask } from "./adaptive-tools.js";
import { ParallelExecutor } from "./parallel-executor.js";
import { Planner } from "./planner.js";
import type { AtomResult, Plan } from "./planner.js";
import { validateToolCall } from "./validator.js";

const SYSTEM_PROMPT = `You are MSGA, an expert coding assistant. You MUST use tools to complete tasks. NEVER output code in text.

WORKFLOW:
1. READ existing files first (read_file / search_code)
2. WRITE or EDIT files (write_file / add_function / edit_function)
3. RUN commands to verify (bash)
4. REPEAT until task is done

TOOL USAGE:
- write_file(path="f", content="...")  — create or overwrite a file
- read_file(path="f")                — read a file
- bash(command="...", timeout=30)   — run a shell command
- search_code(pattern="X", scope=".") — search in files
- run_test_file(file="tests/x.test.ts") — run tests

CORRECT: write_file(path="hello.py", content="print('hello')")
WRONG:  \`\`\`python\nprint('hello')\n\`\`\` ← NEVER output code in text

Always use tools. Only output plain text when no tool is needed.`;

const MAX_TOOL_ROUNDS = 10;

export interface EngineConfig {
	provider: ModelProvider;
	budget?: typeof DEFAULT_BUDGET;
	systemPrompt?: string;
	maxToolRounds?: number;
	workingDir?: string;
	onContent?: (chunk: string) => void;
	onToolCall?: (name: string, args: unknown) => void;
	onToolResult?: (name: string, result: unknown) => void;
}

export class ExecutionEngine {
	private ctx: ContextManager;
	private provider: ModelProvider;
	private systemPrompt: string;
	private maxToolRounds: number;
	private workingDir: string;
	private callbacks: EngineConfig;

	// Build tool schema map for validation
	private toolSchemaMap = new Map<string, z.ZodType>();
	private toolExecMap = new Map<string, (input: any) => Promise<any>>();

	constructor(config: EngineConfig) {
		this.provider = config.provider;
		this.ctx = new ContextManager(config.budget);
		this.systemPrompt = config.systemPrompt || SYSTEM_PROMPT;
		this.maxToolRounds = config.maxToolRounds || MAX_TOOL_ROUNDS;
		this.workingDir = config.workingDir || process.cwd();
		this.callbacks = config;

		// Register tools
		for (const tool of ALL_TOOLS) {
			this.toolSchemaMap.set(tool.name, tool.inputSchema);
			this.toolExecMap.set(tool.name, tool.execute);
		}
	}

	/**
	 * Execute a user task. Returns the final assistant message.
	 */
	async execute(task: string): Promise<string> {
		// Change to working directory
		process.chdir(this.workingDir);

		const messages: Message[] = this.ctx.buildMessages(
			this.systemPrompt,
			task,
			"",
		);

		let lastResponse = "";

		for (let round = 0; round < this.maxToolRounds; round++) {
			// Call model (pass task for adaptive tool selection)
			const response = await this.callModel(messages, task);

			// If no tool calls, we're done
			if (!response.toolCalls || response.toolCalls.length === 0) {
				lastResponse = response.content || "";
				this.callbacks.onContent?.(`\n${lastResponse}`);

				// Fallback 1: Auto-extract code blocks and write to files
				const autoWritten = await this.autoExtractCode(lastResponse, task);
				if (autoWritten) {
					this.callbacks.onContent?.(
						`\n\n📦 Auto-extracted and wrote file(s): ${autoWritten.join(", ")}`,
					);
					break;
				}

				// Fallback 2: If first round with no tools, nudge the model to retry
				if (round === 0) {
					this.callbacks.onContent?.(
						"\n\n⚠️ Model did not use tools. Retrying with stronger instruction...",
					);
					messages.push({ role: "assistant", content: lastResponse });
					messages.push({
						role: "user",
						content:
							"IMPORTANT: You MUST call a tool. Do NOT output code in text. Use write_file to create files, or bash to run commands. Try again now.",
					});
					continue;
				}
				break;
			}

			// Process tool calls
			const assistantMsg: Message = {
				role: "assistant",
				content: response.content || "",
				tool_calls: response.toolCalls.map((tc) => ({
					id: tc.id,
					type: "function" as const,
					function: tc.function,
				})),
			};
			messages.push(assistantMsg);

			for (const toolCall of response.toolCalls) {
				// Validate and auto-fix tool call
				const validated = validateToolCall(
					toolCall.function,
					this.toolSchemaMap,
				);

				if (!validated.valid) {
					const errMsg: Message = {
						role: "tool",
						content: `Error: Invalid tool call. ${JSON.stringify(validated)}. Please try again with correct parameters.`,
						tool_call_id: toolCall.id,
					};
					messages.push(errMsg);
					continue;
				}

				this.callbacks.onToolCall?.(validated.name, validated.args);

				// Execute tool
				const executor = this.toolExecMap.get(validated.name);
				if (!executor) {
					messages.push({
						role: "tool",
						content: `Error: Unknown tool '${validated.name}'`,
						tool_call_id: toolCall.id,
					});
					continue;
				}

				try {
					const result = await executor(validated.args);
					const compressed = this.ctx.compressToolOutput(
						JSON.stringify(result, null, 2),
					);
					this.callbacks.onToolResult?.(validated.name, result);
					messages.push({
						role: "tool",
						content: compressed,
						tool_call_id: toolCall.id,
					});
				} catch (e: any) {
					messages.push({
						role: "tool",
						content: `Tool error: ${e.message}`,
						tool_call_id: toolCall.id,
					});
				}
			}

			// Check if model's text response indicates completion
			if (response.content && response.finishReason === "stop") {
				lastResponse = response.content;
				break;
			}
		}

		return lastResponse || "Task completed.";
	}

	/**
	 * Interactive loop: execute and maintain conversation history.
	 */
	async interactiveLoop(onPrompt: () => Promise<string | null>): Promise<void> {
		while (true) {
			const input = await onPrompt();
			if (!input) break;
			if (input === "/exit" || input === "/quit") break;

			const result = await this.execute(input);
			// History is managed by ContextManager
		}
	}

	/**
	 * Execute a task with multi-model orchestration (Phase 2).
	 * Planner decomposes → ParallelExecutor runs atoms → returns summary.
	 */
	async executeWithPlan(
		task: string,
		registry: ModelRegistry,
		projectFiles?: string[],
	): Promise<string> {
		process.chdir(this.workingDir);

		const plannerProvider = registry.get("planner");
		const planner = new Planner(plannerProvider);

		// Step 1: Plan
		const plan = await planner.plan(task, projectFiles);
		const atomCount = plan.atoms.length;
		const groups = plan.parallelGroups.length;

		this.callbacks.onContent?.(
			`📋 Plan: ${atomCount} atoms in ${groups} stages\n`,
		);
		for (const atom of plan.atoms) {
			this.callbacks.onContent?.(
				`  ${atom.id} [${atom.type}] ${atom.description.slice(0, 60)}\n`,
			);
		}
		this.callbacks.onContent?.("\n");

		// Step 2: Execute
		const executor = new ParallelExecutor(registry, {
			onAtomStart: (atom) => {
				this.callbacks.onContent?.(
					`⏳ ${atom.id} [${atom.type}] ${atom.description.slice(0, 50)}...\n`,
				);
			},
			onAtomComplete: (atom, result) => {
				this.callbacks.onContent?.(
					`  ✅ ${atom.id} done (${result.durationMs}ms)\n`,
				);
			},
			onAtomError: (atom, err) => {
				this.callbacks.onContent?.(
					`  ❌ ${atom.id} failed: ${err.message.slice(0, 80)}\n`,
				);
			},
			onProgress: (done, total) => {
				this.callbacks.onContent?.(`  Progress: ${done}/${total}\n`);
			},
			onToolCall: (atomId, toolName, args) => {
				this.callbacks.onToolCall?.(toolName, args);
			},
		});

		const results = await executor.execute(plan);

		// Step 3: Summarize
		const summary = this.summarizeResults(plan, results);
		this.callbacks.onContent?.(`\n${summary}`);

		return summary;
	}

	/**
	 * Summarize execution results
	 */
	private summarizeResults(
		plan: Plan,
		results: Map<string, AtomResult>,
	): string {
		const succeeded = Array.from(results.values()).filter(
			(r) => r.success,
		).length;
		const failed = results.size - succeeded;
		const totalMs = Array.from(results.values()).reduce(
			(sum, r) => sum + r.durationMs,
			0,
		);

		let summary = "─── Execution Summary ───\n";
		summary += `Total: ${results.size} tasks | ✅ ${succeeded} passed | ❌ ${failed} failed | ⏱ ${totalMs}ms\n`;

		const allFiles = new Set<string>();
		for (const result of results.values()) {
			for (const f of result.filesModified) allFiles.add(f);
		}
		if (allFiles.size > 0) {
			summary += `Files modified: ${[...allFiles].join(", ")}\n`;
		}

		// Show key results
		for (const atom of plan.atoms) {
			const r = results.get(atom.id);
			if (r) {
				const icon = r.success ? "✅" : "❌";
				summary += `${icon} ${atom.id}: ${r.output.slice(0, 100)}\n`;
			}
		}

		return summary;
	}

	/**
	 * Filter tools based on task type, keeping only relevant ones.
	 * For simple tasks (create small file, run command) only 3-5 tools are needed.
	 * For complex tasks, use more tools but still limit to relevant subset.
	 * This dramatically reduces the tool selection burden on SLMs.
	 */
	private filterToolsForTask(task: string): ToolDefinition[] {
		const analysis = analyzeTask(task);

		// Core tools: always available for all tasks
		const core = ["write_file", "read_file", "bash", "search_code"];

		const relevant: string[] = [...core];

		if (analysis.requiresCodeWriting) {
			relevant.push("add_function", "edit_function", "add_import");
		}

		if (analysis.requiresTesting) {
			relevant.push("run_test_file", "run_test_case", "get_diagnostics");
		}

		if (analysis.complexity === "complex") {
			relevant.push(
				"read_function",
				"read_class",
				"rename_symbol",
				"list_symbols",
			);
		}

		// Deduplicate but preserve order
		const seen = new Set<string>();
		const filtered: string[] = [];
		for (const name of relevant) {
			if (!seen.has(name)) {
				seen.add(name);
				filtered.push(name);
			}
		}

		const toolMap = new Map(ALL_TOOLS.map((t) => [t.name, t]));
		return filtered
			.map((name) => toolMap.get(name))
			.filter((t): t is NonNullable<typeof t> => t !== undefined)
			.map((t) => ({
				name: t.name,
				description: t.description,
				parameters: zodToJsonSchema(t.inputSchema),
			}));
	}

	private async callModel(messages: Message[], task?: string) {
		const toolDefs = task
			? this.filterToolsForTask(task)
			: ALL_TOOLS.map((t) => ({
					name: t.name,
					description: t.description,
					parameters: zodToJsonSchema(t.inputSchema),
				}));

		// Retry on transient network errors (ECONNRESET, fetch failed, etc.)
		const MAX_RETRIES = 3;
		for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
			try {
				return await this.provider.chat(messages, toolDefs);
			} catch (err: any) {
				const isTransient =
					err?.cause?.code === "ECONNRESET" ||
					err?.cause?.errno === "ECONNRESET" ||
					err?.message?.includes("fetch failed") ||
					err?.message?.includes("ECONNRESET") ||
					err?.message?.includes("connection reset") ||
					err?.message?.includes("network error") ||
					(err?.cause && !(err.cause instanceof Error));

				if (isTransient && attempt < MAX_RETRIES) {
					this.callbacks.onContent?.(
						`\n⚠️ Network error (attempt ${attempt}/${MAX_RETRIES}): ${err.message}. Retrying...\n`,
					);
					await new Promise((r) => setTimeout(r, 2000 * attempt));
					continue;
				}
				throw err;
			}
		}
		throw new Error("unreachable");
	}

	/**
	 * Auto-extract code blocks from model text output and write to files.
	 * Returns list of files written, or null if nothing to extract.
	 */
	private async autoExtractCode(
		text: string,
		task: string,
	): Promise<string[] | null> {
		const fs = await import("node:fs/promises");
		const path = await import("node:path");
		const writtenFiles: string[] = [];

		// Strategy 1: Extract write_file pseudo-calls from text
		for (const pattern of [
			/write_file\s*\(\s*path\s*=\s*["']([^"']+)["']\s*,\s*content\s*=\s*["']/g,
			/<write_file\s+path\s*=\s*["']([^"']+)["']\s+content\s*=\s*["']/g,
		]) {
			pattern.lastIndex = 0;
			let wfMatch;
			while ((wfMatch = pattern.exec(text)) !== null) {
				const filePath = wfMatch[1];
				const contentStart = wfMatch.index + wfMatch[0].length;
				const rest = text.slice(contentStart);
				const closeIdx = rest.search(/"\s*(?:\)|>)/);
				if (closeIdx === -1) continue;
				let code = rest.slice(0, closeIdx);
				code = code
					.replace(/\\n/g, "\n")
					.replace(/\\t/g, "\t")
					.replace(/\\"/g, '"')
					.replace(/\\'/g, "'")
					.replace(/\\\\/g, "\\");
				if (code.length > 20) {
					const fullPath = path.resolve(filePath);
					await fs.mkdir(path.dirname(fullPath), { recursive: true });
					await fs.writeFile(fullPath, code, "utf-8");
					writtenFiles.push(filePath);
				}
			}
			if (writtenFiles.length > 0) return writtenFiles;
		}

		// Strategy 2: Extract fenced code blocks
		const codeBlockRegex = /```(\w*)\s*\n([\s\S]*?)```/g;
		const blocks: Array<{ lang: string; code: string }> = [];
		let match;
		while ((match = codeBlockRegex.exec(text)) !== null) {
			const code = match[2].trim();
			if (code.length < 10) continue;
			blocks.push({ lang: match[1]?.toLowerCase() || "", code });
		}
		if (blocks.length === 0) return null;

		const langToExt: Record<string, string> = {
			python: ".py",
			py: ".py",
			javascript: ".js",
			js: ".js",
			typescript: ".ts",
			html: ".html",
			css: ".css",
			json: ".json",
			bash: ".sh",
			java: ".java",
		};

		for (let i = 0; i < blocks.length; i++) {
			const block = blocks[i];
			if (
				block.code.startsWith("write_file(") ||
				block.code.startsWith("read_file(") ||
				block.code.startsWith("bash(")
			)
				continue;
			const ext = langToExt[block.lang] || ".txt";
			const baseName = task
				.replace(/[^a-zA-Z0-9]/g, "_")
				.slice(0, 20)
				.replace(/_+$/, "");
			const filename =
				blocks.length === 1
					? `${baseName}${ext}`
					: `${baseName}_${i + 1}${ext}`;
			if (block.code.split("\n").length >= 5) {
				const fullPath = path.resolve(filename);
				await fs.mkdir(path.dirname(fullPath), { recursive: true });
				await fs.writeFile(fullPath, block.code, "utf-8");
				writtenFiles.push(filename);
			}
		}

		return writtenFiles.length > 0 ? writtenFiles : null;
	}
}
