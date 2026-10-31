import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const versions = JSON.parse(await readFile(new URL('../versions.json', import.meta.url), 'utf8'));
for (const [path, expected] of Object.entries(versions.vendor_sha256)) {
  const content = await readFile(new URL(`../vendor/dsh-agent-loop-guard-0.2.24/${path}`, import.meta.url));
  assert.equal(createHash('sha256').update(content).digest('hex'), expected, path);
}
console.log(`Verified ${Object.keys(versions.vendor_sha256).length} upstream files; baseline is unchanged.`);
