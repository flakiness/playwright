#!/usr/bin/env node
/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
// @ts-check

/**
 * Use the following command to typescheck this file:
 * npx tsc --target es2020  --watch --checkjs --noemit --moduleResolution node workspace.js
 */
import child_process from 'child_process';
import fs from 'fs';
import path from 'path';

const readJSON = async (filePath) => JSON.parse(await fs.promises.readFile(filePath, 'utf8'));
const writeJSON = async (filePath, json) => {
  await fs.promises.writeFile(filePath, JSON.stringify(json, null, 2) + '\n');
}

class NPMPackage {
  constructor(pkgPath) {
    this.path = pkgPath;
    this.packageJSONPath = path.join(this.path, 'package.json');
    this.packageJSON = JSON.parse(fs.readFileSync(this.packageJSONPath, 'utf8'));
    this.isPrivate = !!this.packageJSON.private;
    this.name = this.packageJSON.name;
  }
}

class Workspace {
  static async create(rootDir, packageNames) {
    const workspacePackageJSON = await readJSON(path.join(rootDir, 'package.json'));
    const packages = packageNames.map(packageName => new NPMPackage(path.join(rootDir, packageName)));
    return new Workspace(rootDir, packages);
  }

  /**
   * @param {string} rootDir
   * @param {NPMPackage[]} packages
   */
  constructor(rootDir, packages) {
    this._rootDir = rootDir;
    this._packages = packages;
  }

  async version() {
    const workspacePath = path.join(this._rootDir, 'package.json');
    const workspacePackageJSON = await readJSON(workspacePath);
    return workspacePackageJSON.version;
  }

  async bumpVersion(minorMajorPatch) {
    const workspacePath = path.join(this._rootDir, 'package.json');
    const workspacePackageJSON = await readJSON(workspacePath);
    const version = workspacePackageJSON.version;
    const tokens = version.split('.').map(x => parseInt(x, 10));
    if (minorMajorPatch === 'major') {
      ++tokens[0];
      tokens[1] = 0;
      tokens[2] = 0;
    } else if (minorMajorPatch === 'minor') {
      ++tokens[1];
      tokens[2] = 0;
    } else if (minorMajorPatch === 'patch') {
      ++tokens[2];
    } else {
      throw new Error('unknown command');
    }
    const newVersion = tokens.join('.');

    workspacePackageJSON.version = newVersion;
    await writeJSON(workspacePath, workspacePackageJSON);

    for (const pkg of this._packages) {
      // 2. Make sure package's package.jsons are consistent.
      pkg.packageJSON.version = newVersion;
      await writeJSON(pkg.packageJSONPath, pkg.packageJSON);
    }
  }
}

const versionBump = process.argv[2];
if (versionBump !== 'major-major-major' && versionBump !== 'minor' && versionBump !== 'patch') {
  console.error(`please specify type of version bump: must be either "major-major-major", "minor" or "patch"`);
  process.exit(1);
}

const workspace = await Workspace.create(import.meta.dirname, []);
await workspace.bumpVersion(versionBump);

// Re-run npm i to make package-lock dirty.
const version = await workspace.version();
child_process.execSync(`git commit -am "chore: mark v${version}"`);
child_process.execSync(`git tag v${version}`);
child_process.execSync(`git push --tags upstream main`);

