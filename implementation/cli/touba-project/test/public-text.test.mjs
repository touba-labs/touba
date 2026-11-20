import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { UNSAFE_PUBLIC_TEXT, DEFAULT_IGNORABLE } from '../src/public-text.mjs';
import { validatePackageDocument } from '../src/package-contract.mjs';
const corpus = JSON.parse(readFileSync(new URL('./fixtures/public-text.json', import.meta.url)));
for (const [first, last] of corpus.refused_ranges) for(let point=first;point<=last;point++) corpus.refused.push('before'+String.fromCodePoint(point)+'after');
const document = {package_schema_version:'touba-package-v1',name:'acme.tools',version:'1.0.0',
  touba:{air_profile:'touba-air-json-canonical-v1',runtime_compatibility:'>=1.0.0 <2.0.0'},exports:{skills:['skill:acme.tools/Run']}};
test('public text corpus preserves scripts and emoji and rejects deceptive controls', () => {
  for (const value of corpus.allowed) {
    assert.equal(UNSAFE_PUBLIC_TEXT.test(value), false);
    assert.doesNotThrow(() => validatePackageDocument({...document,description:value}));
  }
  for (const value of corpus.refused) {
    assert.equal(UNSAFE_PUBLIC_TEXT.test(value), true);
    for (const field of ['description','publisher','license']) assert.throws(() => validatePackageDocument({...document,[field]:value}), {code:'PackageMetadataInvalid'});
  }
});

test('pinned Unicode property covers every default-ignorable code point in Node Unicode 17', () => {
  assert.equal(process.versions.unicode, '17.0', 'review pinned Unicode data when upgrading the toolchain');
  for (let point = 0; point <= 0x10ffff; point++) {
    const character = String.fromCodePoint(point);
    assert.equal(DEFAULT_IGNORABLE.test(character), /\p{Default_Ignorable_Code_Point}/u.test(character), `U+${point.toString(16)}`);
  }
});
