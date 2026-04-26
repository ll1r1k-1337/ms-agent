import { expect } from 'chai';
import * as fs from 'fs';
import * as path from 'path';
import {
    DEFAULT_OPENCODE_MODEL,
    parseModelName,
    resolveLLMConfig,
    ConfigReader,
    LLMConfig,
} from './configResolver';

function makeReader(partial: Record<string, unknown>): ConfigReader {
    return {
        get<T>(key: string): T | undefined {
            return partial[key] as T | undefined;
        },
    };
}

describe('resolveLLMConfig', () => {
    it('returns OpenCode-only defaults', () => {
        const result = resolveLLMConfig(makeReader({}));

        expect(result).to.deep.equal({
            modelName: DEFAULT_OPENCODE_MODEL,
            providerID: 'opencode',
            modelID: 'big-pickle',
            modelFullName: DEFAULT_OPENCODE_MODEL,
            modelWarning: undefined,
            timeoutMs: 300000,
            opencodeMode: 'server',
            opencodeServePort: 7325,
            opencodeCliPath: 'opencode',
            opencodeAcpArgs: ['acp'],
            opencodeApiKey: '',
        });
    });

    it('keeps the resolver default aligned with package.json', () => {
        const packageJson = JSON.parse(
            fs.readFileSync(path.resolve(__dirname, '../../package.json'), 'utf-8'),
        );
        expect(packageJson.contributes.configuration.properties['msagent.modelName'].default)
            .to.equal(DEFAULT_OPENCODE_MODEL);
    });

    it('keeps the VS Code settings manifest discoverable', () => {
        const packageJson = JSON.parse(
            fs.readFileSync(path.resolve(__dirname, '../../package.json'), 'utf-8'),
        );
        const config = packageJson.contributes.configuration;
        const modelSetting = config.properties['msagent.modelName'];
        const commands = packageJson.contributes.commands.map((entry: { command: string }) => entry.command);

        expect(config.title).to.equal('msAgent');
        expect(Object.keys(config.properties)).to.include('msagent.modelName');
        expect(commands).to.include('msagent.openSettings');
        expect(packageJson.activationEvents).to.include('onCommand:msagent.openSettings');
        expect(modelSetting).to.not.have.property('enumItemLabels');
        expect(modelSetting.markdownEnumDescriptions).to.have.length(modelSetting.enum.length);
    });

    it('reads custom OpenCode values', () => {
        const result = resolveLLMConfig(makeReader({
            modelName: 'volcengine-plan/doubao-seed-2.0-code',
            timeoutMs: 450000,
            opencodeMode: 'acp',
            opencodeServePort: 8123,
            opencodeCliPath: '/usr/local/bin/opencode',
            opencodeAcpArgs: ['acp', '--verbose'],
            opencodeApiKey: 'oc-test',
        }));

        expect(result).to.deep.equal({
            modelName: 'volcengine-plan/doubao-seed-2.0-code',
            providerID: 'volcengine-plan',
            modelID: 'doubao-seed-2.0-code',
            modelFullName: 'volcengine-plan/doubao-seed-2.0-code',
            modelWarning: undefined,
            timeoutMs: 450000,
            opencodeMode: 'acp',
            opencodeServePort: 8123,
            opencodeCliPath: '/usr/local/bin/opencode',
            opencodeAcpArgs: ['acp', '--verbose'],
            opencodeApiKey: 'oc-test',
        });
    });

    it('normalizes unknown mode back to server', () => {
        const result = resolveLLMConfig(makeReader({ opencodeMode: 'server-ish' }));
        expect(result.opencodeMode).to.equal('server');
    });

    it('falls back to default ACP args when the setting is empty', () => {
        const result = resolveLLMConfig(makeReader({ opencodeAcpArgs: [] }));
        expect(result.opencodeAcpArgs).to.deep.equal(['acp']);
    });

    it('parses full OpenCode model IDs into provider and model parts', () => {
        const parsed = parseModelName('volcengine-plan/doubao-seed-2.0-code');
        expect(parsed.providerID).to.equal('volcengine-plan');
        expect(parsed.modelID).to.equal('doubao-seed-2.0-code');
        expect(parsed.modelFullName).to.equal('volcengine-plan/doubao-seed-2.0-code');
        expect(parsed.modelName).to.equal('volcengine-plan/doubao-seed-2.0-code');
        expect(parsed.modelWarning).to.equal(undefined);
    });

    it('keeps legacy non-provider model values unqualified and warns', () => {
        const parsed = parseModelName('qwen3:8b');
        expect(parsed.providerID).to.equal(undefined);
        expect(parsed.modelID).to.equal('qwen3:8b');
        expect(parsed.modelFullName).to.equal('qwen3:8b');
        expect(parsed.modelWarning).to.include('provider/model');
    });

    it('returns the complete OpenCode config shape', () => {
        const result = resolveLLMConfig(makeReader({}));
        const expectedKeys: (keyof LLMConfig)[] = [
            'modelName',
            'providerID',
            'modelID',
            'modelFullName',
            'modelWarning',
            'timeoutMs',
            'opencodeMode',
            'opencodeServePort',
            'opencodeCliPath',
            'opencodeAcpArgs',
            'opencodeApiKey',
        ];

        for (const key of expectedKeys) {
            expect(result).to.have.property(key);
        }
    });
});
