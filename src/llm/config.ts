import * as vscode from 'vscode';

export interface LLMConfig {
    endpoint: string;
    modelName: string;
    temperature: number;
    maxTokens: number;
    timeoutMs: number;
}

export function getLLMConfig(): LLMConfig {
    const cfg = vscode.workspace.getConfiguration('msagent');
    return {
        endpoint: cfg.get<string>('modelEndpoint') || 'http://localhost:11434',
        modelName: cfg.get<string>('modelName') || 'qwen3:8b',
        temperature: cfg.get<number>('temperature') ?? 0.1,
        maxTokens: cfg.get<number>('maxTokens') ?? 4096,
        timeoutMs: cfg.get<number>('timeoutMs') ?? 300000,
    };
}
