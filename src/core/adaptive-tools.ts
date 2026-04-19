/**
 * MSGA Adaptive Tool Calling - decides when to call tools vs answer directly
 * Research: tool calling decision quality follows inverted-U curve by model size
 */

export interface ToolCallDecision {
  shouldCallTool: boolean;
  confidence: number;    // 0-1
  reason: string;
  suggestedTools?: string[];
}

export interface TaskAnalysis {
  complexity: 'simple' | 'moderate' | 'complex';
  requiresCodeReading: boolean;
  requiresCodeWriting: boolean;
  requiresTesting: boolean;
  requiresExecution: boolean;
  requiresExternalData: boolean;
  estimatedSteps: number;
}

/**
 * Analyze a task to determine if tool calls are needed
 */
export function analyzeTask(task: string): TaskAnalysis {
  const lower = task.toLowerCase();

  const analysis: TaskAnalysis = {
    complexity: 'simple',
    requiresCodeReading: false,
    requiresCodeWriting: false,
    requiresTesting: false,
    requiresExecution: false,
    requiresExternalData: false,
    estimatedSteps: 1,
  };

  // Code reading signals
  if (/\b(read|show|display|what does|explain|review|check|find|list|where)\b/.test(lower)) {
    analysis.requiresCodeReading = true;
  }

  // Code writing signals
  if (/\b(implement|create|add|write|fix|refactor|modify|update|rename|change)\b/.test(lower)) {
    analysis.requiresCodeWriting = true;
  }

  // Testing signals
  if (/\b(test|spec|assert|verify|run tests)\b/.test(lower)) {
    analysis.requiresTesting = true;
  }

  // Execution signals
  if (/\b(run|execute|build|install|start|deploy|npm|pip|git)\b/.test(lower)) {
    analysis.requiresExecution = true;
  }

  // External data signals
  if (/\b(search|fetch|api|web|http|url|download)\b/.test(lower)) {
    analysis.requiresExternalData = true;
  }

  // Estimate complexity
  const signals = [
    analysis.requiresCodeReading,
    analysis.requiresCodeWriting,
    analysis.requiresTesting,
    analysis.requiresExecution,
    analysis.requiresExternalData,
  ];
  const signalCount = signals.filter(Boolean).length;

  if (signalCount >= 4 || /\b(architecture|system|module|feature|project)\b/.test(lower)) {
    analysis.complexity = 'complex';
    analysis.estimatedSteps = 5 + signalCount;
  } else if (signalCount >= 2 || task.length > 100) {
    analysis.complexity = 'moderate';
    analysis.estimatedSteps = 2 + signalCount;
  } else {
    analysis.complexity = 'simple';
    analysis.estimatedSteps = 1;
  }

  return analysis;
}

/**
 * Decide whether to call tools based on task analysis and model confidence
 */
export function decideToolCall(analysis: TaskAnalysis, modelConfidence: number): ToolCallDecision {
  // High confidence + simple question = answer directly
  if (modelConfidence > 0.9 && analysis.complexity === 'simple' && !analysis.requiresCodeReading) {
    return {
      shouldCallTool: false,
      confidence: modelConfidence,
      reason: 'High confidence answer to simple question',
    };
  }

  // Any code writing/testing/execution = must use tools
  if (analysis.requiresCodeWriting || analysis.requiresTesting || analysis.requiresExecution) {
    const tools: string[] = [];
    if (analysis.requiresCodeReading) tools.push('read_function', 'list_symbols');
    if (analysis.requiresCodeWriting) tools.push('add_function', 'edit_function', 'add_import');
    if (analysis.requiresTesting) tools.push('run_test_file', 'run_test_case');
    if (analysis.requiresExecution) tools.push('bash');

    return {
      shouldCallTool: true,
      confidence: modelConfidence,
      reason: `Task requires ${tools.length} tool operations`,
      suggestedTools: tools,
    };
  }

  // Code reading = use tools for precision
  if (analysis.requiresCodeReading) {
    return {
      shouldCallTool: true,
      confidence: modelConfidence,
      reason: 'Code reading requires file access',
      suggestedTools: ['read_function', 'list_symbols', 'search_code'],
    };
  }

  // External data = must use tools
  if (analysis.requiresExternalData) {
    return {
      shouldCallTool: true,
      confidence: modelConfidence,
      reason: 'External data requires tool access',
      suggestedTools: ['bash', 'search_code'],
    };
  }

  // Default: let model decide based on confidence
  return {
    shouldCallTool: modelConfidence < 0.7,
    confidence: modelConfidence,
    reason: modelConfidence < 0.7
      ? 'Low confidence, tools may help'
      : 'Moderate confidence, attempting direct answer',
  };
}
