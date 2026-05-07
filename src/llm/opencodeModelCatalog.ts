import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export type OpenCodeModelSource = 'workspace' | 'user' | 'built-in';

export interface OpenCodeModelEntry {
    id: string;
    source: OpenCodeModelSource;
    sourcePath?: string;
}

interface ConfigPathSpec {
    filePath: string;
    source: OpenCodeModelSource;
}

export interface OpenCodeModelCatalogDeps {
    existsSync: (filePath: string) => boolean;
    readFileSync: (filePath: string, encoding: BufferEncoding) => string;
    homedir: () => string;
}

export interface LoadOpenCodeModelCatalogOptions {
    workspaceRoots?: string[];
    deps?: OpenCodeModelCatalogDeps;
}

export const BUILTIN_FREE_OPENCODE_MODELS = [
    'opencode/minimax-m2.5-free',
    'opencode/big-pickle',
    'opencode/gpt-5-nano',
    'opencode/hy3-preview-free',
    'opencode/ling-2.6-flash-free',
    'opencode/nemotron-3-super-free',
] as const;

const defaultDeps: OpenCodeModelCatalogDeps = {
    existsSync: fs.existsSync,
    readFileSync: fs.readFileSync,
    homedir: os.homedir,
};

function isRecordLike(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object';
}

function normalizeModelID(value: unknown): string | undefined {
    if (typeof value !== 'string') {
        return undefined;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
}

function modelIDsFromCollection(models: unknown): string[] {
    if (Array.isArray(models)) {
        return models
            .map((entry) => {
                if (typeof entry === 'string') {
                    return normalizeModelID(entry);
                }
                if (isRecordLike(entry)) {
                    return normalizeModelID(entry.id) ?? normalizeModelID(entry.name) ?? normalizeModelID(entry.model);
                }
                return undefined;
            })
            .filter((entry): entry is string => Boolean(entry))
            .sort((a, b) => a.localeCompare(b));
    }

    if (isRecordLike(models)) {
        return Object.keys(models)
            .map((key) => key.trim())
            .filter((key) => key.length > 0)
            .sort((a, b) => a.localeCompare(b));
    }

    return [];
}

export function extractModelsFromOpenCodeConfig(config: unknown): string[] {
    if (!isRecordLike(config) || !isRecordLike(config.provider)) {
        return [];
    }

    const models: string[] = [];
    for (const providerID of Object.keys(config.provider).sort((a, b) => a.localeCompare(b))) {
        const providerConfig = config.provider[providerID];
        if (!isRecordLike(providerConfig)) {
            continue;
        }
        const modelIDs = modelIDsFromCollection(providerConfig.models);
        for (const modelID of modelIDs) {
            models.push(`${providerID}/${modelID}`);
        }
    }
    return models;
}

function getConfigPathSpecs(workspaceRoots: string[], homeDir: string): ConfigPathSpec[] {
    const specs: ConfigPathSpec[] = [];
    for (const workspaceRoot of workspaceRoots) {
        if (workspaceRoot && workspaceRoot.trim()) {
            specs.push({
                filePath: path.join(workspaceRoot, 'opencode.json'),
                source: 'workspace',
            });
        }
    }
    specs.push(
        {
            filePath: path.join(homeDir, '.config', 'opencode', 'opencode.json'),
            source: 'user',
        },
        {
            filePath: path.join(homeDir, '.config', 'opencode', 'config.json'),
            source: 'user',
        },
    );
    return specs;
}

export function loadOpenCodeModelCatalog(
    options: LoadOpenCodeModelCatalogOptions = {},
): OpenCodeModelEntry[] {
    const deps = options.deps ?? defaultDeps;
    const entries: OpenCodeModelEntry[] = [];
    const seen = new Set<string>();

    const addEntry = (entry: OpenCodeModelEntry): void => {
        if (seen.has(entry.id)) {
            return;
        }
        seen.add(entry.id);
        entries.push(entry);
    };

    const homeDir = deps.homedir();
    const workspaceRoots = options.workspaceRoots ?? [];
    for (const spec of getConfigPathSpecs(workspaceRoots, homeDir)) {
        if (!deps.existsSync(spec.filePath)) {
            continue;
        }
        try {
            const raw = deps.readFileSync(spec.filePath, 'utf-8');
            const config = JSON.parse(raw);
            for (const id of extractModelsFromOpenCodeConfig(config)) {
                addEntry({ id, source: spec.source, sourcePath: spec.filePath });
            }
        } catch {
            continue;
        }
    }

    for (const id of BUILTIN_FREE_OPENCODE_MODELS) {
        addEntry({ id, source: 'built-in' });
    }

    return entries;
}

export function loadOpenCodeModels(options: LoadOpenCodeModelCatalogOptions = {}): string[] {
    return loadOpenCodeModelCatalog(options).map((entry) => entry.id);
}
