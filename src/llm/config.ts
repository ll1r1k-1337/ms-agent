import * as vscode from 'vscode';
import { LLMConfig, resolveLLMConfig, ConfigReader } from './configResolver';

export { LLMConfig, resolveLLMConfig, ConfigReader };

export function getLLMConfig(): LLMConfig {
    const cfg = vscode.workspace.getConfiguration('msagent');
    return resolveLLMConfig(cfg);
}
