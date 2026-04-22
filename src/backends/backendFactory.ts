import { FixBackend } from './fixBackend';
import { BuiltInFixBackend } from './builtInFixBackend';
import { OpenCodeFixBackend } from './openCodeFixBackend';
import { LLMConfig } from '../llm/configResolver';

export { FixBackend, FixCallbacks, FixContext, FixResult } from './fixBackend';
export { BuiltInFixBackend } from './builtInFixBackend';
export { OpenCodeFixBackend } from './openCodeFixBackend';

export function createFixBackend(config: LLMConfig): FixBackend {
    if (config.provider === 'opencode') {
        return new OpenCodeFixBackend();
    }

    return new BuiltInFixBackend();
}
