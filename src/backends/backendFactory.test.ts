import { expect } from 'chai';
import { createFixBackend } from './backendFactory';
import { OpenCodeFixBackend } from './openCodeFixBackend';
import { LLMConfig } from '../llm/configResolver';

describe('createFixBackend', () => {
    it('always returns OpenCodeFixBackend', () => {
        const config: LLMConfig = {
            modelName: 'opencode/minimax-m2.5-free',
            providerID: 'opencode',
            modelID: 'minimax-m2.5-free',
            modelFullName: 'opencode/minimax-m2.5-free',
            timeoutMs: 300000,
            opencodeServePort: 7325,
            opencodeCliPath: 'opencode',
        };

        const backend = createFixBackend(config);

        expect(backend).to.be.instanceOf(OpenCodeFixBackend);
        expect(backend.name).to.equal('opencode');
    });
});
