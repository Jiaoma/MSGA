# MSGA - Make Small language models Great Again

> 让本地小模型成为优秀的软件工程师。

## 🎯 项目愿景

MSGA 是一个**专为小语言模型（SLM, <30B 参数）设计的 AI 编码 Agent**。它不是 Claude Code 或 OpenCode 的简单替代品——而是**从底层重新思考**编码 Agent 的架构，让小模型在软件设计、代码编写和测试工作中发挥最大潜力。

### 为什么需要 MSGA？

| 问题 | Claude Code / OpenCode | MSGA |
|------|----------------------|------|
| 设计假设 | 一个大模型搞定一切 | 多个专用小模型协作 |
| 上下文管理 | 累积式，越来越长 | 原子式，每任务独立 |
| 工具设计 | 通用工具，SLM 难调用 | Schema-First 原子工具 |
| 错误处理 | 让模型自己重试 | 输出校验层 + 自动修复 |
| 任务粒度 | "重构整个模块" | 自动拆解为原子操作 |
| 模型切换 | 固定一个模型 | 按任务类型路由不同模型 |

### 研究基础

MSGA 的架构设计基于以下学术研究成果（详见 `docs/research/`）：

- **ToolACE** (ICLR 2025): 训练数据质量 > 参数量
- **Small Models, Big Tasks** (2025): SLM 瓶颈是格式遵从而非语义理解
- **SMART / When2Call** (2025): 工具调用决策与参数量呈倒U型关系
- **UniToolCall** (2026): 评估方法影响对模型能力的判断
- **SLM Efficient Tool Calling** (2025): Fine-tuned SLM 可超越未微调 LLM

## 🏗️ 核心架构

```
┌─────────────────────────────────────────────────────┐
│                    MSGA Runtime                       │
│                                                      │
│  ┌──────────┐  ┌──────────┐  ┌───────────────────┐  │
│  │ Planner  │  │ Router   │  │ Output Validator   │  │
│  │ (规划器) │  │ (路由器) │  │ (输出校验层)       │  │
│  └────┬─────┘  └────┬─────┘  └────────┬──────────┘  │
│       │              │                  │             │
│  ┌────▼──────────────▼──────────────────▼──────────┐ │
│  │              Task Atomizer (任务原子化器)          │ │
│  │    大任务 → 多个独立原子任务，每个独立上下文        │ │
│  └────────────────────┬───────────────────────────┘  │
│                       │                               │
│  ┌────────────────────▼───────────────────────────┐  │
│  │          Model Orchestrator (模型编排器)          │  │
│  │                                                  │  │
│  │  ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐   │  │
│  │  │ Router │ │ Coder  │ │ Tester │ │Reviewr │   │  │
│  │  │  3B    │ │ 7-14B  │ │  7B    │ │ 14-30B │   │  │
│  │  └────────┘ └────────┘ └────────┘ └────────┘   │  │
│  └─────────────────────────────────────────────────┘  │
│                       │                               │
│  ┌────────────────────▼───────────────────────────┐  │
│  │          Schema-First Tool Layer                 │  │
│  │    原子化、强类型、SLM 友好的工具接口              │  │
│  └─────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────┘
```

## 🔑 核心设计原则

### 1. 任务原子化 (Task Atomization)
大任务自动拆解为多个独立的原子任务，每个任务独立上下文，避免长上下文退化。

### 2. Schema-First 工具设计
每个工具接口精心设计，参数名即语义，description 包含示例，enum 代替自由文本。

### 3. 输出校验层 (Output Validation)
SLM 输出经过 JSON Schema 校验，格式错误自动修复而非重试。

### 4. 多模型编排 (Multi-Model Orchestration)
不同任务类型路由到不同模型：路由→3B，编码→7-14B，测试→7B，审查→14-30B。

### 5. 渐进式上下文注入 (Progressive Context)
上下文按需注入，每步只传递必要信息，而非累积全部历史。

### 6. 自适应工具调用 (Adaptive Tool Calling)
根据任务复杂度和模型置信度动态决定是否调用工具，避免过度调用和调用不足。

## 📦 技术栈

- **语言**: TypeScript / Node.js
- **模型后端**: OpenAI 兼容 API（oMLX / Ollama / LM Studio）
- **CLI 框架**: Ink (React for CLI)
- **Schema 校验**: Zod
- **代码解析**: Tree-sitter
- **测试框架**: Vitest

## 🚀 快速开始

### 从源码安装

```bash
# 克隆仓库
git clone https://github.com/your-org/msga.git
cd msga

# 构建项目（必须，生成 dist/ 目录）
npm run build

# 全局安装
npm install -g .

# 验证安装
msga --version
```

> ⚠️ **必须先 `npm run build` 再 `npm install -g .`**
> 项目使用 TypeScript，`bin` 入口指向编译后的 `dist/cli.js`。跳过构建步骤会导致 `msga` 命令不可用。

### 配置模型

MSGA 使用 OpenAI 兼容 API，支持 oMLX、Ollama、LM Studio 等本地模型服务。

#### 模型角色

MSGA 内置 5 个模型角色，不同任务自动路由到对应模型：

| 角色 | 默认模型 | 用途 | 建议大小 |
|------|---------|------|----------|
| `router` | qwen3-4b | 任务路由/分类 | 3-4B |
| `coder` | qwen3-coder-7b | 代码编写 | 7-14B |
| `tester` | qwen3-coder-7b | 测试生成 | 7B |
| `reviewer` | qwen3-14b | 代码审查 | 14-30B |
| `planner` | qwen3-14b | 任务规划 | 14-30B |

#### 配置系统概览

MSGA 使用**模型配置文件 (Model Profile)** + **角色分配 (Role Assignment)** 的配置方式：

- **模型配置文件**：定义一个模型的完整连接信息（地址、密钥、模型名）
- **角色分配**：将 5 个内置角色（router/coder/tester/reviewer/planner）映射到不同的配置文件

配置存储在 `~/.msga/config.json`。

#### 快速开始（单模型）

```bash
# 交互式快速配置：一个模型用于所有角色
msga config quick-setup
```

向导会引导你输入 provider 类型、API 地址、API Key（可选）和模型名称。

#### 多模型配置（推荐）

为不同角色分配不同模型，让小模型做路由、大模型做编码和审查：

```bash
# 1. 添加多个模型配置文件
msga config add-model
# 按提示添加，例如：
#   - profile "q4b" → qwen3-4b (用于 router)
#   - profile "qcoder" → qwen3-coder-7b (用于 coder/tester)
#   - profile "q14b" → qwen3-14b (用于 reviewer/planner)

# 2. 交互式分配角色
msga config roles
# 为每个角色选择对应的配置文件

# 3. 查看配置结果
msga config show
```

#### 非交互式配置

```bash
# 设置顶层快捷值（会更新所有已有配置文件，或自动创建 default 配置文件）
msga config set baseUrl http://localhost:11434/v1
msga config set apiKey sk-your-key
msga config set model qwen3-14b

# 设置角色 → 配置文件映射
msga config set model.router q4b
msga config set model.coder qcoder
msga config set model.reviewer q14b

# 修改已有配置文件的字段
msga config set profile.qcoder.model qwen3-coder-14b
msga config set profile.qcoder.baseUrl http://192.168.1.100:8000/v1

# 删除配置文件
msga config remove-model q4b

# 查看配置
msga config get              # 查看所有
msga config get model.coder  # 查看 coder 角色分配
```

#### 命令行参数（临时覆盖）

```bash
# 指定模型（所有角色使用同一模型，覆盖配置文件）
msga -m qwen3-14b "实现用户登录"

# 指定 API 地址
msga --base-url http://localhost:11434/v1 "写个排序函数"

# 指定 API Key
msga --api-key sk-xxx --base-url https://api.example.com/v1 "任务"
```

#### 多模型编排模式

加 `-p` 启用多模型协作，不同任务自动分配给对应角色模型：

```bash
msga -p "设计并实现用户认证系统"
```

#### 旧版配置自动迁移

如果你之前使用的是旧版 flat 配置（`baseUrl`/`apiKey`/`model`/`model.router` 等直接写在 config.json 的键），MSGA 会自动迁移为新格式，无需手动操作。

### 使用

```bash
# 单次任务
cd your-project
msga "设计用户认证系统并实现"

# 多模型编排模式
msga -p "重构整个模块"

# 交互模式
msga

# 指定工作目录
msga -d /path/to/project "修复 bug"
```

## 📁 项目结构

```
MSGA/
├── README.md
├── docs/
│   ├── DESIGN.md          # 详细设计文档
│   ├── ARCHITECTURE.md    # 架构决策记录
│   └── research/          # 研究论文笔记
├── src/
│   ├── core/
│   │   ├── planner.ts     # 任务规划与原子化
│   │   ├── router.ts      # 模型路由
│   │   ├── validator.ts   # 输出校验层
│   │   └── orchestrator.ts # 多模型编排
│   ├── tools/
│   │   ├── schema-first/  # Schema-First 工具定义
│   │   ├── bash.ts        # Shell 执行
│   │   ├── file-read.ts   # 文件读取
│   │   ├── file-edit.ts   # 文件编辑
│   │   ├── file-write.ts  # 文件写入
│   │   ├── grep.ts        # 搜索
│   │   ├── glob.ts        # 文件查找
│   │   └── test-runner.ts # 测试执行
│   ├── models/
│   │   ├── provider.ts    # 模型 Provider 抽象
│   │   ├── openai.ts      # OpenAI 兼容 API
│   │   └── registry.ts    # 模型注册表
│   ├── context/
│   │   ├── manager.ts     # 上下文管理
│   │   ├── compressor.ts  # 上下文压缩
│   │   └── progressive.ts # 渐进式注入
│   ├── ui/
│   │   ├── app.tsx        # CLI 主界面
│   │   └── components/    # UI 组件
│   └── cli.ts             # CLI 入口
├── tests/
├── package.json
├── tsconfig.json
└── vitest.config.ts
```

## 📜 License

MIT

## 🙏 致谢

- 灵感来源于 [Claude Code](https://docs.anthropic.com/en/docs/claude-code) 和 [OpenCode](https://github.com/opencode-ai/opencode)
- 架构设计基于 ToolACE、SMART、When2Call 等学术研究
- 模型支持依赖 [oMLX](https://github.com/openai/omlx) 和 [Ollama](https://ollama.ai)
