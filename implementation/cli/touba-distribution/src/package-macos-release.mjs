#!/usr/bin/env node
import { pathToFileURL } from "node:url";

import { packageRelease } from "./package-release.mjs";

const releasePlatform = "darwin-arm64";

export function packageMacosRelease(options = {}) {
  return packageRelease({
    ...options,
    platform: releasePlatform,
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    packageMacosRelease();
  } catch (error) {
    process.stderr.write(`touba macOS release package: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
