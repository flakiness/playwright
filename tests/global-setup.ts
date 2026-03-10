import fs from 'node:fs';
import { ARTIFACTS_DIR } from './utils';

export default function globalSetup() {
  fs.rmSync(ARTIFACTS_DIR, { recursive: true, force: true });
}
