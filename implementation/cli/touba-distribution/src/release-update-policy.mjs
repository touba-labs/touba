import {readFileSync} from 'node:fs';
import {join} from 'node:path';

// A new semantic version alone cannot pass the updater's anti-rollback check.
// Enforce its separately ordered build sequence before producing public bytes.
export function assertReleaseUpdateSequence(index, policy) {
  const current=index.versions?.find(r=>r.version===index.current_version);
  const sequence=policy?.build_sequence;
  if(!Number.isSafeInteger(sequence)||sequence<1||current?.update_build_sequence!==sequence)
    throw new Error('ReleaseUpdateSequenceMismatch: align the current release index and embedded update policy');
  for(const release of index.versions??[]) {
    if(release===current||release.update_build_sequence===undefined)continue;
    if(!Number.isSafeInteger(release.update_build_sequence)||release.update_build_sequence<1||release.update_build_sequence>=sequence)
      throw new Error('ReleaseUpdateSequenceNotIncreasing: a new public build must exceed all retained release sequences');
  }
  return sequence;
}
export function checkReleaseUpdateSequence(root) {
  return assertReleaseUpdateSequence(
    JSON.parse(readFileSync(join(root,'release/releases.json'))),
    JSON.parse(readFileSync(join(root,'cli/touba-project/src/update/trust.json'))));
}
