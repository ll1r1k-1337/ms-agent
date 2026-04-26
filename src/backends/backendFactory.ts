import { FixBackend } from './fixBackend';
import { OpenCodeFixBackend } from './openCodeFixBackend';
import { LLMConfig } from '../llm/configResolver';

export { FixBackend, FixCallbacks, FixContext, FixResult } from './fixBackend';
export { OpenCodeFixBackend } from './openCodeFixBackend';

export function createFixBackend(_config: LLMConfig): FixBackend {
    return new OpenCodeFixBackend();
}
