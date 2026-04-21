/**
 * MSGA Tool Definitions - Schema-First Design
 * Each tool is atomic, semantic, and includes examples in descriptions.
 * Research finding: Schema quality is the #1 factor for SLM tool calling success.
 */

import { z } from 'zod';

export interface ToolDef<
  TInput extends z.ZodType = z.ZodType,
  TOutput extends z.ZodType = z.ZodType,
> {
  name: string;
  description: string;
  inputSchema: TInput;
  outputSchema?: TOutput;
  execute: (input: z.infer<TInput>) => Promise<z.infer<TOutput>>;
}

/**
 * Read a specific function's source code.
 * Atomic: only reads one function, not the whole file.
 */
export const readFunctionTool: ToolDef = {
  name: 'read_function',
  description: `Read a specific function's source code from a file. Returns only the function body.
Example: read_function file="src/auth.ts" name="validateToken"
Example: read_function file="lib/calculator.py" name="add"`,
  inputSchema: z.object({
    file: z.string().describe('File path relative to project root'),
    name: z.string().describe('Exact function name to read'),
  }),
  execute: async ({ file, name }) => {
    const fs = await import('fs/promises');
    const path = await import('path');
    const fullPath = path.resolve(file);
    const content = await fs.readFile(fullPath, 'utf-8');

    // Try tree-sitter first (precise)
    try {
      const { findSymbol } = await import('../core/code-parser.js');
      const sym = findSymbol(fullPath, content, name);
      if (sym) {
        return {
          code: sym.text,
          language: fullPath.endsWith('.py') ? 'python' : 'typescript',
          startLine: sym.startRow,
          endLine: sym.endRow,
          file,
        };
      }
    } catch { /* tree-sitter not available, fallback to regex */ }

    // Fallback: regex-based extraction
    const patterns = [
      // JS/TS: function name(...) { ... }
      new RegExp(
        `(?:export\\s+)?(?:async\\s+)?function\\s+${escapeRegex(name)}\\s*\\([^)]*\\)\\s*(?::\\s*[^{]+)?\\{`,
        'm'
      ),
      // JS/TS: const name = (...) => { ... }
      new RegExp(
        `(?:export\\s+)?(?:const|let|var)\\s+${escapeRegex(name)}\\s*=\\s*(?:async\\s*)?\\([^)]*\\)\\s*(?::\\s*[^=]+)?=>`
      ),
      // Python: def name(...):
      new RegExp(`def\\s+${escapeRegex(name)}\\s*\\([^)]*\\)\\s*(?:->\\s*[^:]+)?:`),
    ];

    for (const pattern of patterns) {
      const match = content.match(pattern);
      if (match) {
        const startLine = content.substring(0, match.index).split('\n').length;
        const body = extractBlock(content, match.index!);
        return {
          code: body,
          language: file.endsWith('.py') ? 'python' : file.endsWith('.ts') || file.endsWith('.tsx') ? 'typescript' : 'javascript',
          startLine,
          endLine: startLine + body.split('\n').length - 1,
          file,
        };
      }
    }

    throw new Error(`Function '${name}' not found in ${file}`);
  },
};

/**
 * Read a specific class definition.
 */
export const readClassTool: ToolDef = {
  name: 'read_class',
  description: `Read a class definition from a file. Returns the class body including all methods.
Example: read_class file="src/models/user.ts" name="UserService"`,
  inputSchema: z.object({
    file: z.string().describe('File path relative to project root'),
    name: z.string().describe('Class name to read'),
  }),
  execute: async ({ file, name }) => {
    const fs = await import('fs/promises');
    const path = await import('path');
    const content = await fs.readFile(path.resolve(file), 'utf-8');

    const pattern = new RegExp(
      `(?:export\\s+)?(?:abstract\\s+)?class\\s+${escapeRegex(name)}\\s*(?:extends\\s+\\S+\\s*)?(?:implements\\s+[^{]+)?\\{`,
      'm'
    );

    const match = content.match(pattern);
    if (match) {
      const startLine = content.substring(0, match.index).split('\n').length;
      const body = extractBlock(content, match.index!);
      return {
        code: body,
        language: file.endsWith('.py') ? 'python' : 'typescript',
        startLine,
        endLine: startLine + body.split('\n').length - 1,
        file,
      };
    }

    throw new Error(`Class '${name}' not found in ${file}`);
  },
};

/**
 * Add a new function to a file.
 * Atomic: only adds one function.
 */
export const addFunctionTool: ToolDef = {
  name: 'add_function',
  description: `Add a new function to an existing file. The function is inserted before the specified anchor or at end of file.
Example: add_function file="src/utils.ts" name="formatDate" code="function formatDate(d: Date): string { return d.toISOString(); }" insert_after="parseDate"`,
  inputSchema: z.object({
    file: z.string().describe('File path relative to project root'),
    name: z.string().describe('Function name being added'),
    code: z.string().describe('Complete function code to insert'),
    insert_after: z.string().optional().describe('Function name to insert after. Omit to append at end.'),
  }),
  execute: async ({ file, code, insert_after }) => {
    const fs = await import('fs/promises');
    const path = await import('path');
    const fullPath = path.resolve(file);
    let content = await fs.readFile(fullPath, 'utf-8');

    if (insert_after) {
      const pattern = new RegExp(
        `(?:export\\s+)?(?:async\\s+)?function\\s+${escapeRegex(insert_after)}[\\s\\S]*?\\n\\n`,
        'm'
      );
      const match = content.match(pattern);
      if (match && match.index !== undefined) {
        const insertPos = match.index + match[0].length;
        content = content.slice(0, insertPos) + '\n' + code + '\n' + content.slice(insertPos);
      } else {
        content += '\n\n' + code;
      }
    } else {
      content += '\n\n' + code + '\n';
    }

    await fs.writeFile(fullPath, content, 'utf-8');
    return { success: true, file, action: 'added' };
  },
};

/**
 * Edit an existing function.
 */
export const editFunctionTool: ToolDef = {
  name: 'edit_function',
  description: `Replace a function's implementation with new code.
Example: edit_function file="src/auth.ts" name="validateToken" new_code="function validateToken(t: string): boolean { return jwt.verify(t, SECRET) !== null; }"`,
  inputSchema: z.object({
    file: z.string().describe('File path'),
    name: z.string().describe('Function name to edit'),
    new_code: z.string().describe('Complete replacement function code'),
  }),
  execute: async ({ file, name, new_code }) => {
    const fs = await import('fs/promises');
    const path = await import('path');
    const fullPath = path.resolve(file);
    let content = await fs.readFile(fullPath, 'utf-8');

    // Find function pattern
    const patterns = [
      new RegExp(
        `((?:export\\s+)?(?:async\\s+)?function\\s+${escapeRegex(name)}\\s*\\([^)]*\\)\\s*(?::\\s*[^{]+)?\\{[\\s\\S]*?\\n\\})`,
        'm'
      ),
    ];

    for (const pattern of patterns) {
      const match = content.match(pattern);
      if (match) {
        content = content.replace(match[0], new_code);
        await fs.writeFile(fullPath, content, 'utf-8');
        return { success: true, file, function: name, action: 'edited' };
      }
    }

    throw new Error(`Function '${name}' not found in ${file}`);
  },
};

/**
 * Rename a symbol across the project.
 */
export const renameSymbolTool: ToolDef = {
  name: 'rename_symbol',
  description: `Rename a symbol (function, class, variable) in a specific file or across all project files.
Example: rename_symbol old_name="getUserData" new_name="fetchUserProfile" scope="src/"`,
  inputSchema: z.object({
    old_name: z.string().describe('Current symbol name'),
    new_name: z.string().describe('New symbol name'),
    scope: z.string().describe('File or directory to apply rename. Use "." for entire project.'),
  }),
  execute: async ({ old_name, new_name, scope }) => {
    const fs = await import('fs/promises');
    const path = await import('path');
    const { glob } = await import('glob');

    const pattern = path.extname(scope)
      ? scope
      : `${scope}/**/*.{ts,tsx,js,jsx,py}`;

    const files = await glob(pattern, { ignore: ['**/node_modules/**', '**/.git/**'] });
    let totalReplacements = 0;

    for (const file of files) {
      let content = await fs.readFile(file, 'utf-8');
      // Word boundary rename to avoid partial matches
      const regex = new RegExp(`\\b${escapeRegex(old_name)}\\b`, 'g');
      const matches = content.match(regex);
      if (matches) {
        content = content.replace(regex, new_name);
        await fs.writeFile(file, content, 'utf-8');
        totalReplacements += matches.length;
      }
    }

    return { success: true, replacements: totalReplacements, files: files.length };
  },
};

/**
 * Add an import statement.
 */
export const addImportTool: ToolDef = {
  name: 'add_import',
  description: `Add an import statement to the top of a file. Checks for duplicates.
Example: add_import file="src/auth.ts" statement="import jwt from 'jsonwebtoken';"`,
  inputSchema: z.object({
    file: z.string().describe('File path'),
    statement: z.string().describe('Complete import statement to add'),
  }),
  execute: async ({ file, statement }) => {
    const fs = await import('fs/promises');
    const path = await import('path');
    const fullPath = path.resolve(file);
    let content = await fs.readFile(fullPath, 'utf-8');

    // Check for duplicate
    if (content.includes(statement.trim())) {
      return { success: true, action: 'skipped_duplicate' };
    }

    // Find last import line
    const lines = content.split('\n');
    let lastImportIdx = -1;
    for (let i = 0; i < lines.length; i++) {
      if (/^import\s/.test(lines[i].trim()) || /^from\s/.test(lines[i].trim())) {
        lastImportIdx = i;
      }
    }

    const insertIdx = lastImportIdx >= 0 ? lastImportIdx + 1 : 0;
    lines.splice(insertIdx, 0, statement);
    await fs.writeFile(fullPath, lines.join('\n'), 'utf-8');

    return { success: true, action: 'added', file };
  },
};

/**
 * Run tests for a specific file.
 */
export const runTestFileTool: ToolDef = {
  name: 'run_test_file',
  description: `Run all tests in a specific test file. Returns pass/fail summary and any errors.
Example: run_test_file file="src/auth.test.ts"
Example: run_test_file file="tests/test_calculator.py"`,
  inputSchema: z.object({
    file: z.string().describe('Test file path to run'),
    runner: z.enum(['vitest', 'jest', 'pytest', 'auto']).default('auto').describe('Test runner to use'),
  }),
  execute: async ({ file, runner }) => {
    const { execSync } = await import('child_process');
    let cmd: string;

    if (runner === 'auto') {
      if (file.endsWith('.py')) cmd = `python -m pytest ${file} -v --tb=short 2>&1`;
      else if (file.includes('vitest') || file.includes('.test.')) cmd = `npx vitest run ${file} 2>&1`;
      else cmd = `npx jest ${file} 2>&1`;
    } else {
      const cmds: Record<string, string> = {
        vitest: `npx vitest run ${file}`,
        jest: `npx jest ${file}`,
        pytest: `python -m pytest ${file} -v --tb=short`,
      };
      cmd = cmds[runner] + ' 2>&1';
    }

    try {
      const output = execSync(cmd, { encoding: 'utf-8', timeout: 60000, maxBuffer: 1024 * 1024 });
      return { success: true, output: output.slice(-2000), file };
    } catch (e: any) {
      return {
        success: false,
        output: (e.stdout || '' + e.stderr || '').slice(-2000),
        file,
        error: e.message?.slice(0, 200),
      };
    }
  },
};

/**
 * Run a single test case by name.
 */
export const runTestCaseTool: ToolDef = {
  name: 'run_test_case',
  description: `Run a single specific test case by name. Most granular test execution.
Example: run_test_case file="src/auth.test.ts" name="should reject expired tokens"`,
  inputSchema: z.object({
    file: z.string().describe('Test file path'),
    name: z.string().describe('Test case name/pattern to run'),
  }),
  execute: async ({ file, name }) => {
    const { execSync } = await import('child_process');
    let cmd: string;

    if (file.endsWith('.py')) {
      cmd = `python -m pytest ${file} -k "${name}" -v --tb=short 2>&1`;
    } else {
      cmd = `npx vitest run ${file} -t "${name}" 2>&1`;
    }

    try {
      const output = execSync(cmd, { encoding: 'utf-8', timeout: 30000, maxBuffer: 1024 * 1024 });
      return { success: true, output: output.slice(-2000), file, testCase: name };
    } catch (e: any) {
      return {
        success: false,
        output: (e.stdout || '' + e.stderr || '').slice(-2000),
        file,
        testCase: name,
      };
    }
  },
};

/**
 * Get compiler/linter diagnostics for a file.
 */
export const getDiagnosticsTool: ToolDef = {
  name: 'get_diagnostics',
  description: `Get type-checking and linting errors for a specific file. Returns structured error list.
Example: get_diagnostics file="src/auth.ts"`,
  inputSchema: z.object({
    file: z.string().describe('File path to check'),
    type: z.enum(['typecheck', 'lint', 'all']).default('all').describe('Type of diagnostics'),
  }),
  execute: async ({ file, type }) => {
    const { execSync } = await import('child_process');
    const errors: Array<{ line: number; message: string; severity: string }> = [];

    if (type !== 'lint' && file.match(/\.(ts|tsx)$/)) {
      try {
        execSync(`npx tsc --noEmit ${file} 2>&1`, { encoding: 'utf-8', timeout: 30000 });
      } catch (e: any) {
        const output = e.stdout || e.message || '';
        for (const line of output.split('\n')) {
          const match = line.match(/(.+)\((\d+),(\d+)\):\s+error\s+(.+)/);
          if (match) {
            errors.push({ line: Number.parseInt(match[2]), message: match[4], severity: 'error' });
          }
        }
      }
    }

    return { file, errors, count: errors.length };
  },
};

/**
 * List symbols (functions, classes) in a file.
 */
export const listSymbolsTool: ToolDef = {
  name: 'list_symbols',
  description: `List all function and class names in a file. Returns structured list with line numbers.
Example: list_symbols file="src/auth.ts"`,
  inputSchema: z.object({
    file: z.string().describe('File path to analyze'),
    type: z.enum(['function', 'class', 'all']).default('all').describe('Symbol type to list'),
  }),
  execute: async ({ file, type }) => {
    const fs = await import('fs/promises');
    const path = await import('path');
    const fullPath = path.resolve(file);
    const content = await fs.readFile(fullPath, 'utf-8');

    // Try tree-sitter first
    try {
      const { parseFile } = await import('../core/code-parser.js');
      const structure = parseFile(fullPath, content);
      if (structure) {
        let syms = structure.symbols;
        if (type === 'function') syms = syms.filter(s => s.kind === 'function');
        if (type === 'class') syms = syms.filter(s => s.kind === 'class');
        return {
          file,
          symbols: syms.map(s => ({
            name: s.name,
            kind: s.kind,
            line: s.startRow,
            ...(s.children?.length ? { methods: s.children.map(c => ({ name: c.name, line: c.startRow })) } : {}),
          })),
        };
      }
    } catch { /* fallback to regex */ }

    // Fallback: regex-based
    const lines = content.split('\n');
    const symbols: Array<{ name: string; kind: string; line: number }> = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      if (type !== 'class') {
        const fnMatch = line.match(
          /(?:export\s+)?(?:async\s+)?function\s+(\w+)|(?:export\s+)?(?:const|let)\s+(\w+)\s*=\s*(?:async\s*)?\(/
        );
        if (fnMatch) {
          symbols.push({ name: fnMatch[1] || fnMatch[2], kind: 'function', line: i + 1 });
        }

        const pyFnMatch = line.match(/def\s+(\w+)\s*\(/);
        if (pyFnMatch) {
          symbols.push({ name: pyFnMatch[1], kind: 'function', line: i + 1 });
        }
      }

      if (type !== 'function') {
        const classMatch = line.match(/(?:export\s+)?class\s+(\w+)/);
        if (classMatch) {
          symbols.push({ name: classMatch[1], kind: 'class', line: i + 1 });
        }
      }
    }

    return { file, symbols };
  },
};

/**
 * Write a complete file (create or overwrite).
 */
export const write_fileTool: ToolDef = {
  name: 'write_file',
  description: `Write content to a file. Creates the file if it doesn't exist, overwrites if it does. Use this to create new files.
Example: write_file path="src/main.py" content="print('hello')"
Example: write_file path="README.md" content="# My Project"`,
  inputSchema: z.object({
    path: z.string().describe('File path relative to project root'),
    content: z.string().describe('Complete file content to write'),
  }),
  execute: async ({ path: filePath, content }) => {
    const fs = await import('fs/promises');
    const path = await import('path');
    const fullPath = path.resolve(filePath);
    // Ensure parent directory exists
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, content, 'utf-8');
    return { success: true, file: filePath, size: content.length };
  },
};

/**
 * Read an entire file.
 */
export const read_fileTool: ToolDef = {
  name: 'read_file',
  description: `Read the entire content of a file.
Example: read_file path="src/main.py"`,
  inputSchema: z.object({
    path: z.string().describe('File path relative to project root'),
  }),
  execute: async ({ path: filePath }) => {
    const fs = await import('fs/promises');
    const path = await import('path');
    const fullPath = path.resolve(filePath);
    const content = await fs.readFile(fullPath, 'utf-8');
    return { content, file: filePath, lines: content.split('\n').length };
  },
};

/**
 * Execute a bash command.
 */
export const bashTool: ToolDef = {
  name: 'bash',
  description: `Execute a shell command. Use for running builds, installs, git, and other CLI operations.
Example: bash command="npm test"
Example: bash command="git status"`,
  inputSchema: z.object({
    command: z.string().describe('Shell command to execute'),
    timeout: z.number().default(30).describe('Timeout in seconds'),
  }),
  execute: async ({ command, timeout }) => {
    const { execSync } = await import('child_process');
    try {
      const output = execSync(command, {
        encoding: 'utf-8',
        timeout: timeout * 1000,
        maxBuffer: 5 * 1024 * 1024,
        cwd: process.cwd(),
      });
      return { success: true, output: output.slice(-3000), command };
    } catch (e: any) {
      return {
        success: false,
        output: (e.stdout || '') + (e.stderr || ''),
        exitCode: e.status,
        command,
      };
    }
  },
};

/**
 * Search code with grep-like functionality.
 */
export const searchCodeTool: ToolDef = {
  name: 'search_code',
  description: `Search for a pattern in project files. Returns matching lines with context.
Example: search_code pattern="validateToken" scope="src/"`,
  inputSchema: z.object({
    pattern: z.string().describe('Search pattern (literal or regex)'),
    scope: z.string().default('.').describe('Directory to search in'),
    file_type: z.string().default('*.{ts,tsx,js,jsx,py}').describe('File glob pattern'),
    max_results: z.number().default(20).describe('Maximum number of results'),
  }),
  execute: async ({ pattern, scope, file_type, max_results }) => {
    const { execSync } = await import('child_process');
    const cmd = `grep -rn --include="${file_type}" "${pattern.replace(/"/g, '\\"')}" ${scope} 2>/dev/null | head -${max_results}`;
    try {
      const output = execSync(cmd, { encoding: 'utf-8', timeout: 10000 });
      const matches = output.trim().split('\n').filter(Boolean).map(line => {
        const [file, lineno, ...rest] = line.split(':');
        return { file, line: Number.parseInt(lineno), text: rest.join(':').trim() };
      });
      return { matches, count: matches.length, pattern };
    } catch {
      return { matches: [], count: 0, pattern };
    }
  },
};

// --- Helpers ---

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractBlock(content: string, startIndex: number): string {
  let depth = 0;
  let i = startIndex;
  // Find the opening brace
  while (i < content.length && content[i] !== '{') i++;
  const start = i;

  for (; i < content.length; i++) {
    if (content[i] === '{') depth++;
    else if (content[i] === '}') {
      depth--;
      if (depth === 0) break;
    }
  }

  return content.substring(start, i + 1);
}

/**
 * All tools registry
 */
export const ALL_TOOLS: ToolDef[] = [
  write_fileTool,
  read_fileTool,
  bashTool,
  searchCodeTool,
  listSymbolsTool,
  readFunctionTool,
  readClassTool,
  addFunctionTool,
  editFunctionTool,
  renameSymbolTool,
  addImportTool,
  runTestFileTool,
  runTestCaseTool,
  getDiagnosticsTool,
];

export function getToolsAsOpenAIFormat(): Array<{
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}> {
  return ALL_TOOLS.map(t => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: zodToJsonSchema(t.inputSchema),
    },
  }));
}

function zodToJsonSchema(schema: z.ZodType): Record<string, unknown> {
  // Simplified Zod → JSON Schema conversion
  if (schema instanceof z.ZodObject) {
    const properties: Record<string, unknown> = {};
    const required: string[] = [];

    for (const [key, value] of Object.entries(schema.shape)) {
      properties[key] = zodToJsonSchema(value as z.ZodType);
      if (!(value instanceof z.ZodOptional)) {
        required.push(key);
      }
    }

    return {
      type: 'object',
      properties,
      required: required.length > 0 ? required : undefined,
    };
  }

  if (schema instanceof z.ZodString) {
    const result: Record<string, unknown> = { type: 'string' };
    if (schema.description) result.description = schema.description;
    return result;
  }
  if (schema instanceof z.ZodNumber) return { type: 'number' };
  if (schema instanceof z.ZodBoolean) return { type: 'boolean' };
  if (schema instanceof z.ZodArray) return { type: 'array', items: zodToJsonSchema(schema.element) };
  if (schema instanceof z.ZodEnum) return { type: 'string', enum: schema.options };
  if (schema instanceof z.ZodOptional) return zodToJsonSchema(schema.unwrap());
  if (schema instanceof z.ZodDefault) return zodToJsonSchema(schema.removeDefault());

  return { type: 'string' };
}
