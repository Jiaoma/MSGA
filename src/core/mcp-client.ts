/**
 * MSGA MCP (Model Context Protocol) Client
 * Connect to external MCP tool servers for extended capabilities
 */

import { execSync, spawn, type ChildProcess } from 'child_process';
import { readFileSync } from 'fs';
import { join } from 'path';

export interface MCPServerConfig {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface MCPTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface MCPToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

/**
 * MCP Client - communicates with MCP tool servers via stdio
 */
export class MCPClient {
  private server: ChildProcess | null = null;
  private config: MCPServerConfig;
  private tools: MCPTool[] = [];
  private requestId = 0;

  constructor(config: MCPServerConfig) {
    this.config = config;
  }

  /**
   * Start the MCP server and initialize connection
   */
  async connect(): Promise<void> {
    this.server = spawn(this.config.command, this.config.args || [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...this.config.env },
    });

    // Initialize
    await this.sendRequest('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'msga', version: '0.1.0' },
    });

    // List available tools
    const result = await this.sendRequest('tools/list', {});
    this.tools = (result?.tools || []).map((t: any) => ({
      name: t.name,
      description: t.description || '',
      inputSchema: t.inputSchema || {},
    }));
  }

  /**
   * Call a tool on the MCP server
   */
  async callTool(name: string, args: Record<string, unknown>): Promise<MCPToolResult> {
    const result = await this.sendRequest('tools/call', {
      name,
      arguments: args,
    });
    return {
      content: result?.content || [{ type: 'text', text: 'No result' }],
      isError: result?.isError,
    };
  }

  /**
   * Get available tools from this MCP server
   */
  getTools(): MCPTool[] {
    return this.tools;
  }

  /**
   * Disconnect from MCP server
   */
  disconnect(): void {
    if (this.server) {
      this.server.kill();
      this.server = null;
    }
  }

  private async sendRequest(method: string, params: unknown): Promise<any> {
    if (!this.server?.stdin || !this.server?.stdout) {
      throw new Error('MCP server not connected');
    }

    const id = ++this.requestId;
    const message = JSON.stringify({
      jsonrpc: '2.0',
      id,
      method,
      params,
    });

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`MCP request timeout: ${method}`)), 15000);

      const onData = (chunk: Buffer) => {
        const text = chunk.toString();
        // Parse JSON-RPC response from stdout
        for (const line of text.split('\n')) {
          if (!line.trim()) continue;
          try {
            const parsed = JSON.parse(line);
            if (parsed.id === id) {
              clearTimeout(timeout);
              this.server!.stdout!.off('data', onData);
              if (parsed.error) {
                reject(new Error(`MCP error: ${parsed.error.message}`));
              } else {
                resolve(parsed.result);
              }
            }
          } catch { /* not JSON, skip */ }
        }
      };

      this.server!.stdout!.on('data', onData);
      this.server!.stdin!.write(message + '\n');
    });
  }
}

/**
 * Load MCP server configs from a config file
 */
export function loadMCPConfigs(configPath?: string): MCPServerConfig[] {
  const paths = [
    configPath,
    join(process.env.HOME || '~', '.msga', 'mcp.json'),
    join(process.cwd(), '.msga', 'mcp.json'),
  ].filter(Boolean) as string[];

  for (const p of paths) {
    try {
      const raw = readFileSync(p!, 'utf-8');
      const config = JSON.parse(raw);
      const servers: MCPServerConfig[] = [];

      if (config.mcpServers) {
        for (const [name, server] of Object.entries(config.mcpServers) as any) {
          servers.push({
            name,
            command: server.command,
            args: server.args,
            env: server.env,
          });
        }
      }

      return servers;
    } catch { /* try next path */ }
  }

  return [];
}
