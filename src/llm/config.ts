import * as vscode from 'vscode';
import { LLMConfig, resolveLLMConfig, ConfigReader, AgentMode, Provider } from './configResolver';

export { LLMConfig, resolveLLMConfig, ConfigReader, AgentMode, Provider };

export function getLLMConfig(): LLMConfig {
    const cfg = vscode.workspace.getConfiguration('msagent');
    return resolveLLMConfig(cfg);
}

export async function updateLLMConfig(updates: Partial<LLMConfig>): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('msagent');
    const promises: Thenable<void>[] = [];

    if (updates.provider !== undefined) {
        promises.push(cfg.update('provider', updates.provider, true));
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
    if (updates.opencodeMode !== undefined) {
        promises.push(cfg.update('opencodeMode', updates.opencodeMode, true));
    }
    if (updates.opencodeServePort !== undefined) {
        promises.push(cfg.update('opencodeServePort', updates.opencodeServePort, true));
    }
    if (updates.opencodeCliPath !== undefined) {
        promises.push(cfg.update('opencodeCliPath', updates.opencodeCliPath, true));
    }
    if (updates.opencodeApiEndpoint !== undefined) {
        promises.push(cfg.update('opencodeApiEndpoint', updates.opencodeApiEndpoint, true));
    }
    if (updates.opencodeApiKey !== undefined) {
        promises.push(cfg.update('opencodeApiKey', updates.opencodeApiKey, true));
    }

    await Promise.all(promises);
}
