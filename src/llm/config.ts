import * as vscode from 'vscode';
import { LLMConfig, resolveLLMConfig, ConfigReader, OpenCodeMode } from './configResolver';

export { LLMConfig, resolveLLMConfig, ConfigReader, OpenCodeMode };

export function getLLMConfig(): LLMConfig {
    const cfg = vscode.workspace.getConfiguration('msagent');
    return resolveLLMConfig(cfg);
}
