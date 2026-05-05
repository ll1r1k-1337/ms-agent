import { expect } from 'chai';
import { createFixBackend } from './backendFactory';
import { OpenCodeFixBackend } from './openCodeFixBackend';
import { LLMConfig } from '../llm/configResolver';

describe('createFixBackend', () => {
    it('always returns OpenCodeFixBackend', () => {
        const config: LLMConfig = {
            modelName: 'opencode/big-pickle',
            providerID: 'opencode',
            modelID: 'big-pickle',
            modelFullName: 'opencode/big-pickle',
            timeoutMs: 300000,
            opencodeServePort: 7325,
            opencodeCliPath: 'opencode',
            opencodeApiKey: '',
        };

        const backend = createFixBackend(config);

        expect(backend).to.be.instanceOf(OpenCodeFixBackend);
        expect(backend.name).to.equal('opencode');
    });
});
