# MSGA 设计文档

## 1. 问题定义

### 1.1 现有工具的 SLM 困境

Claude Code 和 OpenCode 假设底层模型具有：
- **长上下文推理能力**（100K+ tokens 不退化）
- **复杂工具编排能力**（单次请求正确调用多个工具）
- **格式严格遵从能力**（JSON Schema 100% 合规）
- **自主纠错能力**（基于错误信息自我修复）

SLM（<30B）在这些维度上系统性弱于大模型，但在以下维度有优势：
- **短上下文推理**（<4K tokens 时质量接近大模型）
- **单任务专注**（简单明确的任务表现好）
- **推理速度**（本地推理无网络延迟）
- **并行能力**（可同时运行多个实例）

### 1.2 核心洞察

> **不要让小模型模仿大模型的工作方式，而是重新设计工作流让小模型的优势充分发挥。**

## 2. 架构设计

### 2.1 整体架构

```
用户输入
  │
  ▼
┌──────────────────────────────────────────────────────┐
│ CLI Layer (Ink/React)                                 │
│  - 用户交互                                          │
│  - 进度展示                                          │
│  - 权限确认                                          │
└──────────────────────┬───────────────────────────────┘
                       │
┌──────────────────────▼───────────────────────────────┐
│ Session Manager                                       │
│  - 会话管理                                          │
│  - 历史记录                                          │
│  - 上下文预算分配                                     │
└──────────────────────┬───────────────────────────────┘
                       │
┌──────────────────────▼───────────────────────────────┐
│ Planner (规划器)                                      │
│  - 理解用户意图                                      │
│  - 生成执行计划                                      │
│  - 拆解为原子任务                                    │
│  Model: router (3B) or coder (7-14B)                 │
└──────────────────────┬───────────────────────────────┘
                       │
          ┌────────────┼────────────┐
          ▼            ▼            ▼
    ┌──────────┐ ┌──────────┐ ┌──────────┐
    │ Atom 1   │ │ Atom 2   │ │ Atom N   │
    │(原子任务)│ │(原子任务)│ │(原子任务)│
    │独立上下文│ │独立上下文│ │独立上下文│
    └─────┬────┘ └─────┬────┘ └─────┬────┘
          │            │            │
          ▼            ▼            ▼
    ┌─────────────────────────────────────────┐
    │         Execution Engine                 │
    │  ┌─────────┐ ┌──────────┐ ┌──────────┐ │
    │  │ Output  │ │  Tool    │ │  Model   │ │
    │  │Validator│ │ Executor │ │  Router  │ │
    │  └─────────┘ └──────────┘ └──────────┘ │
    └─────────────────────────────────────────┘
                       │
                       ▼
                   工具执行结果
```

### 2.2 核心模块

#### 2.2.1 Planner（规划器）

**职责**：将用户的高层需求拆解为可独立执行的原子任务序列。

```typescript
interface AtomTask {
  id: string;
  type: 'design' | 'code' | 'test' | 'review' | 'debug' | 'refactor';
  description: string;          // 清晰的任务描述（≤200字）
  dependencies: string[];       // 依赖的其他原子任务 ID
  contextFiles: string[];       // 需要的文件（控制上下文大小）
  acceptanceCriteria: string[]; // 验收标准
  modelHint: ModelRole;         // 推荐使用的模型角色
  maxRetries: number;           // 最大重试次数（默认3）
}

interface Plan {
  atoms: AtomTask[];
  parallelGroups: string[][];   // 可并行执行的任务组
}
```

**关键设计决策**：
- 规划本身用较小模型完成（路由模型 3B），节省资源
- 每个原子任务描述精确、独立，不依赖隐式上下文
- 明确声明依赖和可并行性，支持高效执行

#### 2.2.2 Output Validator（输出校验层）

**职责**：校验模型输出格式，自动修复常见格式错误。

```typescript
interface ValidationResult {
  valid: boolean;
  fixed?: any;           // 自动修复后的输出
  errors: ValidationError[];
}

interface ValidationError {
  path: string;          // JSON path
  expected: string;      // 预期类型/值
  actual: string;        // 实际值
  autofix?: any;         // 自动修复值
}

// 校验器链
class OutputValidator {
  private validators: Validator[] = [
    new JSONSyntaxValidator(),      // 修复 JSON 语法错误
    new SchemaConformanceValidator(), // 校验 Schema 遵从
    new ToolCallValidator(),         // 校验工具调用格式
    new CodeOutputValidator(),       // 校验代码输出格式
  ];
  
  validate(output: string, schema: Schema): ValidationResult {
    // 逐步校验，尝试自动修复
  }
}
```

**自动修复策略**：
1. JSON 语法错误（缺引号、多余逗号）→ 正则修复
2. Schema 类型错误（string vs number）→ 类型转换
3. 缺少必需字段 → 用默认值填充
4. 工具名拼写错误 → 模糊匹配修正

#### 2.2.3 Model Router（模型路由器）

**职责**：根据任务类型选择最合适的模型。

```typescript
type ModelRole = 'router' | 'coder' | 'tester' | 'reviewer' | 'planner';

interface ModelConfig {
  role: ModelRole;
  provider: 'openai-compatible' | 'ollama';
  baseUrl: string;
  model: string;
  maxContextTokens: number;
  temperature: number;
}

interface ModelRegistry {
  models: Map<ModelRole, ModelConfig>;
  
  // 根据 task type 自动路由
  route(task: AtomTask): ModelConfig;
  
  // 根据上下文大小动态切换
  routeByContextSize(contextTokens: number, task: AtomTask): ModelConfig;
}
```

**路由规则**：
| 任务类型 | 模型角色 | 典型参数量 | 上下文预算 |
|---------|---------|-----------|-----------|
| 意图分类/路由 | router | 3B | 1K |
| 架构设计 | planner | 14-30B | 4K |
| 代码生成 | coder | 7-14B | 2K |
| 测试生成 | tester | 7B | 2K |
| 代码审查 | reviewer | 14-30B | 4K |
| Bug 修复 | coder | 7-14B | 2K |
| 重构 | coder + reviewer | 14B + 30B | 2K + 4K |

#### 2.2.4 Tool Layer（Schema-First 工具层）

**设计原则**：
1. **原子化**：一个工具只做一件事
2. **语义化参数**：参数名即语义
3. **示例嵌入**：description 包含调用示例
4. **强类型**：Zod schema 定义所有参数
5. **最小化输出**：工具返回精简结果，不堆砌信息

```typescript
// 示例：Schema-First 工具定义
const readFunctionTool = defineTool({
  name: 'read_function',
  description: `Read a specific function's source code.
Example: read_function file='src/auth.ts' name='validateToken'
Returns only the function body, not the entire file.`,
  inputSchema: z.object({
    file: z.string().describe('File path relative to project root'),
    name: z.string().describe('Function name to read'),
    startLine: z.number().optional().describe('Override start line'),
    endLine: z.number().optional().describe('Override end line'),
  }),
  outputSchema: z.object({
    code: z.string(),
    language: z.string(),
    startLine: z.number(),
    endLine: z.number(),
  }),
  execute: async (input) => {
    // 使用 tree-sitter 精确定位函数
  }
});

// 对比 Claude Code 的通用工具：
const readTool = defineTool({
  name: 'read',  // 太通用，SLM 难以精确使用
  description: 'Read file contents',
  inputSchema: z.object({
    file_path: z.string(),
    offset: z.number().optional(),
    limit: z.number().optional(),
  }),
});
```

**完整工具集设计**：

| 工具 | 职责 | 与 Claude Code 的区别 |
|------|------|---------------------|
| `read_function` | 读取指定函数 | 不读整个文件，tree-sitter 精确定位 |
| `read_class` | 读取指定类 | 同上 |
| `add_function` | 在文件中添加函数 | 原子操作，不是通用 edit |
| `edit_function` | 修改已有函数 | 精确定位，不传整个文件 |
| `rename_symbol` | 重命名符号 | 语义感知，非文本替换 |
| `add_import` | 添加 import | 独立原子操作 |
| `run_test_file` | 运行单个测试文件 | 不运行整个测试套件 |
| `run_test_case` | 运行单个测试用例 | 最小粒度 |
| `check_types` | 类型检查 | 快速反馈 |
| `list_symbols` | 列出文件符号 | 替代 grep，结构化 |
| `get_diagnostics` | 获取编译错误 | 精准错误信息 |
| `search_code` | 语义搜索代码 | 上下文感知搜索 |

#### 2.2.5 Context Manager（上下文管理器）

**职责**：控制每个原子任务的上下文大小和内容。

```typescript
interface ContextBudget {
  systemPrompt: number;    // 系统提示词 token 预算
  taskDescription: number;  // 任务描述 token 预算
  fileContext: number;      // 文件上下文 token 预算
  toolResults: number;      // 工具结果 token 预算
  total: number;            // 总预算
}

// 默认预算配置（基于研究：SLM 在 2-4K tokens 时表现最佳）
const DEFAULT_BUDGET: ContextBudget = {
  systemPrompt: 300,
  taskDescription: 300,
  fileContext: 1000,
  toolResults: 500,
  total: 2100,  // ~2K tokens
};

class ContextManager {
  // 为原子任务构建最优上下文
  buildContext(task: AtomTask, budget: ContextBudget): Message[];
  
  // 压缩上下文（保留关键信息）
  compress(context: Message[], targetTokens: number): Message[];
  
  // 选择最相关的代码片段
  selectRelevantCode(files: string[], query: string, maxTokens: number): CodeSnippet[];
}
```

### 2.3 执行流程

```
用户: "实现用户注册功能，包含邮箱验证"

Step 1: Planner 生成执行计划
├── Atom 1: [design] 设计注册 API 接口 (model: planner)
├── Atom 2: [code] 创建 User model/schema (model: coder) 
├── Atom 3: [code] 实现注册 API handler (model: coder, depends: 1,2)
├── Atom 4: [code] 实现邮箱验证逻辑 (model: coder, depends: 2)
├── Atom 5: [code] 编写注册 API 测试 (model: tester, depends: 3)
├── Atom 6: [code] 编写邮箱验证测试 (model: tester, depends: 4)
├── Atom 7: [test] 运行所有测试 (model: tester, depends: 5,6)
└── Atom 8: [review] 代码审查 (model: reviewer, depends: 7)

Step 2: 执行 Atom 1 (设计)
  Model: planner (14-30B)
  Context: [系统提示 300t] + [任务描述 200t] + [项目结构 500t] = 1K
  Output: API 接口设计文档
  Validator: ✅ 通过

Step 3: 并行执行 Atom 2, 4 (无依赖)
  Atom 2: Model: coder (7B), Context: [设计文档摘要 + 目标文件]
  Atom 4: Model: coder (7B), Context: [设计文档摘要 + User schema]

... 依次执行

Step 8: 执行 Atom 8 (审查)
  Model: reviewer (14-30B)
  Context: [所有变更的摘要 + 关键代码片段] = 3K
  Output: 审查意见
```

### 2.4 与 Claude Code 的关键差异

| 维度 | Claude Code | MSGA |
|------|------------|------|
| **Tool 定义** | `Read(file_path, offset, limit)` | `read_function(file, name)` |
| **上下文** | 累积式，30K+ tokens | 每任务独立，2K tokens |
| **模型** | 固定 Claude | 按任务路由不同本地模型 |
| **纠错** | 让模型重试 | 输出校验层自动修复 |
| **任务** | 单一大任务 | 自动拆解为原子任务 |
| **并行** | 有限（subagent） | 原子任务天然可并行 |
| **Token 效率** | 高消耗（每次传大量上下文） | 低消耗（精确注入） |

## 3. 实现计划

### Phase 1: MVP（核心框架）
- [ ] CLI 框架（Ink + commander）
- [ ] 模型 Provider 抽象层（OpenAI 兼容 API）
- [ ] 基础工具集（read_function, add_function, edit_function, bash）
- [ ] 输出校验层（JSON Schema + 自动修复）
- [ ] 单模型执行引擎（不拆任务，先用一个好模型）

### Phase 2: 多模型编排
- [ ] Planner 模块（任务拆解）
- [ ] Model Router（按任务路由模型）
- [ ] 上下文管理器（渐进式注入）
- [ ] 并行执行引擎

### Phase 3: 高级功能
- [ ] Tree-sitter 集成（代码结构感知）
- [ ] 自适应工具调用阈值
- [ ] 代码审查模式
- [ ] 会话持久化与恢复
- [ ] MCP 协议支持

### Phase 4: 生态
- [x] 代码审查模式 (src/core/reviewer.ts)
- [x] 会话持久化与恢复 (src/core/session.ts)
- [x] MCP 协议支持 (src/core/mcp-client.ts)
- [ ] VSCode 扩展
- [ ] 模型配置市场
- [ ] 工具插件系统
