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
import * as readline from 'readline';

const VERSION = '0.1.0';

const program = new Command();

program
  .name('msga')
  .description('MSGA - AI coding agent optimized for small language models')
  .version(VERSION);

program
  .argument('[task]', 'Task to execute')
  .option('-m, --model <model>', 'Model to use (default: from config)')
  .option('--base-url <url>', 'API base URL', 'http://127.0.0.1:8000/v1')
  .option('--api-key <key>', 'API key')
  .option('-d, --dir <path>', 'Working directory', process.cwd())
  .option('-v, --verbose', 'Verbose output')
  .option('-p, --plan', 'Use multi-model planning mode (Phase 2)')
  .action(async (task: string | undefined, opts: any) => {
    const registry = ModelRegistry.fromConfig({
      baseUrl: opts.baseUrl,
      apiKey: opts.apiKey,
      models: opts.model
        ? {
            coder: { model: opts.model },
            router: { model: opts.model },
            tester: { model: opts.model },
            reviewer: { model: opts.model },
            planner: { model: opts.model },
          }
        : undefined,
    });

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
          // Multi-model orchestration mode
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
      // Interactive mode
      await interactiveMode(provider, opts);
    }
  });

// Config command
program
  .command('config')
  .description('Manage MSGA configuration')
  .addCommand(
    new Command('set')
      .description('Set a config value')
      .argument('<key>', 'Config key (e.g., baseUrl, model)')
      .argument('<value>', 'Config value')
      .action(async (key: string, value: string) => {
        const fs = await import('fs');
        const path = await import('path');
        const configPath = path.join(process.env.HOME || '~', '.msga', 'config.json');
        let config: Record<string, string> = {};

        try {
          config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        } catch {}

        config[key] = value;
        fs.mkdirSync(path.dirname(configPath), { recursive: true });
        fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
        console.log(`✅ Set ${key} = ${value}`);
      })
  )
  .addCommand(
    new Command('get')
      .description('Get a config value')
      .argument('[key]', 'Config key')
      .action(async (key?: string) => {
        const fs = await import('fs');
        const path = await import('path');
        const configPath = path.join(process.env.HOME || '~', '.msga', 'config.json');

        try {
          const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
          if (key) {
            console.log(config[key] || '(not set)');
          } else {
            console.log(JSON.stringify(config, null, 2));
          }
        } catch {
          console.log('(no config)');
        }
      })
  );

// Models command
program
  .command('models')
  .description('List available models')
  .action(async () => {
    const registry = new ModelRegistry();
    console.log('Registered model roles:');
    for (const role of ['router', 'coder', 'tester', 'reviewer', 'planner']) {
      const provider = registry.get(role as any);
      console.log(`  ${role}: ${provider.config.model} @ ${provider.config.baseUrl}`);
    }
  });

// Review command
program
  .command('review')
  .description('Review code files')
  .argument('<files...>', 'Files to review')
  .option('-m, --model <model>', 'Model for review')
  .option('--base-url <url>', 'API base URL', 'http://127.0.0.1:8000/v1')
  .action(async (files: string[], opts: any) => {
    const registry = ModelRegistry.fromConfig({ baseUrl: opts.baseUrl });
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

// Sessions command
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
