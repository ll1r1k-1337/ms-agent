import { FixBackend } from './fixBackend';
import { BuiltInFixBackend } from './builtInFixBackend';
import { OpenCodeFixBackend } from './openCodeFixBackend';
import { getLLMConfig, AgentMode } from '../llm/config';

export { FixBackend, FixCallbacks, FixContext, FixResult } from './fixBackend';
export { BuiltInFixBackend } from './builtInFixBackend';
export { OpenCodeFixBackend } from './openCodeFixBackend';

export function createFixBackend(): FixBackend {
    const config = getLLMConfig();
    const mode = config.agentMode;

    if (mode === 'opencode') {
        return new OpenCodeFixBackend();
    }

    return new BuiltInFixBackend();
}

export function getCurrentAgentMode(): AgentMode {
    return getLLMConfig().agentMode;
}
