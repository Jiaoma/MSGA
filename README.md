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

```bash
# 指向本地 oMLX / Ollama
msga config set router.model "http://localhost:8000/v1"
msga config set coder.model "http://localhost:11434/v1"
```

### 使用

```bash
# 在项目中使用
cd your-project
msga "设计用户认证系统并实现"

# 或者交互模式
msga
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
