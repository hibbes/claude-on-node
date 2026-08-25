'use strict';
// Node loader for the Bun standalone module graph that Claude Code ships since
// v2.1.242/243: ~1400 ESM modules addressed as /$bunfs/root/<name>, extracted
// by extract-modulegraph.py into a directory with an _index.json manifest.
//
// The graph is served through module.registerHooks() (sync hooks):
//   resolve  /$bunfs/root/X          -> file:///$bunfs/root/X   (virtual)
//            bun:*                   -> throws, so the bundle's own try/catch
//                                       fallbacks around bun:jsc / bun:ffi run
//            bare specifier from a   -> the real file under this repo's
//            graph module               node_modules (the bundle's externals:
//                                       react, zod, ws, @anthropic-ai/sdk, ...)
//   load     file:///$bunfs/root/X   -> the extracted source, after the same
//                                       rewrites launcher.js applied to the
//                                       old single bundle (Bun.X -> __bunShim.X)
//                                       plus two graph-specific ones below.
//
// Module URLs deliberately keep the file: scheme and the /$bunfs/root/ path:
// the bundle calls fileURLToPath(import.meta.url) and joins import.meta.dirname
// with asset names, both of which must yield exactly what they yield under Bun.
//
// Two rewrites exist only because Node has no Bun-flavoured import.meta:
//   import.meta.require  -> globalThis.__bunfsRequire  (a CJS require that
//                           understands /$bunfs/root/ paths; the bundle uses it
//                           to load the three N-API addons)
//   "/$bunfs/root/<asset>" string literals -> the extracted file's real path,
//                           for the non-module entries (*.asset, *.node, the
//                           vendored *.min.js): the bundle readFile()s those
//                           through the real fs, which knows nothing of the
//                           virtual root Bun serves them from.
const fs = require('fs');
const path = require('path');
const Module = require('module');
const { pathToFileURL } = require('url');

const BUNFS = '/$bunfs/root/';
const BUNFS_URL = 'file:///$bunfs/root/';
const INDEX_FORMAT = 1;

// Module names may contain '/', the extractor flattens them to '__'.
const toSafe = (rel) => rel.replace(/\//g, '__');

function createModuleGraphLoader({ modulesDir, bunShimRegex, bundleRequire }) {
  if (!(bunShimRegex instanceof RegExp) || !bunShimRegex.global) {
    throw new Error('bunShimRegex must be a global RegExp');
  }
  if (typeof bundleRequire !== 'function') throw new Error('bundleRequire must be a function');
  const indexPath = path.join(modulesDir, '_index.json');
  let index;
  try {
    index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  } catch (err) {
    throw new Error(`cannot read ${indexPath}: ${err.message}`);
  }
  if (index.format !== INDEX_FORMAT || typeof index.entry !== 'string' || !Array.isArray(index.modules)) {
    throw new Error(`${indexPath} is not a format-${INDEX_FORMAT} module graph manifest`);
  }
  if (!index.entry.startsWith(BUNFS)) throw new Error(`entry ${index.entry} is not under ${BUNFS}`);

  const files = new Map();   // '/$bunfs/root/X' -> absolute extracted path
  const assets = [];         // [['/$bunfs/root/X', absolute path], ...] for non-JS entries
  for (const m of index.modules) {
    if (typeof m.path !== 'string' || typeof m.file !== 'string') {
      throw new Error(`${indexPath}: malformed module entry ${JSON.stringify(m)}`);
    }
    const abs = path.join(modulesDir, m.file);
    files.set(m.path, abs);
    if (!m.js) assets.push([m.path, abs]);
  }
  if (!files.has(index.entry)) throw new Error(`entry ${index.entry} is not in the manifest`);

  const bunfsRequire = (spec) => {
    if (typeof spec === 'string' && spec.startsWith(BUNFS)) {
      const abs = files.get(spec);
      if (!abs) throw new Error(`[modulegraph] ${spec} is not in the module graph`);
      return bundleRequire(abs);
    }
    return bundleRequire(spec);
  };

  const rewrite = (source) => {
    let s = source.replace(bunShimRegex, '__bunShim.$1');
    s = s.replace(/import\.meta\.require\b/g, 'globalThis.__bunfsRequire');
    for (const [virt, abs] of assets) {
      if (s.includes(virt)) s = s.split(virt).join(abs);
    }
    return s;
  };

  function resolve(specifier, context, nextResolve) {
    if (specifier.startsWith(BUNFS)) {
      return { url: 'file://' + specifier, shortCircuit: true };
    }
    if (specifier.startsWith(BUNFS_URL)) {
      return { url: specifier, shortCircuit: true };
    }
    if (specifier.startsWith('bun:')) {
      // Both call sites in the bundle (bun:jsc heap stats, bun:ffi dlopen) sit
      // inside try/catch and degrade when the import fails; mirror Bun-less
      // reality instead of inventing a stub they would then call into.
      const err = new Error(`Cannot find module '${specifier}' (Bun builtin, not available under Node)`);
      err.code = 'ERR_MODULE_NOT_FOUND';
      throw err;
    }
    const parent = context && context.parentURL;
    if (parent && parent.startsWith(BUNFS_URL)) {
      if (Module.isBuiltin(specifier)) {
        return { url: specifier.startsWith('node:') ? specifier : 'node:' + specifier, shortCircuit: true };
      }
      if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('file:')) {
        // The graph addresses everything by absolute /$bunfs/root/ name; a
        // relative import from a graph module would be a format change.
        throw new Error(`[modulegraph] unexpected relative import ${specifier} from ${parent}`);
      }
      return { url: pathToFileURL(bundleRequire.resolve(specifier)).href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  }

  function load(url, context, nextLoad) {
    if (!url.startsWith(BUNFS_URL)) return nextLoad(url, context);
    const virt = BUNFS + decodeURIComponent(url.slice(BUNFS_URL.length));
    const abs = files.get(virt);
    if (!abs) throw new Error(`[modulegraph] ${virt} is not in the module graph (${indexPath})`);
    if (virt.endsWith('.node')) {
      throw new Error(`[modulegraph] ${virt} is a native addon; the bundle loads those via import.meta.require, not import`);
    }
    return { format: 'module', shortCircuit: true, source: rewrite(fs.readFileSync(abs, 'utf8')) };
  }

  return {
    index,
    entryUrl: 'file://' + index.entry,
    hooks: { resolve, load },
    bunfsRequire,
    rewrite,
    files,
  };
}

module.exports = { createModuleGraphLoader, toSafe, BUNFS, BUNFS_URL, INDEX_FORMAT };
