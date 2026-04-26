import * as fs from 'fs';
import * as path from 'path';

export const fixDetailsScript = fs.readFileSync(
    path.resolve(__dirname, '../../media/fixPanel.js'),
    'utf-8',
);
