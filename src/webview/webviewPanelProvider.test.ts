import { expect } from 'chai';
import * as sinon from 'sinon';
import * as fs from 'fs';
import * as path from 'path';
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
        let mockExtensionUri: any;

        beforeEach(() => {
            mockWebview = {
                cspSource: 'vscode-resource:',
                asWebviewUri: (uri: any) => ({ toString: () => 'webview-uri://' + uri.fsPath }),
            };
            mockExtensionUri = {
                fsPath: path.resolve(__dirname, '..', '..'),
            };
        });

        it('returns string with required DOM element IDs', () => {
            const html = (provider as any).getHTML(mockWebview, mockExtensionUri);
            expect(html).to.be.a('string');

            const requiredIds = [
                'messages',
                'meta-backend',
                'meta-mode',
                'meta-model',
                'meta-elapsed',
                'status-card',
                'status-progress',
                'elapsed-row',
                'queue-row',
                'queue-badge',
                'idle-hint',
                'tasks-cancelled-list',
                'tasks-pause-btn',
            ];

            for (const id of requiredIds) {
                expect(html).to.include(`id="${id}"`, `Missing element with id="${id}"`);
            }
            expect(html).to.include('data-card-toggle="status"');
            expect(html).to.include('data-card-toggle="tasks"');
            expect(html).to.include('data-group-toggle="completed"');
            expect(html).to.include('data-group-toggle="failed"');
            expect(html).to.include('data-group-toggle="cancelled"');
            expect(html).to.include('id="tasks-failed-list"');
            expect(html).to.include('id="tasks-cancelled-group"');
        });

        it('includes CSP nonce in script and link tags', () => {
            const html = (provider as any).getHTML(mockWebview, mockExtensionUri);
            const nonceMatch = html.match(/nonce="([A-Za-z0-9]{32})"/);
            expect(nonceMatch).to.not.be.null;
            expect(html).to.include('nonce=');
        });

        it('includes external style and script URIs', () => {
            const html = (provider as any).getHTML(mockWebview, mockExtensionUri);
            expect(html).to.include('fixPanel.css');
            expect(html).to.include('fixPanel.js');
        });

        it('loads the HTML template from media/fixPanel.html', () => {
            const html = (provider as any).getHTML(mockWebview, mockExtensionUri);
            const templatePath = path.join(mockExtensionUri.fsPath, 'media', 'fixPanel.html');
            const template = fs.readFileSync(templatePath, 'utf-8');
            expect(html).to.include(template.substring(0, 100));
        });
    });

    describe('createOrShow', () => {
        it('returns a webview panel', () => {
            const mockPanel = {
                webview: {
                    html: '',
                    cspSource: 'vscode-resource:',
                    asWebviewUri: (uri: any) => ({ toString: () => 'webview-uri://' + uri.fsPath }),
                    onDidReceiveMessage: () => {},
                    postMessage: () => Promise.resolve(true),
                },
                viewColumn: 2,
                onDidDispose: () => {},
                onDidChangeViewState: () => {},
                reveal: () => {},
                dispose: () => {},
            };

            const createWebviewPanelStub = sinon.stub(vscode.window, 'createWebviewPanel').returns(mockPanel);

            const mockContext = {
                extensionUri: { fsPath: path.resolve(__dirname, '..', '..') },
                subscriptions: [],
            } as any;

            const panel = provider.createOrShow(mockContext);

            expect(panel).to.equal(mockPanel);
            expect(createWebviewPanelStub.calledOnce).to.be.true;
            expect(createWebviewPanelStub.firstCall.args[1]).to.equal('msAgent Fix Details');
        });
    });
});
