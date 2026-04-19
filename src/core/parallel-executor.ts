/**
 * MSGA Parallel Executor - Executes AtomTasks respecting dependency order
 * Key insight: tasks without dependencies run concurrently (SLM advantage)
 */

import type { AtomTask, AtomResult, Plan } from './planner.js';
import type { ModelProvider } from '../models/provider.js';
import { ModelRegistry } from '../models/registry.js';
import { ContextManager, DEFAULT_BUDGET } from '../context/manager.js';
import { ALL_TOOLS, getToolsAsOpenAIFormat } from '../tools/index.js';
import { validateToolCall } from './validator.js';
import { z } from 'zod';
import type { Message } from '../context/manager.js';

const ATOM_SYSTEM_PROMPT = `You are MSGA, executing a single atomic coding task.
Use the provided tools to complete the task. Call one tool at a time.
When done, output a brief summary of what you accomplished.`;

export interface ExecutorCallbacks {
  onAtomStart?: (atom: AtomTask) => void;
  onAtomComplete?: (atom: AtomTask, result: AtomResult) => void;
  onAtomError?: (atom: AtomTask, error: Error) => void;
  onToolCall?: (atomId: string, toolName: string, args: unknown) => void;
  onProgress?: (completed: number, total: number) => void;
}

export class ParallelExecutor {
  private registry: ModelRegistry;
  private callbacks: ExecutorCallbacks;
  private maxToolRounds: number;

  constructor(registry: ModelRegistry, callbacks: ExecutorCallbacks = {}, maxToolRounds = 8) {
    this.registry = registry;
    this.callbacks = callbacks;
    this.maxToolRounds = maxToolRounds;
  }

  /**
   * Execute a plan: run parallel groups sequentially, atoms within each group concurrently
   */
  async execute(plan: Plan): Promise<Map<string, AtomResult>> {
    const results = new Map<string, AtomResult>();
    const totalAtoms = plan.atoms.length;
    let completedCount = 0;

    for (const group of plan.parallelGroups) {
      // Run all atoms in this group concurrently
      const promises = group.map(async (atomId) => {
        const atom = plan.atoms.find(a => a.id === atomId);
        if (!atom) return;

        // Check dependencies are satisfied
        for (const depId of atom.dependencies) {
          const depResult = results.get(depId);
          if (!depResult || !depResult.success) {
            const errResult: AtomResult = {
              success: false,
              output: `Dependency ${depId} failed or not completed`,
              filesModified: [],
              durationMs: 0,
            };
            atom.status = 'failed';
            atom.result = errResult;
            results.set(atomId, errResult);
            this.callbacks.onAtomError?.(atom, new Error(errResult.output));
            return;
          }
        }

        // Execute the atom
        const result = await this.executeAtom(atom, results);
        atom.status = result.success ? 'completed' : 'failed';
        atom.result = result;
        results.set(atomId, result);

        completedCount++;
        this.callbacks.onProgress?.(completedCount, totalAtoms);

        if (result.success) {
          this.callbacks.onAtomComplete?.(atom, result);
        } else {
          this.callbacks.onAtomError?.(atom, new Error(result.output));
        }
      });

      await Promise.allSettled(promises);
    }

    return results;
  }

  /**
   * Execute a single atom task with its own context and model
   */
  private async executeAtom(
    atom: AtomTask,
    previousResults: Map<string, AtomResult>
  ): Promise<AtomResult> {
    const startTime = Date.now();
    this.callbacks.onAtomStart?.(atom);

    // Get the right model for this task type
    const provider = this.registry.getForTaskType(atom.type);
    const ctx = new ContextManager(DEFAULT_BUDGET);

    // Build context: task description + relevant previous results
    let taskContext = atom.description;

    // Inject results from dependencies
    const depResults: string[] = [];
    for (const depId of atom.dependencies) {
      const dep = previousResults.get(depId);
      if (dep) {
        depResults.push(`[${depId}]: ${dep.output.slice(0, 300)}`);
      }
    }
    if (depResults.length > 0) {
      taskContext += '\n\nPrevious results:\n' + depResults.join('\n');
    }

    // Build messages
    const messages: Message[] = ctx.buildMessages(
      ATOM_SYSTEM_PROMPT,
      taskContext,
      '' // file context loaded by tools
    );

    // Execute tool loop
    const filesModified: string[] = [];
    let lastOutput = '';

    for (let round = 0; round < this.maxToolRounds; round++) {
      try {
        const tools = getToolsAsOpenAIFormat();
        const response = await provider.chat(messages, tools as any);

        // No tool calls = done
        if (!response.toolCalls || response.toolCalls.length === 0) {
          lastOutput = response.content || '';
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

        for (const tc of response.toolCalls) {
          // Validate
          const toolSchemas = new Map<string, z.ZodType>();
          for (const tool of ALL_TOOLS) {
            toolSchemas.set(tool.name, tool.inputSchema);
          }
          const validated = validateToolCall(tc.function, toolSchemas);

          if (!validated.valid) {
            messages.push({
              role: 'tool',
              content: `Error: invalid tool call. Try again.`,
              tool_call_id: tc.id,
            });
            continue;
          }

          this.callbacks.onToolCall?.(atom.id, validated.name, validated.args);

          // Execute
          const executor = ALL_TOOLS.find(t => t.name === validated.name);
          if (!executor) {
            messages.push({ role: 'tool', content: `Unknown tool: ${validated.name}`, tool_call_id: tc.id });
            continue;
          }

          try {
            const result = await executor.execute(validated.args);
            const output = JSON.stringify(result, null, 2);
            messages.push({
              role: 'tool',
              content: ctx.compressToolOutput(output),
              tool_call_id: tc.id,
            });

            // Track modified files
            if (result?.file) filesModified.push(result.file);
            if (result?.success === false) lastOutput = result.output || result.error || 'Tool failed';
          } catch (e: any) {
            messages.push({
              role: 'tool',
              content: `Tool error: ${e.message}`,
              tool_call_id: tc.id,
            });
          }
        }
      } catch (e: any) {
        lastOutput = `Model error: ${e.message}`;
        break;
      }
    }

    return {
      success: !lastOutput.toLowerCase().includes('error'),
      output: lastOutput || 'Task completed',
      filesModified: [...new Set(filesModified)],
      durationMs: Date.now() - startTime,
    };
  }
}
