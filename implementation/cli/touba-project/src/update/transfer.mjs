import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, mkdirSync } from 'node:fs';
import { finished, pipeline } from 'node:stream/promises';
import { Writable } from 'node:stream';
import { createGunzip } from 'node:zlib';
import { once } from 'node:events';
import { join } from 'node:path';
import { t, x } from 'tar';
import { fail, MAX_EXPANDED, trustedUrl } from './protocol.mjs';

// No redirects, credentials or downloaded shell script. Bounds apply while reading.
export async function download(url, { policy, destination, release, fetcher = fetch, signal }) {
  trustedUrl(url, policy, !!release);
  const limit = release?.size ?? 65536;
  const timeout = AbortSignal.timeout(release ? 300000 : 20000);
  const response = await fetcher(url, { redirect:'error', credentials:'omit', cache:'no-store', signal:signal ? AbortSignal.any([signal, timeout]) : timeout });
  if (!response.ok || !response.body) fail('UpdateDownloadFailed', `Update download failed (HTTP ${response.status}).`);
  const length = response.headers.get('content-length');
  if (length && (!/^\d+$/.test(length) || +length > limit || (release && +length !== limit))) {
    await response.body.cancel(); fail('UpdateDownloadSizeMismatch');
  }
  let size = 0; const chunks = [], hash = createHash('sha256');
  const stream = destination ? createWriteStream(destination, {flags:'wx',mode:0o600}) : null;
  // Observe write failures even if the HTTP read is currently pending.
  let writeError; stream?.on('error', error => { writeError = error; });
  try {
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > limit) fail('UpdateDownloadSizeMismatch');
      hash.update(chunk);
      if (writeError) throw writeError;
      if (stream) { if (!stream.write(chunk)) await once(stream,'drain'); }
      else chunks.push(chunk);
    }
    if (stream) { stream.end(); await finished(stream); }
    if (release && (size !== release.size || hash.digest('hex') !== release.sha256)) fail('UpdateArchiveHashMismatch');
    return stream ? undefined : Buffer.concat(chunks);
  } catch (error) { stream?.destroy(); throw error; }
}

export async function validateGzipSize(archive, maximum = MAX_EXPANDED + 128 * 1024 ** 2, signal) {
  let bytes = 0;
  const sink = new Writable({ write(chunk, _encoding, done) {
    bytes += chunk.length;
    done(bytes > maximum ? Object.assign(new Error('UpdateArchiveLimit'), { code: 'UpdateArchiveLimit' }) : null);
  } });
  const timeout = AbortSignal.timeout(300000);
  await pipeline(createReadStream(archive), createGunzip(), sink, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
}

export async function extractPayload(archive, destination, { signal } = {}) {
  // Count all decompressed bytes, including padding or data beyond the TAR end.
  // Entry sizes alone cannot bound a gzip bomb or ignored trailing content.
  await validateGzipSize(archive, undefined, signal);
  signal?.throwIfAborted();
  const seen = new Set(); let root, expanded = 0, count = 0;
  t({file:archive, sync:true, strict:true, maxMetaEntrySize:65536, onReadEntry: entry => {
    const path = entry.path.replace(/\/$/, '');
    const parts = path.split('/');
    if (!path || path.length > 1024 || /[\\:\x00-\x1f\x7f]/.test(path)
      || parts.some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part)
        || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))
      || !['File','Directory'].includes(entry.type) || (entry.mode & 0o7000) || seen.has(path.toLowerCase())) fail('UpdateArchivePathUnsafe');
    root ??= parts[0];
    if (parts[0] !== root || !/^touba-v[0-9][a-zA-Z0-9.+-]+$/.test(root)) fail('UpdateArchiveLayoutInvalid');
    seen.add(path.toLowerCase()); count++;
    expanded += entry.size;
    if (count > 100000 || !Number.isSafeInteger(expanded) || expanded > MAX_EXPANDED || entry.size < 0) fail('UpdateArchiveLimit');
  }});
  if (!root || !seen.has(`${root}/touba-toolchain/toolchain.json`.toLowerCase())) fail('UpdateArchiveLayoutInvalid');
  mkdirSync(destination, {mode:0o700});
  x({file:archive,cwd:destination,sync:true,strict:true,noChmod:false,noMtime:true,maxMetaEntrySize:65536,
    filter:path=>path.replace(/\/$/,'') === `${root}/touba-toolchain` || path.startsWith(`${root}/touba-toolchain/`)});
  return { root:join(destination,root,'touba-toolchain'), expanded };
}
