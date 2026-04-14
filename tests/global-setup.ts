import fs from 'node:fs';
import { ARTIFACTS_DIR } from './utils.js';

export default function globalSetup() {
  fs.rmSync(ARTIFACTS_DIR, { recursive: true, force: true });
}
