import { expect } from 'chai';
import * as sinon from 'sinon';
import * as child_process from 'child_process';
import * as http from 'http';
import { EventEmitter } from 'events';
import {
    _resetServerManagerTestDeps,
    _setServerManagerTestDeps,
    OpenCodeServerManager,
} from './opencodeServerManager';

class MockChildProcess extends EventEmitter {
    public stdout = new EventEmitter();
    public stderr = new EventEmitter();
    public killed = false;

    kill(_signal?: NodeJS.Signals | number): boolean {
        this.killed = true;
        return true;
    }
}

class MockClientRequest extends EventEmitter {
    public callback?: (res: http.IncomingMessage) => void;
    public destroyed = false;

    end(): void {}

    destroy(): this {
        this.destroyed = true;
        return this;
    }
}

class MockIncomingMessage extends EventEmitter {
    resume(): void {}
}

describe('OpenCodeServerManager', () => {
    let spawnStub: sinon.SinonStub;
    let httpRequestStub: sinon.SinonStub;

    beforeEach(() => {
        spawnStub = sinon.stub().returns(new MockChildProcess() as unknown as child_process.ChildProcess);
        httpRequestStub = sinon.stub().callsFake((options: any, callback?: any) => {
            const req = new MockClientRequest();
            req.callback = typeof callback === 'function' ? callback : undefined;
            queueMicrotask(() => {
                if (options.path === '/global/health' || options.path === '/') {
                    req.callback?.(new MockIncomingMessage() as unknown as http.IncomingMessage);
                }
            });
            return req as unknown as http.ClientRequest;
        });
        _setServerManagerTestDeps({
            spawn: spawnStub as any,
            httpRequest: httpRequestStub as any,
        });
    });

    afterEach(() => {
        sinon.restore();
        _resetServerManagerTestDeps();
    });

    it('reuses an already running local server without spawning a new process', async () => {
        const manager = new OpenCodeServerManager({
            servePort: 7325,
            timeoutMs: 1000,
        });

        const baseUrl = await manager.ensureReady();
        expect(baseUrl).to.equal('http://127.0.0.1:7325');
        expect(spawnStub.called).to.equal(false);
    });

    it('starts the local server when no process is listening on the configured port', async () => {
        httpRequestStub.callsFake((options: any, callback?: any) => {
            const req = new MockClientRequest();
            req.callback = typeof callback === 'function' ? callback : undefined;
            queueMicrotask(() => {
                if (options.path === '/global/health') {
                    req.emit('error', new Error('ECONNREFUSED'));
                    return;
                }
                if (options.path === '/') {
                    req.callback?.(new MockIncomingMessage() as unknown as http.IncomingMessage);
                }
            });
            return req as unknown as http.ClientRequest;
        });

        const manager = new OpenCodeServerManager({
            servePort: 7325,
            timeoutMs: 1000,
            cliPath: '/usr/local/bin/opencode',
        });

        const baseUrl = await manager.ensureReady();
        expect(baseUrl).to.equal('http://127.0.0.1:7325');
        expect(spawnStub.calledOnce).to.equal(true);
        expect(spawnStub.firstCall.args[0]).to.equal('/usr/local/bin/opencode');
        expect(spawnStub.firstCall.args[1]).to.deep.equal(['serve', '--port', '7325']);
    });

    it('reports a clear startup failure when the CLI path is invalid', async () => {
        httpRequestStub.callsFake((options: any, _callback?: any) => {
            const req = new MockClientRequest();
            queueMicrotask(() => {
                if (options.path === '/global/health') {
                    req.emit('error', new Error('ECONNREFUSED'));
                }
            });
            return req as unknown as http.ClientRequest;
        });
        spawnStub.throws(new Error('spawn ENOENT'));

        const manager = new OpenCodeServerManager({
            servePort: 7325,
            timeoutMs: 1000,
            cliPath: '/missing/opencode',
        });

        try {
            await manager.ensureReady();
            expect.fail('expected ensureReady() to throw');
        } catch (error) {
            expect(error).to.be.instanceOf(Error);
            expect((error as Error).message).to.include(
                'OpenCode CLI not found at: /missing/opencode',
            );
        }
    });
});
