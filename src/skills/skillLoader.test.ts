import { expect } from 'chai';
import * as sinon from 'sinon';
import * as fsModule from 'fs';
const fs = require('fs') as typeof fsModule;
import { loadSkill, buildFixPrompt } from './skillLoader';

describe('loadSkill', () => {
    let existsSyncStub: sinon.SinonStub;
    let readFileSyncStub: sinon.SinonStub;

    beforeEach(() => {
        existsSyncStub = sinon.stub(fs, 'existsSync');
        readFileSyncStub = sinon.stub(fs, 'readFileSync');
    });

    afterEach(() => {
        sinon.restore();
    });

    it('should return file content when skill file exists', () => {
        existsSyncStub.returns(true);
        readFileSyncStub.returns('mock skill content');

        const result = loadSkill('memcheck');

        expect(result).to.equal('mock skill content');
        expect(existsSyncStub.calledOnce).to.be.true;
        expect(readFileSyncStub.calledOnce).to.be.true;

        const calledPath = existsSyncStub.firstCall.args[0] as string;
        expect(calledPath.endsWith('memcheck.md')).to.be.true;
        expect(readFileSyncStub.firstCall.args[1]).to.equal('utf-8');
    });

    it('should return null when skill file does not exist', () => {
        existsSyncStub.returns(false);

        const result = loadSkill('nonexistent');

        expect(result).to.be.null;
        expect(readFileSyncStub.called).to.be.false;

        const calledPath = existsSyncStub.firstCall.args[0] as string;
        expect(calledPath.endsWith('nonexistent.md')).to.be.true;
    });

    it('should handle different skill names', () => {
        existsSyncStub.returns(true);
        readFileSyncStub.returns('another skill');

        const result = loadSkill('bounds-check');

        expect(result).to.equal('another skill');

        const calledPath = existsSyncStub.firstCall.args[0] as string;
        expect(calledPath.endsWith('bounds-check.md')).to.be.true;
    });
});

describe('buildFixPrompt', () => {
    it('should build prompt with full diagnostic object', () => {
        const diagnostic = {
            errorType: 'OUT_OF_BOUNDS',
            severity: 'ERROR',
            fileName: '/workspace/test.cpp',
            lineNumber: 42,
            address: '0x1000',
            addressSpace: 'GM',
            byteSize: 4,
            kernelName: 'TestKernel',
        };

        const prompt = buildFixPrompt(diagnostic);

        expect(prompt).to.include('## Error to Fix');
        expect(prompt).to.include('**Type**: OUT_OF_BOUNDS');
        expect(prompt).to.include('**Severity**: ERROR');
        expect(prompt).to.include('/workspace/test.cpp:42');
        expect(prompt).to.include('0x1000 on GM');
        expect(prompt).to.include('4 bytes');
        expect(prompt).to.include('**Kernel**: TestKernel');
        expect(prompt).to.include('## Instructions');
        expect(prompt).to.include('native file/context tools');
        expect(prompt).to.include('native edit');
    });

    it('should build prompt with minimal diagnostic object (no kernelName)', () => {
        const diagnostic = {
            errorType: 'MEM_LEAK',
            severity: 'WARNING',
            fileName: 'kernel.cpp',
            lineNumber: 10,
            address: '0x2000',
            addressSpace: 'UB',
            byteSize: 1024,
        };

        const prompt = buildFixPrompt(diagnostic);

        expect(prompt).to.include('MEM_LEAK');
        expect(prompt).to.include('WARNING');
        expect(prompt).to.include('kernel.cpp:10');
        expect(prompt).to.include('0x2000 on UB');
        expect(prompt).to.include('1024 bytes');
        expect(prompt).to.not.include('Kernel');
        expect(prompt).to.include('## Instructions');
    });

    it('should include kernelName when provided', () => {
        const diagnostic = {
            errorType: 'ILLEGAL_ADDR_READ',
            severity: 'CRITICAL',
            fileName: 'a.cpp',
            lineNumber: 1,
            address: '0x0',
            addressSpace: 'L0',
            byteSize: 8,
            kernelName: 'VecAdd',
        };

        const prompt = buildFixPrompt(diagnostic);

        expect(prompt).to.include('**Kernel**: VecAdd');
    });

    it('should omit kernelName line when not provided', () => {
        const diagnostic = {
            errorType: 'UNINITIALIZED_READ',
            severity: 'ERROR',
            fileName: 'b.cpp',
            lineNumber: 5,
            address: '0xABC',
            addressSpace: 'GM',
            byteSize: 16,
        };

        const prompt = buildFixPrompt(diagnostic);

        expect(prompt).to.not.include('**Kernel**');
    });
});
