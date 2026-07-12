/**
 * Run the same task on both MSGA and Claude Code, then compare results.
 */
import { OpenAIProvider } from './src/models/openai.js';
import { ExecutionEngine } from './src/core/engine.js';
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';

const TASK = `Create a REST API server in src/app.ts using Node.js + Express + TypeScript:
- POST /notes — create a note {title, content}, returns {id, title, content, createdAt}
- GET /notes — list all notes
- GET /notes/:id — get one note by id, 404 if not found
- PUT /notes/:id — update note, 404 if not found
- DELETE /notes/:id — delete note, returns 204
- Use in-memory storage (array)
- Use port 3000
- Include proper TypeScript types
Also create src/index.ts as the entry point that starts the server.
Create src/__tests__/notes.test.ts with tests for all endpoints using Node's built-in http module.`;

const MSGA_WORKING_DIR = '/Users/lijiacheng/Documents/compete/msga_demo/notes-api';
const PROVIDER_CONFIG = {
  baseUrl: 'http://127.0.0.1:8000/v1',
  apiKey: 'imking',
  model: 'gemma-4-26B-A4B-it-4bit-DWQ',
  maxTokens: 8192,
  temperature: 0.2,
};

async function main() {
  // Setup
  mkdirSync(MSGA_WORKING_DIR, { recursive: true });
  mkdirSync(`${MSGA_WORKING_DIR}/src/__tests__`, { recursive: true });

  // Write package.json
  writeFileSync(`${MSGA_WORKING_DIR}/package.json`, JSON.stringify({
    name: "notes-api",
    version: "1.0.0",
    type: "module",
    scripts: { "start": "tsx src/index.ts", "test": "vitest" },
    dependencies: { express: "^4.21.0" },
    devDependencies: { "@types/express": "^5.0.0", "@types/node": "^22.0.0", "tsx": "^4.21.0", "typescript": "^5.7.0", "vitest": "^2.1.0" }
  }, null, 2));

  writeFileSync(`${MSGA_WORKING_DIR}/tsconfig.json`, JSON.stringify({
    compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", outDir: "dist", rootDir: "src", strict: true, esModuleInterop: true, skipLibCheck: true, types: ["node", "vitest/globals"] },
    include: ["src/**/*.ts"]
  }, null, 2));

  const logs: string[] = [];
  const provider = new OpenAIProvider(PROVIDER_CONFIG as any);
  const engine = new ExecutionEngine({
    provider,
    workingDir: MSGA_WORKING_DIR,
    onContent: (chunk) => { process.stdout.write(chunk); logs.push(chunk); },
    onToolCall: (name, args) => { console.error(`  [TOOL] ${name}`); },
    onToolResult: (name, result) => { console.error(`  [RESULT] ${name} → ${JSON.stringify(result)?.slice(0,100)}`); },
  });

  console.error('\n=== MSGA RUNNING ===\n');
  const start = Date.now();
  const result = await engine.execute(TASK);
  const ms = Date.now() - start;
  console.error(`\n=== MSGA DONE in ${ms}ms ===`);
  console.error('Files created:');
  try {
    const files = (await import('fs/promises')).readdirSync(`${MSGA_WORKING_DIR}/src`, { recursive: true });
    files.forEach((f: any) => console.error(' ', f));
  } catch {}

  writeFileSync(`${MSGA_WORKING_DIR}/msga_log.txt`, logs.join(''));
  writeFileSync('/tmp/msga_result.txt', result);
  console.log(JSON.stringify({ ms, filesCount: logs.join('').match(/write_file|create|added/g)?.length || 0 }));
}

main().catch(e => { console.error(e); process.exit(1); });
