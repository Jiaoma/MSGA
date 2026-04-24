#!/usr/bin/env node
/**
 * MSGA - Make Small language models Great Again
 * AI coding agent optimized for SLM
 */

import { Command } from 'commander';
import { ExecutionEngine } from './core/engine.js';
import { ModelRegistry } from './models/registry.js';
import { reviewFile } from './core/reviewer.js';
import { listSessions, loadSession } from './core/session.js';
import {
  loadConfig,
  saveConfig,
  showConfig,
  quickSetup,
  interactiveModelSetup,
  interactiveRoleSetup,
  setModelProfile,
  removeModelProfile,
  setRole,
  resolveRole,
  ALL_ROLES,
  type ModelRole,
  type MsgaConfig,
} from './config.js';
import * as readline from 'readline';

const VERSION = '0.1.0';

const program = new Command();

program
  .name('msga')
  .description('MSGA - AI coding agent optimized for small language models')
  .version(VERSION);

// ─── Main action: build ModelRegistry from new config system ────

function buildRegistry(opts: { baseUrl?: string; apiKey?: string; model?: string }): ModelRegistry {
  const config = loadConfig();
  let baseUrl = opts.baseUrl || undefined;
  let apiKey = opts.apiKey || undefined;
  let model = opts.model || undefined;

  // CLI flags take priority; fall back to new config's role resolution, then defaults
  if (model) {
    // Single --model flag: all roles use this model
    return ModelRegistry.fromConfig({
      baseUrl: baseUrl || 'http://127.0.0.1:8000/v1',
      apiKey,
      models: Object.fromEntries(
        ALL_ROLES.map(r => [r, { model }])
      ) as any,
    });
  }

  // Try resolving each role from the new config
  const resolved: Partial<Record<ModelRole, { model: string; baseUrl?: string; apiKey?: string }>> = {};
  let hasResolved = false;
  for (const role of ALL_ROLES) {
    const r = resolveRole(config, role);
    if (r) {
      resolved[role] = { model: r.model, baseUrl: r.baseUrl, apiKey: r.apiKey };
      hasResolved = true;
    }
  }

  if (hasResolved) {
    // Use the first resolved profile's baseUrl/apiKey as defaults if not overridden by CLI
    const firstResolved = Object.values(resolved)[0];
    const regBaseUrl = baseUrl || firstResolved?.baseUrl || 'http://127.0.0.1:8000/v1';
    const regApiKey = apiKey || firstResolved?.apiKey;

    return ModelRegistry.fromConfig({
      baseUrl: regBaseUrl,
      apiKey: regApiKey,
      models: resolved as any,
    });
  }

  // No config at all — use defaults
  return ModelRegistry.fromConfig({
    baseUrl: baseUrl || 'http://127.0.0.1:8000/v1',
    apiKey,
  });
}

program
  .argument('[task]', 'Task to execute')
  .option('-m, --model <model>', 'Model to use (overrides config, all roles)')
  .option('--base-url <url>', 'API base URL')
  .option('--api-key <key>', 'API key')
  .option('-d, --dir <path>', 'Working directory', process.cwd())
  .option('-v, --verbose', 'Verbose output')
  .option('-p, --plan', 'Use multi-model planning mode (Phase 2)')
  .action(async (task: string | undefined, opts: any) => {
    const registry = buildRegistry(opts);
    const provider = registry.get('coder');

    if (task) {
      // One-shot mode
      console.log(`\n🚀 MSGA v${VERSION}`);
      console.log(`📝 Task: ${task}`);
      console.log(`🤖 Model: ${provider.config.model}`);
      console.log('─'.repeat(50));

      const engine = new ExecutionEngine({
        provider,
        workingDir: opts.dir,
        onContent: (chunk) => process.stdout.write(chunk),
        onToolCall: (name, args) => {
          console.log(`\n🔧 ${name}(${JSON.stringify(args).slice(0, 100)}...)`);
        },
        onToolResult: (name, result) => {
          const summary = JSON.stringify(result).slice(0, 200);
          console.log(`  ✅ ${name} → ${summary}...`);
        },
      });

      try {
        if (opts.plan) {
          await engine.executeWithPlan(task, registry);
        } else {
          await engine.execute(task);
        }
        console.log('\n' + '─'.repeat(50));
        console.log('Done! ✨');
      } catch (e: any) {
        console.error(`\n❌ Error: ${e.message}`);
        process.exit(1);
      }
    } else {
      await interactiveMode(provider, opts);
    }
  });

// ─── Config command ──────────────────────────────────────

const configCmd = program
  .command('config')
  .description('Manage MSGA configuration');

configCmd
  .command('show')
  .description('Show current configuration')
  .action(() => {
    const config = loadConfig();
    showConfig(config);
  });

configCmd
  .command('set')
  .description('Set a config value (key=value)')
  .argument('<key>', 'Config key (baseUrl, apiKey, model, model.<role>, profile.<name>.<field>)')
  .argument('<value>', 'Config value')
  .action(async (key: string, value: string) => {
    const config = loadConfig();

    // Handle model.<role> = <profileName>
    if (key.startsWith('model.')) {
      const role = key.slice(6) as ModelRole;
      if (!ALL_ROLES.includes(role)) {
        console.error(`❌ Unknown role: ${role}. Valid: ${ALL_ROLES.join(', ')}`);
        process.exit(1);
      }
      if (!setRole(role, value)) {
        console.error(`❌ Profile "${value}" not found. Create it first with: msga config add-model`);
        process.exit(1);
      }
      console.log(`✅ ${role} → ${value}`);
      return;
    }

    // Handle profile.<name>.<field> = value
    if (key.startsWith('profile.')) {
      const parts = key.split('.');
      const pName = parts[1];
      const field = parts[2];
      if (!pName || !field) {
        console.error('❌ Format: profile.<name>.<field> where field = baseUrl|apiKey|model|provider');
        process.exit(1);
      }
      const profile = config.models[pName];
      if (!profile) {
        console.error(`❌ Profile "${pName}" not found. Create it first with: msga config add-model`);
        process.exit(1);
      }
      if (!['baseUrl', 'apiKey', 'model', 'provider'].includes(field)) {
        console.error(`❌ Unknown field: ${field}. Valid: baseUrl, apiKey, model, provider`);
        process.exit(1);
      }
      (profile as any)[field] = value;
      saveConfig(config);
      console.log(`✅ ${pName}.${field} = ${field === 'apiKey' ? '***' : value}`);
      return;
    }

    // Handle top-level shortcuts: baseUrl, apiKey, model → quick setup
    if (key === 'baseUrl' || key === 'apiKey' || key === 'model') {
      // Set on all profiles that exist, or create a "default" profile
      const profileNames = Object.keys(config.models);
      if (profileNames.length === 0) {
        // Create a default profile
        setModelProfile({
          name: 'default',
          provider: 'openai',
          baseUrl: key === 'baseUrl' ? value : 'http://127.0.0.1:8000/v1',
          apiKey: key === 'apiKey' ? value : undefined,
          model: key === 'model' ? value : 'qwen3-coder-7b',
        });
        // Assign default to all roles
        const newConfig = loadConfig();
        for (const role of ALL_ROLES) {
          newConfig.roles[role] = 'default';
        }
        saveConfig(newConfig);
      } else {
        // Update all existing profiles with this field
        for (const pName of profileNames) {
          const p = config.models[pName];
          if (key === 'baseUrl') p.baseUrl = value;
          if (key === 'apiKey') p.apiKey = value;
          if (key === 'model') p.model = value;
        }
        saveConfig(config);
      }
      console.log(`✅ ${key} = ${key === 'apiKey' ? '***' : value}`);
      return;
    }

    console.error(`❌ Unknown key: ${key}`);
    console.error('   Valid: baseUrl, apiKey, model, model.<role>, profile.<name>.<field>');
    process.exit(1);
  });

configCmd
  .command('get')
  .description('Get a config value')
  .argument('[key]', 'Config key')
  .action(async (key?: string) => {
    const config = loadConfig();

    if (!key) {
      showConfig(config);
      return;
    }

    if (key === 'baseUrl' || key === 'apiKey' || key === 'model') {
      const profileNames = Object.keys(config.models);
      if (profileNames.length > 0) {
        for (const pName of profileNames) {
          const p = config.models[pName];
          const val = key === 'baseUrl' ? p.baseUrl : key === 'apiKey' ? (p.apiKey || '(not set)') : p.model;
          console.log(`  ${pName}.${key} = ${key === 'apiKey' && p.apiKey ? '***' : val}`);
        }
      } else {
        console.log('(no config)');
      }
      return;
    }

    if (key.startsWith('model.')) {
      const role = key.slice(6) as ModelRole;
      const profileName = config.roles[role];
      if (profileName && config.models[profileName]) {
        console.log(`${role} → ${profileName} (${config.models[profileName].model})`);
      } else {
        console.log(`${role} → (not set)`);
      }
      return;
    }

    console.log('(not found)');
  });

configCmd
  .command('add-model')
  .description('Interactively add a new model profile')
  .action(async () => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
      const profile = await interactiveModelSetup(rl);
      setModelProfile(profile);
      console.log(`\n✅ Added model profile: ${profile.name}`);
      console.log('   Assign it to roles with: msga config set model.<role> <profile-name>');
    } catch (e: any) {
      console.error(`❌ ${e.message}`);
    } finally {
      rl.close();
    }
  });

configCmd
  .command('remove-model')
  .description('Remove a model profile')
  .argument('<name>', 'Profile name')
  .action((name: string) => {
    if (removeModelProfile(name)) {
      console.log(`✅ Removed profile: ${name}`);
    } else {
      console.error(`❌ Profile "${name}" not found`);
      process.exit(1);
    }
  });

configCmd
  .command('roles')
  .description('Interactively assign roles to model profiles')
  .action(async () => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const config = loadConfig();
    try {
      await interactiveRoleSetup(rl, config);
    } finally {
      rl.close();
    }
  });

configCmd
  .command('quick-setup')
  .description('Quick setup: one model for all roles')
  .action(async () => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
      await quickSetup(rl);
    } catch (e: any) {
      console.error(`❌ ${e.message}`);
    } finally {
      rl.close();
    }
  });

// ─── Models command ──────────────────────────────────────

program
  .command('models')
  .description('List available models and role assignments')
  .action(() => {
    const config = loadConfig();
    const registry = buildRegistry({});

    console.log('📋 Model Roles:\n');
    for (const role of ALL_ROLES) {
      const provider = registry.get(role);
      const profileName = config.roles[role];
      const source = profileName ? `(profile: ${profileName})` : '(default)';
      console.log(`  ${role.padEnd(10)} → ${provider.config.model.padEnd(25)} ${source}`);
    }
  });

// ─── Review command ──────────────────────────────────────

program
  .command('review')
  .description('Review code files')
  .argument('<files...>', 'Files to review')
  .option('-m, --model <model>', 'Model for review')
  .option('--base-url <url>', 'API base URL')
  .action(async (files: string[], opts: any) => {
    const registry = buildRegistry(opts);
    const reviewer = registry.get('reviewer');
    const fs = await import('fs/promises');

    console.log(`🔍 Reviewing ${files.length} file(s)...\n`);

    for (const file of files) {
      try {
        const content = await fs.readFile(file, 'utf-8');
        const result = await reviewFile(file, content, reviewer, {
          onProgress: (msg) => console.log(`  ${msg}`),
        });

        console.log(`\n📄 ${file} — Score: ${result.score}/10`);
        for (const issue of result.issues) {
          const icon = issue.severity === 'error' ? '❌' : issue.severity === 'warning' ? '⚠️' : '💡';
          console.log(`  ${icon} L${issue.line}: ${issue.message}`);
          if (issue.suggestion) console.log(`     → ${issue.suggestion}`);
        }
        if (result.strengths.length > 0) {
          console.log(`  ✨ Strengths: ${result.strengths.join(', ')}`);
        }
      } catch (e: any) {
        console.error(`  ❌ ${file}: ${e.message}`);
      }
    }
  });

// ─── Sessions command ────────────────────────────────────

program
  .command('sessions')
  .description('List saved sessions')
  .option('-l, --limit <n>', 'Max sessions to show', '10')
  .action(async (opts: any) => {
    const sessions = listSessions(Number.parseInt(opts.limit));
    if (sessions.length === 0) {
      console.log('No saved sessions.');
      return;
    }
    console.log(`📋 Saved sessions (${sessions.length}):\n`);
    for (const s of sessions) {
      const date = s.updatedAt ? new Date(s.updatedAt).toLocaleString() : '(unknown)';
      console.log(`  ${s.id}`);
      console.log(`    Task: ${s.task}`);
      console.log(`    Date: ${date} | Dir: ${s.workingDir}`);
      console.log('');
    }
  });

// ─── Interactive mode ────────────────────────────────────

async function interactiveMode(provider: any, opts: any) {
  console.log(`\n🚀 MSGA v${VERSION} - Interactive Mode`);
  console.log(`🤖 Model: ${provider.config.model}`);
  console.log('Type your task, or /exit to quit.\n');

  const engine = new ExecutionEngine({
    provider,
    workingDir: opts.dir,
    onContent: (chunk) => process.stdout.write(chunk),
    onToolCall: (name, args) => {
      console.log(`  🔧 ${name}`);
    },
    onToolResult: (name, result) => {
      console.log(`  ✅ ${name} done`);
    },
  });

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: '> ',
  });

  rl.prompt();

  rl.on('line', async (line) => {
    const input = line.trim();
    if (!input) {
      rl.prompt();
      return;
    }
    if (input === '/exit' || input === '/quit') {
      rl.close();
      return;
    }

    try {
      await engine.execute(input);
    } catch (e: any) {
      console.error(`Error: ${e.message}`);
    }

    console.log('');
    rl.prompt();
  });

  rl.on('close', () => {
    console.log('\n👋 Bye!');
    process.exit(0);
  });
}

program.parse();
