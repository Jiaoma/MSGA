/**
 * MSGA Planner Prompts - SLM-friendly task decomposition prompts
 * Research: keep prompts under 500 tokens for best SLM performance
 */

export const PLANNER_SYSTEM_PROMPT = `You are a task planner for a coding agent. Break down coding tasks into small, independent atomic tasks.

Rules:
- Each task must be completable in one model turn (read a function, write a function, run a test, etc.)
- Tasks with no dependencies between them should be in the same parallel group
- Always include a review task at the end
- Output ONLY valid JSON, no markdown

Output format:
{
  "atoms": [
    {
      "id": "a1",
      "type": "code|test|design|review|debug|refactor",
      "description": "What to do (under 100 chars)",
      "dependencies": [],
      "contextFiles": ["relevant/file.ts"],
      "modelHint": "coder|tester|reviewer|planner"
    }
  ],
  "parallelGroups": [["a1","a2"], ["a3"]]
}`;

export const PLANNER_EXAMPLES = [
  {
    input: "实现用户注册 API",
    output: {
      atoms: [
        { id: "a1", type: "design", description: "设计注册 API 接口（POST /api/register，参数：email, password, name）", dependencies: [], contextFiles: ["src/routes/"], modelHint: "planner" },
        { id: "a2", type: "code", description: "创建 User model/schema（email, passwordHash, name, createdAt）", dependencies: [], contextFiles: ["src/models/"], modelHint: "coder" },
        { id: "a3", type: "code", description: "实现 POST /api/register handler（验证输入、hash密码、存DB）", dependencies: ["a1", "a2"], contextFiles: ["src/routes/auth.ts", "src/models/user.ts"], modelHint: "coder" },
        { id: "a4", type: "code", description: "编写注册 API 的单元测试", dependencies: ["a3"], contextFiles: ["src/routes/auth.ts", "tests/"], modelHint: "tester" },
        { id: "a5", type: "test", description: "运行注册相关测试", dependencies: ["a4"], contextFiles: ["tests/"], modelHint: "tester" },
        { id: "a6", type: "review", description: "审查注册实现的代码质量", dependencies: ["a5"], contextFiles: ["src/routes/auth.ts", "src/models/user.ts"], modelHint: "reviewer" },
      ],
      parallelGroups: [["a1", "a2"], ["a3"], ["a4"], ["a5"], ["a6"]],
    },
  },
  {
    input: "fix the failing test in auth.test.ts",
    output: {
      atoms: [
        { id: "a1", type: "debug", description: "读取失败的测试用例和错误信息", dependencies: [], contextFiles: ["tests/auth.test.ts"], modelHint: "coder" },
        { id: "a2", type: "debug", description: "读取被测试的源代码，定位 bug", dependencies: ["a1"], contextFiles: ["src/auth.ts"], modelHint: "coder" },
        { id: "a3", type: "code", description: "修复 bug", dependencies: ["a2"], contextFiles: ["src/auth.ts"], modelHint: "coder" },
        { id: "a4", type: "test", description: "运行测试验证修复", dependencies: ["a3"], contextFiles: ["tests/auth.test.ts"], modelHint: "tester" },
      ],
      parallelGroups: [["a1"], ["a2"], ["a3"], ["a4"]],
    },
  },
];

/**
 * Build planner prompt with project context
 */
export function buildPlannerPrompt(task: string, projectFiles?: string[]): string {
  let prompt = `Decompose this task into atomic sub-tasks:\n\n"${task}"`;

  if (projectFiles && projectFiles.length > 0) {
    prompt += `\n\nProject files (for context):\n${projectFiles.slice(0, 30).map(f => `- ${f}`).join('\n')}`;
  }

  prompt += `\n\n${PLANNER_EXAMPLES[0].output.atoms.length > 0 ? 'Example decomposition for "' + PLANNER_EXAMPLES[0].input + '":\n' + JSON.stringify(PLANNER_EXAMPLES[0].output, null, 2) : ''}`;

  return prompt;
}
