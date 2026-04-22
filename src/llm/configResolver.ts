export type AgentMode = 'builtin' | 'opencode';

export type Provider = 'openai-compatible' | 'opencode';

export interface LLMConfig {
    provider: Provider;
    endpoint: string;
    modelName: string;
    apiKey: string;
    temperature: number;
    maxTokens: number;
    timeoutMs: number;
    opencodeMode: string;
    opencodeServePort: number;
    opencodeCliPath: string;
    opencodeApiEndpoint: string;
    opencodeApiKey: string;
}

export interface ConfigReader {
    get<T>(key: string): T | undefined;
}

export function resolveLLMConfig(cfg: ConfigReader): LLMConfig {
    let provider = cfg.get<Provider>('provider');

    if (!provider) {
        const agentMode = cfg.get<'builtin' | 'opencode'>('agentMode');
        if (agentMode === 'opencode') {
            provider = 'opencode';
        } else {
            provider = 'openai-compatible';
        }
    }

    return {
        provider: provider || 'openai-compatible',
        endpoint: cfg.get<string>('modelEndpoint') || 'http://localhost:11434',
        modelName: cfg.get<string>('modelName') || 'qwen3:8b',
        apiKey: cfg.get<string>('apiKey') || '',
        temperature: cfg.get<number>('temperature') ?? 0.1,
        maxTokens: cfg.get<number>('maxTokens') ?? 4096,
        timeoutMs: cfg.get<number>('timeoutMs') ?? 300000,
        opencodeMode: cfg.get<string>('opencodeMode') || 'cli',
        opencodeServePort: cfg.get<number>('opencodeServePort') ?? 7325,
        opencodeCliPath: cfg.get<string>('opencodeCliPath') || 'opencode',
        opencodeApiEndpoint: cfg.get<string>('opencodeApiEndpoint') || 'http://localhost:7325',
        opencodeApiKey: cfg.get<string>('opencodeApiKey') || '',
    };
}
