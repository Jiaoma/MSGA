/**
 * OpenAI-compatible API provider for MSGA
 * Works with oMLX, Ollama, LM Studio, any OpenAI-compatible endpoint
 */

import type {
  Message,
  ToolCall,
  ChatResponse,
  ChatStreamChunk,
  ModelProvider,
  ProviderConfig,
  ToolDefinition,
} from './provider.js';

export class OpenAIProvider implements ModelProvider {
  public readonly config: ProviderConfig;

  constructor(config: ProviderConfig) {
    this.config = config;
  }

  async chat(messages: Message[], tools?: ToolDefinition[]): Promise<ChatResponse> {
    const url = `${this.config.baseUrl}/chat/completions`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.config.apiKey) {
      headers['Authorization'] = `Bearer ${this.config.apiKey}`;
    }

    const body: Record<string, unknown> = {
      model: this.config.model,
      messages: messages.map(m => {
        const msg: Record<string, unknown> = { role: m.role, content: m.content };
        if (m.tool_call_id) msg.tool_call_id = m.tool_call_id;
        if ('tool_calls' in m && m.tool_calls) msg.tool_calls = m.tool_calls;
        return msg;
      }),
      max_tokens: this.config.maxTokens,
      temperature: this.config.temperature,
    };

    if (tools && tools.length > 0) {
      body.tools = tools.map(t => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        },
      }));
      body.tool_choice = 'auto';
    }

    const resp = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`API error ${resp.status}: ${text}`);
    }

    const data = await resp.json() as any;
    const choice = data.choices?.[0];

    const toolCalls: ToolCall[] = (choice?.message?.tool_calls || []).map(
      (tc: any) => ({
        id: tc.id,
        type: 'function' as const,
        function: {
          name: tc.function.name,
          arguments: tc.function.arguments,
        },
      })
    );

    return {
      content: choice?.message?.content || null,
      toolCalls,
      usage: {
        inputTokens: data.usage?.prompt_tokens || 0,
        outputTokens: data.usage?.completion_tokens || 0,
      },
      finishReason: choice?.finish_reason || 'stop',
    };
  }

  async *chatStream(
    messages: Message[],
    tools?: ToolDefinition[]
  ): AsyncIterable<ChatStreamChunk> {
    const url = `${this.config.baseUrl}/chat/completions`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.config.apiKey) {
      headers['Authorization'] = `Bearer ${this.config.apiKey}`;
    }

    const body: Record<string, unknown> = {
      model: this.config.model,
      messages: messages.map(m => {
        const msg: Record<string, unknown> = { role: m.role, content: m.content };
        if (m.tool_call_id) msg.tool_call_id = m.tool_call_id;
        if ('tool_calls' in m && m.tool_calls) msg.tool_calls = m.tool_calls;
        return msg;
      }),
      max_tokens: this.config.maxTokens,
      temperature: this.config.temperature,
      stream: true,
    };

    if (tools && tools.length > 0) {
      body.tools = tools.map(t => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        },
      }));
      body.tool_choice = 'auto';
    }

    const resp = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`API error ${resp.status}: ${text}`);
    }

    const reader = resp.body?.getReader();
    if (!reader) throw new Error('No response body');

    const decoder = new TextDecoder();
    let buffer = '';
    let currentToolCall: Partial<ToolCall> | null = null;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data: ')) continue;
        const data = trimmed.slice(6);
        if (data === '[DONE]') {
          yield { type: 'done', finishReason: 'stop' };
          return;
        }

        try {
          const parsed = JSON.parse(data) as any;
          const delta = parsed.choices?.[0]?.delta;

          if (delta?.content) {
            yield { type: 'content', content: delta.content };
          }

          if (delta?.tool_calls) {
            for (const tc of delta.tool_calls) {
              if (tc.function?.name) {
                currentToolCall = {
                  id: tc.id,
                  type: 'function',
                  function: { name: tc.function.name, arguments: '' },
                };
              }
              if (tc.function?.arguments && currentToolCall) {
                currentToolCall.function!.arguments =
                  (currentToolCall.function!.arguments || '') +
                  tc.function.arguments;
              }
              if (currentToolCall) {
                yield {
                  type: 'tool_call',
                  toolCall: currentToolCall,
                };
              }
            }
          }
        } catch {
          // skip malformed chunks
        }
      }
    }
  }
}
