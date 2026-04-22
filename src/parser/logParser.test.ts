import { expect } from 'chai';
import { parseLog, parseLogFile } from './logParser';
import { MemErrorType, Severity, AddressSpace, BlockType } from './types';
import { fixturePath } from '../test/setup';

describe('logParser', () => {
  describe('parseLogFile', () => {
    it('should parse out_of_bounds.log correctly', () => {
      const result = parseLogFile(fixturePath('out_of_bounds.log'));
      expect(result.parseErrors).to.be.empty;
      expect(result.diagnostics).to.have.length(1);
      
      const diag = result.diagnostics[0];
      expect(diag.errorType).to.equal(MemErrorType.OUT_OF_BOUNDS);
      expect(diag.severity).to.equal(Severity.WARNING);
      expect(diag.fileName).to.equal('add_custom.cpp');
      expect(diag.lineNumber).to.equal(30);
      expect(diag.address).to.equal('0x402000800');
      expect(diag.addressSpace).to.equal(AddressSpace.GM);
      expect(diag.byteSize).to.equal(224);
      expect(diag.blockInfo.blockType).to.equal(BlockType.AICORE);
      expect(diag.blockInfo.coreId).to.equal(0);
      expect(diag.serialNo).to.equal(142);
    });

    it('should parse illegal_read.log correctly', () => {
      const result = parseLogFile(fixturePath('illegal_read.log'));
      expect(result.parseErrors).to.be.empty;
      expect(result.diagnostics).to.have.length(1);
      expect(result.diagnostics[0].errorType).to.equal(MemErrorType.ILLEGAL_ADDR_READ);
      expect(result.diagnostics[0].severity).to.equal(Severity.ERROR);
    });

    it('should parse illegal_write.log correctly', () => {
      const result = parseLogFile(fixturePath('illegal_write.log'));
      expect(result.parseErrors).to.be.empty;
      expect(result.diagnostics).to.have.length(1);
      expect(result.diagnostics[0].errorType).to.equal(MemErrorType.ILLEGAL_ADDR_WRITE);
    });

    it('should parse illegal_free.log correctly', () => {
      const result = parseLogFile(fixturePath('illegal_free.log'));
      expect(result.parseErrors).to.be.empty;
      expect(result.diagnostics).to.have.length(1);
      expect(result.diagnostics[0].errorType).to.equal(MemErrorType.ILLEGAL_FREE);
    });

    it('should parse mem_leak.log correctly', () => {
      const result = parseLogFile(fixturePath('mem_leak.log'));
      expect(result.parseErrors).to.be.empty;
      expect(result.diagnostics).to.have.length(1);
      expect(result.diagnostics[0].errorType).to.equal(MemErrorType.MEM_LEAK);
      expect(result.diagnostics[0].severity).to.equal(Severity.ERROR);
    });

    it('should parse misaligned_access.log correctly', () => {
      const result = parseLogFile(fixturePath('misaligned_access.log'));
      expect(result.parseErrors).to.be.empty;
      expect(result.diagnostics).to.have.length(1);
      expect(result.diagnostics[0].errorType).to.equal(MemErrorType.MISALIGNED_ACCESS);
    });

    it('should parse uninitialized_read.log correctly', () => {
      const result = parseLogFile(fixturePath('uninitialized_read.log'));
      expect(result.parseErrors).to.be.empty;
      expect(result.diagnostics).to.have.length(1);
      expect(result.diagnostics[0].errorType).to.equal(MemErrorType.UNINITIALIZED_READ);
    });

    it('should parse unused_memory.log correctly', () => {
      const result = parseLogFile(fixturePath('unused_memory.log'));
      expect(result.parseErrors).to.be.empty;
      expect(result.diagnostics).to.have.length(1);
      expect(result.diagnostics[0].errorType).to.equal(MemErrorType.MEM_UNUSED);
      expect(result.diagnostics[0].severity).to.equal(Severity.WARNING);
    });

    it('should parse mixed_errors.log correctly', () => {
      const result = parseLogFile(fixturePath('mixed_errors.log'));
      expect(result.parseErrors).to.be.empty;
      expect(result.diagnostics.length).to.be.greaterThan(1);
    });

    it('should handle no_errors.log gracefully', () => {
      const result = parseLogFile(fixturePath('no_errors.log'));
      expect(result.parseErrors).to.be.empty;
      expect(result.diagnostics).to.be.empty;
    });

    it('should handle non-existent file', () => {
      const result = parseLogFile(fixturePath('non_existent.log'));
      expect(result.parseErrors).to.have.length(1);
      expect(result.parseErrors[0]).to.include('File not found');
      expect(result.diagnostics).to.be.empty;
    });
  });

  describe('parseLog', () => {
    it('should handle empty string', () => {
      const result = parseLog('');
      expect(result.parseErrors).to.be.empty;
      expect(result.diagnostics).to.be.empty;
    });

    it('should handle whitespace only', () => {
      const result = parseLog('   \n  \t  ');
      expect(result.parseErrors).to.be.empty;
      expect(result.diagnostics).to.be.empty;
    });
  });
});
