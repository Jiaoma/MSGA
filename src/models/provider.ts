/**
 * MSGA Model Provider Abstraction
 * Supports OpenAI-compatible APIs (oMLX, Ollama, LM Studio, etc.)
 */

export interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_call_id?: string;
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string; // JSON string
  };
}

export interface ChatResponse {
  content: string | null;
  toolCalls: ToolCall[];
  usage: { inputTokens: number; outputTokens: number };
  finishReason: 'stop' | 'tool_calls' | 'length';
}

export interface ProviderConfig {
  id: string;
  baseUrl: string;
  apiKey?: string;
  model: string;
  maxTokens: number;
  temperature: number;
  contextWindow: number;
}

export interface ModelProvider {
  chat(messages: Message[], tools?: ToolDefinition[]): Promise<ChatResponse>;
  chatStream(messages: Message[], tools?: ToolDefinition[]): AsyncIterable<ChatStreamChunk>;
  get config(): ProviderConfig;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema
}

export interface ChatStreamChunk {
  type: 'content' | 'tool_call' | 'done';
  content?: string;
  toolCall?: Partial<ToolCall>;
  usage?: { inputTokens: number; outputTokens: number };
  finishReason?: string;
}
