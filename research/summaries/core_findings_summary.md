# 模型缩放能力退化：核心论文摘要

## P02 [CRITICAL] The Cost of Down-Scaling Language Models (ICLR 2024)

**关键阈值发现**:
- 参数削减 >30%: 事实回忆能力显著下降
- 参数削减 60-70%: 上下文学习仍大部分保留
- 知识回忆和上下文学习具有根本不同的缩放特性

**MSGA启示**: 小模型的核心限制在于"记住了什么"而非"能做什么"。RAG和外部知识库是关键补偿手段。

---

## P05 [CRITICAL] Compression Effects on Reasoning Models (2025)

**能力退化优先级** (从最脆弱到最韧性):
1. 数学推理 (AIME) - 最先崩溃
2. 知识密集型任务 (MuSiQue)
3. 一般推理能力
4. 时序推理 - 最后退化
5. 不确定性估计 - 最后退化

**关键架构发现**:
- 最后几层的 up-projection 极度重要
- 仅0.7%权重(该矩阵)可导致16.3%精度下降
- 保护2%关键权重可挽回6.57%性能

**MSGA启示**: 使用量化模型时，数学和代码相关任务应路由到更大或未压缩的模型。

---

## P06 [CRITICAL] The 4th Dimension for Scaling (2025)

**突破性发现**: 参数数量 ∝ 知识容量, 但 ≠ 推理能力

- VLD(虚拟逻辑深度)通过层复用增强推理
- 50M VLD模型 > 150M传统模型 (62.05% vs 61.15%)
- 知识容量保持恒定，推理能力显著提升

**MSGA启示**: 小模型不必"什么都知道"。通过架构创新（如层复用）可以在不增加参数的情况下提升推理深度。MSGA的多模型协作本质上是外部化了"知识"（由大模型或知识库提供），让小模型专注于"推理"。

---

## P01 Capability Ceilings (2025)

- MMLU数学: 70M→30B，精度停在19-20%（低于25%随机基线）
- Loss下降31%但精度无变化 → 标准缩放指标会误导
- 过程性任务（算术）正常缩放

---

## P04 U-shaped Scaling (2024)

- 中等规模模型的"停滞"是统计假象
- 困难题U形 + 简单题倒U形 = 总分停滞
- 13B-70B可能处于这个"合成停滞区"

---

## P03 Emergent Abilities in Small Models (2024)

- 关键条件: 语言复杂度必须匹配模型容量
- 165M模型在简化域匹配1B模型
- MSGA的Schema-First和任务原子化 = 自然的"域简化"

---

## P07 Focus on Downscaling (2025)

有效策略排序:
1. 数据质量 > 数据数量
2. 领域特化训练
3. 战略性剪枝（选择性保留关键权重）
4. 多小模型集成 > 等算力单大模型

---

## P08 CoT Distillation Capacity Gap (2026)

- CoT蒸馏在大多数情况下实际上降低了性能
- 形式逻辑、逻辑推演等任务完全抗拒蒸馏
- 实践建议: 用强教师模型，但需验证是否真的比基线好

---

## 2026-07-12 新增主题：面向小语言模型的编码代理与工具调用

### P14 [CRITICAL] EffGen: Enabling Small Language Models as Capable Autonomous Agents (2026)

- 面向 SLM 的代理框架，整合提示压缩、任务拆解、复杂度路由、统一记忆与 MCP/A2A/ACP 协议兼容
- 提示优化对小模型收益更大，复杂度路由对大模型收益更大
- MSGA启示: 任务原子化、渐进式上下文注入、模型路由和统一记忆是 SLM 代理的核心补偿机制

### P15 [CRITICAL] Small Language Models for Efficient Agentic Tool Calling (2025/2026)

- OPT-350M 经定向 SFT 后在 ToolBench 达到 77.55% pass rate
- 稳定工具集合和任务分布下，工具调用可由专门化小模型承担
- MSGA启示: router/tool-caller 可训练为轻量角色模型，不必总由 coder/planner 级模型执行

### P18 [CRITICAL] Self-Correcting Code Generation Using Small Language Models (2025)

- 大模型自我修正提示迁移到小代码模型时可能失灵，甚至破坏原本正确的代码
- CoCoS 用在线强化学习和单测通过率奖励提升选择性修正
- MSGA启示: 修复循环应测试驱动、最小补丁化，并由 validator/tester/reviewer 分离职责

### P21 Coding Agents are Effective Long-Context Processors (2026)

- 编码代理通过文件系统和工具外部化长上下文处理，在长上下文推理、RAG、开放域问答上优于既有 SOTA 17.3%
- MSGA启示: 与其追求 SLM 超长上下文，不如构建文件系统化上下文、符号索引和按需注入机制
