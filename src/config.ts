/**
 * MSGA Configuration Management
 * Manages model profiles and role assignments
 */

import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';

// ─── Types ──────────────────────────────────────────────

export interface ModelProfile {
  /** Unique name for this profile (e.g. "gemma-omlx") */
  name: string;
  /** Provider type: omlx, ollama, lmstudio, openai, custom */
  provider: string;
  /** Full base URL including /v1 (e.g. "http://127.0.0.1:8000/v1") */
  baseUrl: string;
  /** API key (optional, some providers like ollama don't need it) */
  apiKey?: string;
  /** Model identifier as recognized by the provider */
  model: string;
}

export type ModelRole = 'router' | 'coder' | 'tester' | 'reviewer' | 'planner';

export const ALL_ROLES: ModelRole[] = ['router', 'coder', 'tester', 'reviewer', 'planner'];

export const ROLE_DESCRIPTIONS: Record<ModelRole, string> = {
  router:   '任务路由/分类 — 将用户意图分发给合适的角色 (建议 3-4B)',
  coder:    '代码编写 — 主要的代码生成角色 (建议 7-14B)',
  tester:   '测试生成 — 编写单元测试和集成测试 (建议 7B)',
  reviewer: '代码审查 — 审查代码质量和安全性 (建议 14-30B)',
  planner:  '任务规划 — 拆解复杂任务为子任务 (建议 14-30B)',
};

export interface MsgaConfig {
  /** Named model profiles */
  models: Record<string, ModelProfile>;
  /** Role → profile name mapping */
  roles: Partial<Record<ModelRole, string>>;
}

// ─── Persistence ────────────────────────────────────────

const CONFIG_DIR = () => path.join(process.env.HOME || '~', '.msga');
const CONFIG_PATH = () => path.join(CONFIG_DIR(), 'config.json');

export function loadConfig(): MsgaConfig {
  try {
    const raw = fs.readFileSync(CONFIG_PATH(), 'utf-8');
    const parsed = JSON.parse(raw);

    // Migrate old flat config format
    if (!parsed.models && (parsed.baseUrl || parsed.model)) {
      return migrateOldConfig(parsed);
    }

    return {
      models: parsed.models || {},
      roles: parsed.roles || {},
    };
  } catch {
    return { models: {}, roles: {} };
  }
}

export function saveConfig(config: MsgaConfig): void {
  const dir = CONFIG_DIR();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(CONFIG_PATH(), JSON.stringify(config, null, 2));
}

/** Migrate old flat config ({ baseUrl, apiKey, model }) to new format */
function migrateOldConfig(old: Record<string, string>): MsgaConfig {
  const config: MsgaConfig = { models: {}, roles: {} };

  if (old.baseUrl && old.model) {
    const profileName = old.model.split('/').pop() || 'default';
    const profile: ModelProfile = {
      name: profileName,
      provider: guessProvider(old.baseUrl),
      baseUrl: old.baseUrl,
      model: old.model,
    };
    if (old.apiKey) profile.apiKey = old.apiKey;
    config.models[profileName] = profile;

    for (const role of ALL_ROLES) {
      config.roles[role] = profileName;
    }
  }

  // Migrate per-role model overrides
  for (const role of ALL_ROLES) {
    const key = `model.${role}`;
    if (old[key]) {
      // Was just a model name override, same baseUrl — create a profile
      const pName = old[key].split('/').pop() || `${role}-model`;
      if (!config.models[pName]) {
        config.models[pName] = {
          name: pName,
          provider: guessProvider(old.baseUrl || 'http://127.0.0.1:8000/v1'),
          baseUrl: old.baseUrl || 'http://127.0.0.1:8000/v1',
          apiKey: old.apiKey,
          model: old[key],
        };
      }
      config.roles[role] = pName;
    }
  }

  saveConfig(config);
  return config;
}

function guessProvider(url: string): string {
  if (url.includes('ollama') || url.includes(':11434')) return 'ollama';
  if (url.includes('omlx') || url.includes(':8000')) return 'omlx';
  if (url.includes('lmstudio') || url.includes(':1234')) return 'lmstudio';
  return 'openai';
}

// ─── Interactive Setup ──────────────────────────────────

function ask(rl: readline.Interface, prompt: string): Promise<string> {
  return new Promise(resolve => rl.question(prompt, answer => resolve(answer.trim())));
}

function askChoice(rl: readline.Interface, prompt: string, options: string[]): Promise<string> {
  console.log(`\n${prompt}`);
  options.forEach((opt, i) => console.log(`  ${i + 1}. ${opt}`));
  return new Promise((resolve) => {
    rl.question('\n请选择 (输入编号): ', (answer) => {
      const idx = parseInt(answer.trim()) - 1;
      if (idx >= 0 && idx < options.length) {
        resolve(options[idx]);
      } else {
        resolve(answer.trim());
      }
    });
  });
}

async function confirm(rl: readline.Interface, prompt: string): Promise<boolean> {
  const answer = await ask(rl, `${prompt} (y/N): `);
  return answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes';
}

/** Interactive: add or edit a model profile */
export async function interactiveModelSetup(
  rl: readline.Interface,
  existing?: ModelProfile
): Promise<ModelProfile> {
  const name = existing?.name || await ask(rl, '📝 配置名称 (如 gemma-omlx): ');
  if (!name) throw new Error('名称不能为空');

  const providerOptions = ['omlx', 'ollama', 'lmstudio', 'openai', 'other'];
  const provider = existing?.provider || await askChoice(rl, '📦 Provider 类型:', providerOptions);

  let defaultUrl = 'http://127.0.0.1:8000/v1';
  if (provider === 'ollama') defaultUrl = 'http://127.0.0.1:11434/v1';
  if (provider === 'lmstudio') defaultUrl = 'http://127.0.0.1:1234/v1';

  const baseUrl = await ask(rl, `🌐 API 地址 [${existing?.baseUrl || defaultUrl}]: `)
    .then(v => v || existing?.baseUrl || defaultUrl);

  let apiKey: string | undefined;
  if (provider !== 'ollama') {
    const keyInput = await ask(rl, `🔑 API Key [${existing?.apiKey ? '***已设置***' : '无'}]: `);
    apiKey = keyInput || existing?.apiKey || undefined;
  }

  const model = await ask(rl, `🤖 模型名称 [${existing?.model || ''}]: `)
    .then(v => v || existing?.model || '');
  if (!model) throw new Error('模型名称不能为空');

  return { name, provider, baseUrl, apiKey, model };
}

/** Interactive: assign roles to model profiles */
export async function interactiveRoleSetup(
  rl: readline.Interface,
  config: MsgaConfig
): Promise<void> {
  const profileNames = Object.keys(config.models);
  if (profileNames.length === 0) {
    console.log('⚠️  还没有配置任何模型，请先用 msga config models 添加');
    return;
  }

  console.log('\n🎯 为每个角色分配模型:\n');
  console.log('可用模型:');
  profileNames.forEach(n => {
    const p = config.models[n];
    console.log(`  • ${n} → ${p.model} @ ${p.baseUrl} [${p.provider}]`);
  });
  console.log('');

  for (const role of ALL_ROLES) {
    const current = config.roles[role];
    const desc = ROLE_DESCRIPTIONS[role];
    console.log(`\n  ${role.toUpperCase()} — ${desc}`);
    if (current) {
      console.log(`  当前: ${current}`);
    }

    const choice = await askChoice(
      rl,
      `  选择模型 (或按 Enter 保持${current ? '当前' : '默认'}):`,
      profileNames
    );

    // If user just pressed enter or typed current value, keep it
    if (choice) {
      config.roles[role] = choice;
    }
  }

  saveConfig(config);
  console.log('\n✅ 角色配置已保存!');
}

/** Show current config */
export function showConfig(config: MsgaConfig): void {
  console.log('\n📦 模型配置:\n');
  const profiles = Object.values(config.models);
  if (profiles.length === 0) {
    console.log('  (无)');
  } else {
    for (const p of profiles) {
      const keyDisplay = p.apiKey ? '🔑' : '  ';
      console.log(`  ${p.name}:`);
      console.log(`    Provider: ${p.provider}`);
      console.log(`    URL:      ${p.baseUrl}`);
      console.log(`    Model:    ${p.model}`);
      console.log(`    API Key:  ${keyDisplay} ${p.apiKey ? '已设置' : '未设置'}`);
      console.log('');
    }
  }

  console.log('🎯 角色分配:\n');
  for (const role of ALL_ROLES) {
    const profileName = config.roles[role];
    if (profileName && config.models[profileName]) {
      const p = config.models[profileName];
      console.log(`  ${role.padEnd(10)} → ${profileName} (${p.model})`);
    } else {
      console.log(`  ${role.padEnd(10)} → (未设置)`);
    }
  }
  console.log('');
}

/** Quick setup: one model for all roles */
export async function quickSetup(rl: readline.Interface): Promise<void> {
  console.log('\n⚡ 快速配置 — 将所有角色使用同一个模型\n');
  const config = loadConfig();
  const profile = await interactiveModelSetup(rl);
  config.models[profile.name] = profile;
  for (const role of ALL_ROLES) {
    config.roles[role] = profile.name;
  }
  saveConfig(config);
  console.log(`\n✅ 已配置所有角色使用 ${profile.name} (${profile.model})`);
}

// ─── Non-interactive helpers ────────────────────────────

/** Add or update a model profile non-interactively */
export function setModelProfile(profile: ModelProfile): void {
  const config = loadConfig();
  config.models[profile.name] = profile;
  saveConfig(config);
}

/** Remove a model profile */
export function removeModelProfile(name: string): boolean {
  const config = loadConfig();
  if (!config.models[name]) return false;
  delete config.models[name];
  // Clear roles that reference this profile
  for (const role of ALL_ROLES) {
    if (config.roles[role] === name) {
      delete config.roles[role];
    }
  }
  saveConfig(config);
  return true;
}

/** Set a role to a profile */
export function setRole(role: ModelRole, profileName: string): boolean {
  const config = loadConfig();
  if (!config.models[profileName]) return false;
  config.roles[role] = profileName;
  saveConfig(config);
  return true;
}

/** Resolve role to full provider config */
export function resolveRole(
  config: MsgaConfig,
  role: ModelRole
): { baseUrl: string; apiKey?: string; model: string; profileName: string } | null {
  const profileName = config.roles[role];
  if (!profileName) return null;
  const profile = config.models[profileName];
  if (!profile) return null;
  return {
    baseUrl: profile.baseUrl,
    apiKey: profile.apiKey,
    model: profile.model,
    profileName: profile.name,
  };
}
