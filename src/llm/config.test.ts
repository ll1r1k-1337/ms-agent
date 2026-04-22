import { expect } from 'chai';
import { resolveLLMConfig, ConfigReader, LLMConfig } from './configResolver';

function makeReader(partial: Record<string, unknown>): ConfigReader {
    return {
        get<T>(key: string): T | undefined {
            return partial[key] as T | undefined;
        },
    };
}

describe('resolveLLMConfig', () => {
    it('should read provider directly when set to openai-compatible', () => {
        const cfg = makeReader({ provider: 'openai-compatible' });
        const result = resolveLLMConfig(cfg);
        expect(result.provider).to.equal('openai-compatible');
    });

    it('should read provider directly when set to opencode', () => {
        const cfg = makeReader({ provider: 'opencode' });
        const result = resolveLLMConfig(cfg);
        expect(result.provider).to.equal('opencode');
    });

    it('should map old agentMode=builtin to provider=openai-compatible', () => {
        const cfg = makeReader({ agentMode: 'builtin' });
        const result = resolveLLMConfig(cfg);
        expect(result.provider).to.equal('openai-compatible');
    });

    it('should map old agentMode=opencode to provider=opencode', () => {
        const cfg = makeReader({ agentMode: 'opencode' });
        const result = resolveLLMConfig(cfg);
        expect(result.provider).to.equal('opencode');
    });

    it('should prefer provider over agentMode when both are set', () => {
        const cfg = makeReader({ provider: 'opencode', agentMode: 'builtin' });
        const result = resolveLLMConfig(cfg);
        expect(result.provider).to.equal('opencode');
    });

    it('should default to openai-compatible when neither provider nor agentMode is set', () => {
        const cfg = makeReader({});
        const result = resolveLLMConfig(cfg);
        expect(result.provider).to.equal('openai-compatible');
    });

    it('should read apiKey correctly', () => {
        const cfg = makeReader({ apiKey: 'sk-test123' });
        const result = resolveLLMConfig(cfg);
        expect(result.apiKey).to.equal('sk-test123');
    });

    it('should read all opencode fields with custom values', () => {
        const cfg = makeReader({
            opencodeMode: 'server',
            opencodeServePort: 8080,
            opencodeCliPath: '/usr/local/bin/opencode',
            opencodeApiEndpoint: 'http://localhost:8080',
            opencodeApiKey: 'oc-key',
        });
        const result = resolveLLMConfig(cfg);
        expect(result.opencodeMode).to.equal('server');
        expect(result.opencodeServePort).to.equal(8080);
        expect(result.opencodeCliPath).to.equal('/usr/local/bin/opencode');
        expect(result.opencodeApiEndpoint).to.equal('http://localhost:8080');
        expect(result.opencodeApiKey).to.equal('oc-key');
    });

    it('should use default values for opencode fields when not set', () => {
        const cfg = makeReader({});
        const result = resolveLLMConfig(cfg);
        expect(result.opencodeMode).to.equal('cli');
        expect(result.opencodeServePort).to.equal(7325);
        expect(result.opencodeCliPath).to.equal('opencode');
        expect(result.opencodeApiEndpoint).to.equal('http://localhost:7325');
        expect(result.opencodeApiKey).to.equal('');
    });

    it('should use default values for core fields when not set', () => {
        const cfg = makeReader({});
        const result = resolveLLMConfig(cfg);
        expect(result.endpoint).to.equal('http://localhost:11434');
        expect(result.modelName).to.equal('qwen3:8b');
        expect(result.temperature).to.equal(0.1);
        expect(result.maxTokens).to.equal(4096);
        expect(result.timeoutMs).to.equal(300000);
    });

    it('should return a complete LLMConfig object with all required fields', () => {
        const cfg = makeReader({ provider: 'opencode' });
        const result = resolveLLMConfig(cfg);
        const expectedKeys: (keyof LLMConfig)[] = [
            'provider',
            'endpoint',
            'modelName',
            'apiKey',
            'temperature',
            'maxTokens',
            'timeoutMs',
            'opencodeMode',
            'opencodeServePort',
            'opencodeCliPath',
            'opencodeApiEndpoint',
            'opencodeApiKey',
        ];
        for (const key of expectedKeys) {
            expect(result).to.have.property(key);
        }
    });
});
