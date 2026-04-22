import { expect } from 'chai';
import { createFixBackend } from './backendFactory';
import { BuiltInFixBackend } from './builtInFixBackend';
import { OpenCodeFixBackend } from './openCodeFixBackend';
import { LLMConfig } from '../llm/configResolver';

describe('createFixBackend', () => {
    const baseConfig: LLMConfig = {
        provider: 'openai-compatible',
        endpoint: 'http://localhost:11434',
        modelName: 'qwen3:8b',
        apiKey: '',
        temperature: 0.1,
        maxTokens: 4096,
        timeoutMs: 300000,
        opencodeMode: 'cli',
        opencodeServePort: 7325,
        opencodeCliPath: 'opencode',
        opencodeApiEndpoint: 'http://localhost:7325',
        opencodeApiKey: '',
    };

    it('should return BuiltInFixBackend when provider is openai-compatible', () => {
        const backend = createFixBackend(baseConfig);
        expect(backend).to.be.instanceOf(BuiltInFixBackend);
        expect(backend.name).to.equal('builtin');
    });

    it('should return OpenCodeFixBackend when provider is opencode', () => {
        const config: LLMConfig = { ...baseConfig, provider: 'opencode' };
        const backend = createFixBackend(config);
        expect(backend).to.be.instanceOf(OpenCodeFixBackend);
        expect(backend.name).to.equal('opencode');
    });
});
