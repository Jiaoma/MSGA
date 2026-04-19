/**
 * MSGA Context Manager
 * Controls context size per atomic task.
 * Research finding: SLM performs best with 2-4K tokens context.
 */

export interface ContextBudget {
  systemPrompt: number;
  taskDescription: number;
  fileContext: number;
  toolResults: number;
  total: number;
}

export const DEFAULT_BUDGET: ContextBudget = {
  systemPrompt: 300,
  taskDescription: 300,
  fileContext: 1000,
  toolResults: 500,
  total: 2400,
};

export interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
}

/**
 * Estimate token count (rough: 1 token ≈ 4 chars for English, ≈ 2 chars for CJK)
 */
function estimateTokens(text: string): number {
  const cjkCount = (text.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) || []).length;
  const otherChars = text.length - cjkCount;
  return Math.ceil(cjkCount / 2 + otherChars / 4);
}

export class ContextManager {
  private budget: ContextBudget;
  private history: Message[] = [];
  private maxHistoryTurns: number;

  constructor(budget: ContextBudget = DEFAULT_BUDGET, maxHistoryTurns = 5) {
    this.budget = budget;
    this.maxHistoryTurns = maxHistoryTurns;
  }

  /**
   * Build the message array for a model call, respecting token budget.
   */
  buildMessages(
    systemPrompt: string,
    taskDescription: string,
    fileContext: string,
    history?: Message[]
  ): Message[] {
    const messages: Message[] = [];

    // System prompt (compressed if needed)
    messages.push({
      role: 'system',
      content: this.truncate(systemPrompt, this.budget.systemPrompt),
    });

    // Add relevant history (most recent, compressed)
    if (history && history.length > 0) {
      const recentHistory = history.slice(-(this.maxHistoryTurns * 2));
      let historyTokens = 0;
      const budgetForHistory = this.budget.total - this.budget.systemPrompt - this.budget.taskDescription;

      for (const msg of recentHistory) {
        const tokens = estimateTokens(msg.content);
        if (historyTokens + tokens > budgetForHistory * 0.3) break;
        messages.push(msg);
        historyTokens += tokens;
      }
    }

    // Task + file context as user message
    let userContent = taskDescription;
    if (fileContext) {
      const remainingTokens = this.budget.total - estimateTokens(userContent) - this.budget.systemPrompt;
      userContent += '\n\n--- Relevant Code ---\n' + this.truncate(fileContext, Math.min(remainingTokens, this.budget.fileContext));
    }

    messages.push({ role: 'user', content: userContent });

    return messages;
  }

  /**
   * Compress tool output to fit budget.
   */
  compressToolOutput(output: string): string {
    return this.truncate(output, this.budget.toolResults);
  }

  /**
   * Add a message to history and evict old ones if needed.
   */
  addHistory(msg: Message): void {
    this.history.push(msg);
    // Keep only last N turns
    if (this.history.length > this.maxHistoryTurns * 3) {
      // Keep system message if first, then last N messages
      this.history = this.history.slice(-this.maxHistoryTurns * 2);
    }
  }

  getHistory(): Message[] {
    return [...this.history];
  }

  private truncate(text: string, maxTokens: number): string {
    const tokens = estimateTokens(text);
    if (tokens <= maxTokens) return text;

    // Rough truncation
    const maxChars = maxTokens * 3; // conservative
    return text.slice(0, maxChars) + '\n... [truncated]';
  }
}
