export const DEFAULT_OPENCODE_MODEL = 'opencode/minimax-m2.5-free';
export const LEGACY_DEFAULT_OPENCODE_MODELS = [
    'opencode/big-pickle',
    'opencode/gpt-5-nano',
] as const;
export const LEGACY_DEFAULT_OPENCODE_MODEL = LEGACY_DEFAULT_OPENCODE_MODELS[0];

export interface LLMConfig {
    /** Full OpenCode model ID persisted in settings, for example "provider/model". */
    modelName: string;
    /** Provider portion of modelName. Required by OpenCode server prompt requests. */
    providerID?: string;
    /** Model portion of modelName, without the provider prefix. */
    modelID: string;
    /** Alias for modelName used by transport/UI code that needs an explicit full ID. */
    modelFullName: string;
    /** Warning emitted when a legacy non-provider-qualified value is configured. */
    modelWarning?: string;
    timeoutMs: number;
    opencodeServePort: number;
    opencodeCliPath: string;
}

export interface ConfigReader {
    get<T>(key: string): T | undefined;
}

export function parseModelName(raw: string | undefined): {
    modelName: string;
    providerID?: string;
    modelID: string;
    modelFullName: string;
    modelWarning?: string;
} {
    const modelName = raw?.trim() || DEFAULT_OPENCODE_MODEL;
    const slashIndex = modelName.indexOf('/');
    if (slashIndex > 0 && slashIndex < modelName.length - 1) {
        const providerID = modelName.substring(0, slashIndex);
        const modelID = modelName.substring(slashIndex + 1);
        return {
            modelName,
            providerID,
            modelID,
            modelFullName: modelName,
        };
    }

    return {
        modelName,
        modelID: modelName,
        modelFullName: modelName,
        modelWarning: `msagent.modelName must be a full OpenCode model ID like "provider/model"; current value "${modelName}" has no provider prefix.`,
    };
}

export function resolveLLMConfig(cfg: ConfigReader): LLMConfig {
    const model = parseModelName(cfg.get<string>('modelName'));
    return {
        modelName: model.modelName,
        providerID: model.providerID,
        modelID: model.modelID,
        modelFullName: model.modelFullName,
        modelWarning: model.modelWarning,
        timeoutMs: cfg.get<number>('timeoutMs') ?? 300000,
        opencodeServePort: cfg.get<number>('opencodeServePort') ?? 4096,
        opencodeCliPath: cfg.get<string>('opencodeCliPath') || 'opencode',
    };
}
