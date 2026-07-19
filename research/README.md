# Research Database: Model Scaling & Capability Degradation

本数据库持续追踪学术论文对以下核心问题的研究：

> **当模型参数量减少时，究竟丢失/退化了哪些能力？**

## 目录结构

```
research/
├── README.md              # 本文件
├── papers/                # 论文 PDF 及元数据
├── summaries/             # 文字总结与分析
├── visualizations/        # 思维导图与可视化
├── paper_index.json       # 论文索引数据库
└── scaling_knowledge_map.md  # 研究全景知识图谱
```

## 研究主题

### 核心问题
- 模型参数量与各项能力的量化关系
- 不同能力的"涌现阈值"（emergence threshold）
- 小模型（13B-70B）的能力边界与补偿策略
- 知识蒸馏与模型压缩对能力的差异化影响

### 关键维度
- **推理能力**: 逻辑推理、数学推理、多步推理
- **代码生成**: 代码理解、代码生成、调试能力
- **语言理解**: 上下文理解、指令遵循、多语言
- **知识检索**: 事实性、世界知识、专业领域知识
- **创造力**: 创意写作、类比推理、跨领域联想

## 使用方式

使用 `/ars-lit-review` 或 `/deep-research` 进行文献检索和分析，结果将保存到本目录。

## 更新日志

- 2026-07-12: 新增 2025–2026 年面向小语言模型编码代理、工具调用、自我修正与长上下文外部化的研究盘点，见 `summaries/literature_review_agentic_slm_update_2026-07-12.md`。
- 2026-06-19: 扩展 `paper_index.json` 至 P13，并完善模型缩放能力退化综述。
- 2026-06-12: 初始化研究数据库结构
