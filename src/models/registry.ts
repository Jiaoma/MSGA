/**
 * Model Registry - manages multiple model roles for MSGA
 * Based on research: different model sizes excel at different tasks
 */

import type { ProviderConfig, ModelProvider } from './provider.js';
import { OpenAIProvider } from './openai.js';

export type ModelRole = 'router' | 'coder' | 'tester' | 'reviewer' | 'planner';

export interface ModelRoleConfig {
  role: ModelRole;
  baseUrl: string;
  apiKey?: string;
  model: string;
  maxTokens: number;
  temperature: number;
  contextWindow: number;
}

const DEFAULT_CONFIGS: Record<ModelRole, Partial<ModelRoleConfig>> = {
  router: {
    model: 'qwen3-4b',
    maxTokens: 512,
    temperature: 0.1,
    contextWindow: 2048,
  },
  coder: {
    model: 'qwen3-coder-7b',
    maxTokens: 4096,
    temperature: 0.3,
    contextWindow: 4096,
  },
  tester: {
    model: 'qwen3-coder-7b',
    maxTokens: 4096,
    temperature: 0.2,
    contextWindow: 4096,
  },
  reviewer: {
    model: 'qwen3-14b',
    maxTokens: 4096,
    temperature: 0.3,
    contextWindow: 8192,
  },
  planner: {
    model: 'qwen3-14b',
    maxTokens: 4096,
    temperature: 0.5,
    contextWindow: 8192,
  },
};

export class ModelRegistry {
  private providers = new Map<ModelRole, ModelProvider>();
  private defaultBaseUrl: string;
  private defaultApiKey?: string;

  constructor(config?: { baseUrl?: string; apiKey?: string }) {
    this.defaultBaseUrl = config?.baseUrl || 'http://127.0.0.1:8000/v1';
    this.defaultApiKey = config?.apiKey;
  }

  register(role: ModelRole, config: Partial<ModelRoleConfig>): void {
    const defaults = DEFAULT_CONFIGS[role];
    const fullConfig: ProviderConfig = {
      id: `${role}-${config.model || defaults.model}`,
      baseUrl: config.baseUrl || this.defaultBaseUrl,
      apiKey: config.apiKey || this.defaultApiKey,
      model: config.model || defaults.model || 'qwen3-4b',
      maxTokens: config.maxTokens || defaults.maxTokens || 2048,
      temperature: config.temperature ?? defaults.temperature ?? 0.3,
      contextWindow: config.contextWindow || defaults.contextWindow || 4096,
    };
    this.providers.set(role, new OpenAIProvider(fullConfig));
  }

  get(role: ModelRole): ModelProvider {
    if (!this.providers.has(role)) {
      this.register(role, {});
    }
    return this.providers.get(role)!;
  }

  getForTaskType(taskType: string): ModelProvider {
    const roleMap: Record<string, ModelRole> = {
      design: 'planner',
      code: 'coder',
      test: 'tester',
      review: 'reviewer',
      debug: 'coder',
      refactor: 'coder',
      route: 'router',
    };
    return this.get(roleMap[taskType] || 'coder');
  }

  listRoles(): ModelRole[] {
    return Array.from(this.providers.keys());
  }

  static fromConfig(config: {
    baseUrl: string;
    apiKey?: string;
    models?: Partial<Record<ModelRole, Partial<ModelRoleConfig>>>;
  }): ModelRegistry {
    const registry = new ModelRegistry({
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
    });

    const roles: ModelRole[] = ['router', 'coder', 'tester', 'reviewer', 'planner'];
    for (const role of roles) {
      registry.register(role, config.models?.[role] || {});
    }

    return registry;
  }
}
