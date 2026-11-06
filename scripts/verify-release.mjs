import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';

process.chdir(fileURLToPath(new URL('..', import.meta.url)));
const release = JSON.parse(await readFile('release-checksums.json', 'utf8'));
for (const [file, expected] of Object.entries(release.files)) {
  const actual = createHash('sha256').update(await readFile(file)).digest('hex');
  assert.equal(actual, expected, file + ' differs from the tested release');
}
console.log(`Verified ${Object.keys(release.files).length} release files for ${release.version}`);
