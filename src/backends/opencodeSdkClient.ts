export interface OpenCodePromptBody {
    model: {
        providerID: string;
        modelID: string;
    };
    parts: Array<{ type: 'text'; text: string }>;
}

export interface OpenCodeSdkClientConfig {
    baseUrl: string;
    timeoutMs: number;
}

interface EventSubscriptionResponse {
    stream?: AsyncIterable<unknown>;
    controller?: { abort?: () => void };
}

interface OpencodeSdkClientLike {
    event?: {
        subscribe?: () => Promise<EventSubscriptionResponse | AsyncIterable<unknown>>;
        list?: () => Promise<EventSubscriptionResponse | AsyncIterable<unknown>>;
    };
    session?: {
        create?: (input?: Record<string, unknown>) => Promise<unknown>;
        promptAsync?: (input: Record<string, unknown>) => Promise<unknown>;
        prompt?: (input: Record<string, unknown>) => Promise<unknown>;
        abort?: (input: Record<string, unknown>) => Promise<unknown>;
        messages?: (input: Record<string, unknown>) => Promise<unknown>;
    };
    post?: (path: string, options: { body: unknown }) => Promise<unknown>;
}

type ClientFactory = (config: Record<string, unknown>) => Promise<OpencodeSdkClientLike> | OpencodeSdkClientLike;

const nativeImport = new Function(
    'specifier',
    'return import(specifier)',
) as (specifier: string) => Promise<Record<string, unknown>>;

const defaultFactory: ClientFactory = async (config) => {
    const sdkModule = await nativeImport('@opencode-ai/sdk/v2/client');
    const createClient = sdkModule.createOpencodeClient;
    if (typeof createClient !== 'function') {
        throw new Error('OpenCode SDK v2 client export is unavailable');
    }
    return createClient(config) as OpencodeSdkClientLike;
};

let clientFactory: ClientFactory = defaultFactory;

export function _setSdkClientTestFactory(factory: ClientFactory): void {
    clientFactory = factory;
}

export function _resetSdkClientTestFactory(): void {
    clientFactory = defaultFactory;
}

function getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function extractDataPayload<T>(value: unknown): T | null {
    if (!value || typeof value !== 'object') {
        return null;
    }
    if ('data' in (value as Record<string, unknown>)) {
        return ((value as Record<string, unknown>).data as T | null) ?? null;
    }
    return value as T;
}

function normalizeSessionId(response: unknown): string | null {
    const payload = extractDataPayload<Record<string, unknown>>(response);
    if (!payload) {
        return null;
    }
    if (typeof payload.id === 'string') {
        return payload.id;
    }
    return null;
}

function normalizeMessageList(response: unknown): unknown[] | null {
    const payload = extractDataPayload<unknown>(response);
    if (Array.isArray(payload)) {
        return payload;
    }
    if (!payload || typeof payload !== 'object') {
        return null;
    }
    const record = payload as Record<string, unknown>;
    const candidates = [record.messages, record.items, record.data];
    for (const candidate of candidates) {
        if (Array.isArray(candidate)) {
            return candidate;
        }
    }
    return null;
}

function normalizeEventSubscription(
    response: EventSubscriptionResponse | AsyncIterable<unknown>,
): { stream: AsyncIterable<unknown>; close: () => void } {
    if (response && typeof (response as any)[Symbol.asyncIterator] === 'function') {
        const stream = response as AsyncIterable<unknown> & { controller?: { abort?: () => void } };
        return {
            stream,
            close: () => stream.controller?.abort?.(),
        };
    }
    const subscription = response as EventSubscriptionResponse;
    if (!subscription?.stream) {
        throw new Error('OpenCode SDK event subscription did not return a stream');
    }
    return {
        stream: subscription.stream,
        close: () => subscription.controller?.abort?.(),
    };
}

export class OpenCodeSdkClient {
    private readonly config: OpenCodeSdkClientConfig;
    private clientPromise: Promise<OpencodeSdkClientLike> | null = null;

    constructor(config: OpenCodeSdkClientConfig) {
        this.config = config;
    }

    async subscribeEvents(): Promise<{ stream: AsyncIterable<unknown>; close: () => void }> {
        try {
            const client = await this.getClient();
            if (client.event?.subscribe) {
                return normalizeEventSubscription(await client.event.subscribe());
            }
            if (client.event?.list) {
                return normalizeEventSubscription(await client.event.list());
            }
        } catch (error) {
            throw new Error(`OpenCode SDK failed to subscribe to events: ${getErrorMessage(error)}`);
        }
        throw new Error('OpenCode SDK does not expose an event subscription API');
    }

    async createSession(): Promise<string> {
        const client = await this.getClient();
        if (!client.session?.create) {
            throw new Error('OpenCode SDK does not expose session.create()');
        }
        try {
            const response = await client.session.create({});
            const sessionId = normalizeSessionId(response);
            if (!sessionId) {
                throw new Error('OpenCode server did not return a session ID');
            }
            return sessionId;
        } catch (error) {
            throw new Error(`OpenCode SDK failed to create a session: ${getErrorMessage(error)}`);
        }
    }

    async promptSession(sessionID: string, body: OpenCodePromptBody): Promise<void> {
        const client = await this.getClient();
        try {
            if (client.session?.promptAsync) {
                await client.session.promptAsync({
                    sessionID,
                    model: body.model,
                    parts: body.parts,
                });
                return;
            }
            if (client.session?.prompt) {
                await client.session.prompt({
                    sessionID,
                    model: body.model,
                    parts: body.parts,
                });
                return;
            }
            if (client.post) {
                await client.post(`/session/${sessionID}/prompt_async`, { body });
                return;
            }
        } catch (error) {
            throw new Error(`OpenCode SDK failed to send the repair prompt: ${getErrorMessage(error)}`);
        }
        throw new Error('OpenCode SDK does not expose a prompt API');
    }

    async abortSession(sessionID: string): Promise<void> {
        const client = await this.getClient();
        if (!client.session?.abort) {
            return;
        }
        try {
            await client.session.abort({ sessionID });
        } catch (error) {
            throw new Error(`OpenCode SDK failed to abort the session: ${getErrorMessage(error)}`);
        }
    }

    async readSessionMessages(sessionID: string): Promise<unknown[] | null> {
        const client = await this.getClient();
        if (!client.session?.messages) {
            return null;
        }
        try {
            const response = await client.session.messages({ sessionID });
            return normalizeMessageList(response);
        } catch (error) {
            throw new Error(`OpenCode SDK failed to read session messages: ${getErrorMessage(error)}`);
        }
    }

    private getClient(): Promise<OpencodeSdkClientLike> {
        if (!this.clientPromise) {
            this.clientPromise = Promise.resolve(clientFactory({
                baseUrl: this.config.baseUrl,
                timeout: this.config.timeoutMs,
            }));
        }
        return this.clientPromise;
    }
}
