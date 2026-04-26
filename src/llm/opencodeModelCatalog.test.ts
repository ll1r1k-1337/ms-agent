import { expect } from 'chai';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    BUILTIN_FREE_OPENCODE_MODELS,
    extractModelsFromOpenCodeConfig,
    loadOpenCodeModelCatalog,
    loadOpenCodeModels,
} from './opencodeModelCatalog';

describe('opencodeModelCatalog', () => {
    let tempDir: string;

    beforeEach(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'msagent-models-'));
    });

    afterEach(() => {
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it('extracts provider/model IDs from OpenCode provider models', () => {
        const models = extractModelsFromOpenCodeConfig({
            provider: {
                'volcengine-plan': {
                    models: {
                        'doubao-seed-2.0-code': {},
                        'glm-5.1': {},
                    },
                },
                moonshot: {
                    models: {
                        'kimi-k2.6': {},
                    },
                },
            },
        });

        expect(models).to.deep.equal([
            'moonshot/kimi-k2.6',
            'volcengine-plan/doubao-seed-2.0-code',
            'volcengine-plan/glm-5.1',
        ]);
    });

    it('merges workspace, user, and built-in free models with de-duplication', () => {
        const workspaceRoot = path.join(tempDir, 'workspace');
        const homeDir = path.join(tempDir, 'home');
        const userConfigDir = path.join(homeDir, '.config', 'opencode');
        fs.mkdirSync(workspaceRoot, { recursive: true });
        fs.mkdirSync(userConfigDir, { recursive: true });
        fs.writeFileSync(path.join(workspaceRoot, 'opencode.json'), JSON.stringify({
            provider: {
                'volcengine-plan': {
                    models: {
                        'doubao-seed-2.0-code': {},
                    },
                },
            },
        }), 'utf-8');
        fs.writeFileSync(path.join(userConfigDir, 'opencode.json'), JSON.stringify({
            provider: {
                'volcengine-plan': {
                    models: {
                        'doubao-seed-2.0-code': {},
                        'kimi-k2.6': {},
                    },
                },
            },
        }), 'utf-8');

        const entries = loadOpenCodeModelCatalog({
            workspaceRoots: [workspaceRoot],
            deps: {
                existsSync: fs.existsSync,
                readFileSync: fs.readFileSync,
                homedir: () => homeDir,
            },
        });

        expect(entries.map((entry) => entry.id)).to.include.members([
            'volcengine-plan/doubao-seed-2.0-code',
            'volcengine-plan/kimi-k2.6',
            BUILTIN_FREE_OPENCODE_MODELS[0],
        ]);
        expect(entries.filter((entry) => entry.id === 'volcengine-plan/doubao-seed-2.0-code')).to.have.length(1);
        expect(entries.find((entry) => entry.id === 'volcengine-plan/doubao-seed-2.0-code')?.source).to.equal('workspace');
    });

    it('falls back to built-in free models when no config files exist', () => {
        const models = loadOpenCodeModels({
            workspaceRoots: [path.join(tempDir, 'missing-workspace')],
            deps: {
                existsSync: fs.existsSync,
                readFileSync: fs.readFileSync,
                homedir: () => path.join(tempDir, 'missing-home'),
            },
        });

        expect(models).to.deep.equal([...BUILTIN_FREE_OPENCODE_MODELS]);
    });
});
