import * as vscode from 'vscode';

export type AgentMode = 'builtin' | 'opencode';

export interface LLMConfig {
    agentMode: AgentMode;
    endpoint: string;
    modelName: string;
    apiKey: string;
    temperature: number;
    maxTokens: number;
    timeoutMs: number;
    opencodeCliPath: string;
}

export function getLLMConfig(): LLMConfig {
    const cfg = vscode.workspace.getConfiguration('msagent');
    return {
        agentMode: cfg.get<'builtin' | 'opencode'>('agentMode') || 'builtin',
        endpoint: cfg.get<string>('modelEndpoint') || 'http://localhost:11434',
        modelName: cfg.get<string>('modelName') || 'qwen3:8b',
        apiKey: cfg.get<string>('apiKey') || '',
        temperature: cfg.get<number>('temperature') ?? 0.1,
        maxTokens: cfg.get<number>('maxTokens') ?? 4096,
        timeoutMs: cfg.get<number>('timeoutMs') ?? 300000,
        opencodeCliPath: cfg.get<string>('opencodeCliPath') || 'opencode',
    };
}

export async function updateLLMConfig(updates: Partial<LLMConfig>): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('msagent');
    const promises: Thenable<void>[] = [];

    if (updates.agentMode !== undefined) {
        promises.push(cfg.update('agentMode', updates.agentMode, true));
    }
    if (updates.endpoint !== undefined) {
        promises.push(cfg.update('modelEndpoint', updates.endpoint, true));
    }
    if (updates.modelName !== undefined) {
        promises.push(cfg.update('modelName', updates.modelName, true));
    }
    if (updates.apiKey !== undefined) {
        promises.push(cfg.update('apiKey', updates.apiKey, true));
    }
    if (updates.temperature !== undefined) {
        promises.push(cfg.update('temperature', updates.temperature, true));
    }
    if (updates.maxTokens !== undefined) {
        promises.push(cfg.update('maxTokens', updates.maxTokens, true));
    }
    if (updates.timeoutMs !== undefined) {
        promises.push(cfg.update('timeoutMs', updates.timeoutMs, true));
    }
    if (updates.opencodeCliPath !== undefined) {
        promises.push(cfg.update('opencodeCliPath', updates.opencodeCliPath, true));
    }

    await Promise.all(promises);
}
