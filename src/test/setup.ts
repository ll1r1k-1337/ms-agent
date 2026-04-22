import * as path from 'path';

export const FIXTURES_DIR = path.resolve(__dirname, '../../test/fixtures');
export const FIXTURES_SRC_DIR = path.resolve(__dirname, '../../test/fixtures-src');

export function fixturePath(name: string): string {
  return path.join(FIXTURES_DIR, name);
}

export function sourcePath(name: string): string {
  return path.join(FIXTURES_SRC_DIR, name);
}
