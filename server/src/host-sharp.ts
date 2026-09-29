import { createRequire } from 'node:module';
import * as path from 'node:path';
import type sharpModule from 'sharp';

type SharpFactory = typeof sharpModule;

let cached: SharpFactory | undefined;

/**
 * Loads `sharp` from the host application rather than from beside this bundle.
 *
 * `sharp` is a peer dependency, so the copy that matters is the one `@strapi/upload` already loaded
 * to build thumbnails. Importing it normally resolves relative to this file instead, and when the
 * plugin is installed from a local folder that is a different copy: yarn's `file:` fetcher copies
 * the plugin's own `node_modules` in wholesale, with no way to exclude it. Two libvips instances in
 * one process then fail on any conversion with "VipsInterpretation ... space not set", because an
 * enum value from one is meaningless to the other.
 *
 * Several resolution routes are tried because `sharp` is a dependency of `@strapi/upload`, not of
 * the application. A hoisted npm or yarn install lifts it to the app's own `node_modules`, so a
 * direct lookup finds it; a strict pnpm or Yarn PnP layout does not, and the only way through is to
 * hop via the package that actually depends on it.
 */

const CANDIDATE_CHAINS: string[][] = [
  [],
  ['@strapi/upload'],
  ['@strapi/strapi', '@strapi/upload'],
];

/** Walk a chain of packages, then resolve `sharp` from wherever the last one sits. */
function resolveThrough(fromDir: string, chain: string[]): { sharp: SharpFactory; from: string } | undefined {
  try {
    let req = createRequire(path.join(fromDir, 'package.json'));
    for (const pkg of chain) {
      req = createRequire(req.resolve(`${pkg}/package.json`));
    }
    return { sharp: req('sharp') as SharpFactory, from: req.resolve('sharp') };
  } catch {
    return undefined;
  }
}

function candidateRoots(strapi?: { dirs?: { app?: { root?: unknown } } }): string[] {
  const roots: string[] = [];
  const appRoot = strapi?.dirs?.app?.root;
  // Preferred over cwd, which is only the app root when Strapi was started from there — process
  // managers and container entrypoints regularly start it from somewhere else.
  if (typeof appRoot === 'string' && appRoot.length > 0) roots.push(appRoot);
  roots.push(process.cwd());
  return [...new Set(roots)];
}

export function getSharp(strapi?: { dirs?: { app?: { root?: unknown } }; log?: { debug?: (m: string) => void } }): SharpFactory {
  if (cached) return cached;

  for (const root of candidateRoots(strapi)) {
    for (const chain of CANDIDATE_CHAINS) {
      const found = resolveThrough(root, chain);
      if (!found) continue;
      cached = found.sharp;
      strapi?.log?.debug?.(`[strapi-media-webp-convertor] using sharp from ${found.from}`);
      return cached;
    }
  }

  // Deliberately not falling back to the copy beside this bundle: that is the copy whose presence
  // causes the libvips mismatch, so using it would turn a clear failure into an intermittent one.
  throw new Error(
    "Could not load 'sharp' from the Strapi application. Add sharp to your app's dependencies " +
      '(npm install sharp) and restart. This is expected on pnpm and Yarn PnP layouts, where a ' +
      "transitive dependency of @strapi/upload is not reachable from the application's node_modules."
  );
}
