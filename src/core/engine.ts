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

import type { Message } from '../context/manager.js';
import { ContextManager, DEFAULT_BUDGET } from '../context/manager.js';
import type { ModelProvider } from '../models/provider.js';
import type { ToolCall } from '../models/provider.js';
import type { ToolDefinition } from '../models/provider.js';
import { ALL_TOOLS, getToolsAsOpenAIFormat } from '../tools/index.js';
import { validateToolCall } from './validator.js';
import { z } from 'zod';

const SYSTEM_PROMPT = `You are MSGA, a coding assistant optimized for small language models.
You help with software design, coding, and testing.

Rules:
- Use the provided tools to read, write, and test code
- Call one tool at a time
- Be precise with tool parameters
- When done, summarize what you did`;

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

    let messages: Message[] = this.ctx.buildMessages(
      this.systemPrompt,
      task,
      ''
    );

    let lastResponse = '';

    for (let round = 0; round < this.maxToolRounds; round++) {
      // Call model
      const response = await this.callModel(messages);

      // If no tool calls, we're done
      if (!response.toolCalls || response.toolCalls.length === 0) {
        lastResponse = response.content || '';
        this.callbacks.onContent?.('\n' + lastResponse);
        break;
      }

      // Process tool calls
      const assistantMsg: Message = {
        role: 'assistant',
        content: response.content || '',
        tool_calls: response.toolCalls.map(tc => ({
          id: tc.id,
          type: 'function' as const,
          function: tc.function,
        })),
      };
      messages.push(assistantMsg);

      for (const toolCall of response.toolCalls) {
        // Validate and auto-fix tool call
        const validated = validateToolCall(toolCall.function, this.toolSchemaMap);

        if (!validated.valid) {
          const errMsg: Message = {
            role: 'tool',
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
            role: 'tool',
            content: `Error: Unknown tool '${validated.name}'`,
            tool_call_id: toolCall.id,
          });
          continue;
        }

        try {
          const result = await executor(validated.args);
          const compressed = this.ctx.compressToolOutput(JSON.stringify(result, null, 2));
          this.callbacks.onToolResult?.(validated.name, result);
          messages.push({
            role: 'tool',
            content: compressed,
            tool_call_id: toolCall.id,
          });
        } catch (e: any) {
          messages.push({
            role: 'tool',
            content: `Tool error: ${e.message}`,
            tool_call_id: toolCall.id,
          });
        }
      }

      // Check if model's text response indicates completion
      if (response.content && response.finishReason === 'stop') {
        lastResponse = response.content;
        break;
      }
    }

    return lastResponse || 'Task completed.';
  }

  /**
   * Interactive loop: execute and maintain conversation history.
   */
  async interactiveLoop(onPrompt: () => Promise<string | null>): Promise<void> {
    while (true) {
      const input = await onPrompt();
      if (!input) break;
      if (input === '/exit' || input === '/quit') break;

      const result = await this.execute(input);
      // History is managed by ContextManager
    }
  }

  private async callModel(messages: Message[]) {
    const toolsFormatted = getToolsAsOpenAIFormat();
    return this.provider.chat(messages, toolsFormatted as any);
  }
}
