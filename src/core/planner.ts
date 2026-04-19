/**
 * MSGA Planner - Decomposes user tasks into atomic executable tasks
 * Uses a small model (router/planner) for cost efficiency
 */

import type { ModelProvider } from '../models/provider.js';
import type { ModelRole } from '../models/registry.js';
import { PLANNER_SYSTEM_PROMPT, buildPlannerPrompt } from './prompts.js';
import { validateToolCallArgs } from './validator.js';
import { z } from 'zod';

// --- Types ---

export type TaskType = 'design' | 'code' | 'test' | 'review' | 'debug' | 'refactor';

export interface AtomTask {
  id: string;
  type: TaskType;
  description: string;
  dependencies: string[];
  contextFiles: string[];
  modelHint: ModelRole;
  maxRetries: number;
  status?: 'pending' | 'running' | 'completed' | 'failed';
  result?: AtomResult;
}

export interface AtomResult {
  success: boolean;
  output: string;
  filesModified: string[];
  durationMs: number;
}

export interface Plan {
  atoms: AtomTask[];
  parallelGroups: string[][]; // groups of atom IDs that can run in parallel
}

// Schema for validating planner model output
const PlanSchema = z.object({
  atoms: z.array(z.object({
    id: z.string(),
    type: z.enum(['design', 'code', 'test', 'review', 'debug', 'refactor']),
    description: z.string(),
    dependencies: z.array(z.string()),
    contextFiles: z.array(z.string()),
    modelHint: z.enum(['router', 'coder', 'tester', 'reviewer', 'planner']),
  })),
  parallelGroups: z.array(z.array(z.string())),
});

export interface PlannerCallbacks {
  onPlanCreated?: (plan: Plan) => void;
  onError?: (error: Error) => void;
}

export class Planner {
  private provider: ModelProvider;

  constructor(provider: ModelProvider) {
    this.provider = provider;
  }

  /**
   * Decompose a user task into a Plan of atomic tasks.
   */
  async plan(task: string, projectFiles?: string[]): Promise<Plan> {
    const userPrompt = buildPlannerPrompt(task, projectFiles);

    const response = await this.provider.chat(
      [
        { role: 'system', content: PLANNER_SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
      [] // no tools for planner — it just outputs JSON
    );

    const content = response.content || '';

    // Extract and validate the JSON plan
    const plan = this.parsePlan(content);

    // Set defaults
    for (const atom of plan.atoms) {
      atom.maxRetries = 3;
      atom.status = 'pending';
    }

    return plan;
  }

  /**
   * Parse plan JSON from model output, with auto-fix
   */
  private parsePlan(raw: string): Plan {
    const validation = validateToolCallArgs(raw, PlanSchema);

    if (validation.valid && validation.data) {
      return validation.data as Plan;
    }

    // Try to extract JSON from surrounding text
    const jsonMatch = raw.match(/\{[\s\S]*"atoms"[\s\S]*\}/);
    if (jsonMatch) {
      const retry = validateToolCallArgs(jsonMatch[0], PlanSchema);
      if (retry.valid && retry.data) {
        return retry.data as Plan;
      }
    }

    // Fallback: create a simple single-atom plan
    return {
      atoms: [{
        id: 'a1',
        type: 'code',
        description: raw.slice(0, 200),
        dependencies: [],
        contextFiles: [],
        modelHint: 'coder',
        maxRetries: 3,
        status: 'pending',
      }],
      parallelGroups: [['a1']],
    };
  }
}
