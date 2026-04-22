import { expect } from 'chai';
import * as sinon from 'sinon';
import { WebviewPanelProvider } from './webviewPanelProvider';

const vscode = require('vscode');

describe('WebviewPanelProvider', () => {
    let provider: WebviewPanelProvider;

    beforeEach(() => {
        provider = new WebviewPanelProvider();
    });

    afterEach(() => {
        sinon.restore();
    });

    describe('getHTML', () => {
        let mockWebview: any;

        beforeEach(() => {
            mockWebview = {
                cspSource: 'vscode-resource:',
            };
        });

        it('returns string with required DOM element IDs', () => {
            const html = (provider as any).getHTML(mockWebview);
            expect(html).to.be.a('string');

            const requiredIds = [
                'backendBadge',
                'degradedBanner',
                'phaseIndicator',
                'timeline',
                'diffCards',
                'sessionResult',
                'messages',
                'stopBtn',
                'cancelBtn',
                'queuePanel',
                'queueHeader',
                'queueBody',
            ];

            for (const id of requiredIds) {
                expect(html).to.include(`id="${id}"`, `Missing element with id="${id}"`);
            }
        });

        it('includes CSP nonce in script tag', () => {
            const html = (provider as any).getHTML(mockWebview);
            const nonceMatch = html.match(/nonce="([A-Za-z0-9]{32})"/);
            expect(nonceMatch).to.not.be.null;
            expect(html).to.include('<script nonce=');
        });

        it('includes required CSS classes', () => {
            const html = (provider as any).getHTML(mockWebview);

            const requiredClasses = [
                '.backend-badge',
                '.degraded-banner',
                '.phase-indicator',
                '.timeline',
                '.diff-cards',
                '.session-result',
            ];

            for (const cls of requiredClasses) {
                expect(html).to.include(cls, `Missing CSS class ${cls}`);
            }
        });
    });

    describe('createOrShow', () => {
        it('returns a webview panel', () => {
            const mockPanel = {
                webview: {
                    html: '',
                    onDidReceiveMessage: () => {},
                    postMessage: () => Promise.resolve(true),
                },
                onDidDispose: () => {},
                reveal: () => {},
                dispose: () => {},
            };

            const createWebviewPanelStub = sinon.stub(vscode.window, 'createWebviewPanel').returns(mockPanel);

            const mockContext = {
                extensionUri: { fsPath: '/test' },
                subscriptions: [],
            } as any;

            const panel = provider.createOrShow(mockContext);

            expect(panel).to.equal(mockPanel);
            expect(createWebviewPanelStub.calledOnce).to.be.true;
            expect(createWebviewPanelStub.firstCall.args[1]).to.equal('msAgent Fix Details');
        });
    });
});
