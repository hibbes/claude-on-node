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
  const assets = [];         // [['/$bunfs/root/X', absolute path], ...] for non-module entries
  const byAbs = new Map();   // absolute extracted path -> loader name (rewritten literals land here)
  const virtOfAbs = new Map(); // absolute extracted path -> /$bunfs/root/ name (require(esm) needs the virtual form)
  // Manifests written before 2.1.246 carry no loader field; derive the same
  // behavior they got: .node addons are napi, other non-JS entries are plain
  // files, everything else is a module.
  const loaderOf = (m) => m.loader !== undefined ? m.loader
    : (m.path.endsWith('.node') ? 'napi' : (m.js ? 'js' : 'file'));
  for (const m of index.modules) {
    if (typeof m.path !== 'string' || typeof m.file !== 'string') {
      throw new Error(`${indexPath}: malformed module entry ${JSON.stringify(m)}`);
    }
    const abs = path.join(modulesDir, m.file);
    files.set(m.path, abs);
    const ld = loaderOf(m);
    byAbs.set(abs, ld);
    virtOfAbs.set(abs, m.path);
    if (ld !== 'js') assets.push([m.path, abs]);
  }
  if (!files.has(index.entry)) throw new Error(`entry ${index.entry} is not in the manifest`);

  // Bun's require applies the entry's loader; mimic each semantics (2.1.246
  // is where this first bites: prompt .md files are require()d as TEXT, and
  // routing them into Node's require dies in a SyntaxError at startup).
  // Rewritten string literals arrive here as absolute extracted paths, direct
  // graph references as /$bunfs/root/ names; both resolve to the same entry.
  const jsProxies = new Map();
  const staticExports = new Map();
  const bunfsRequire = (spec) => {
    let abs = null;
    if (typeof spec === 'string') {
      if (spec.startsWith(BUNFS)) {
        abs = files.get(spec);
        if (!abs) throw new Error(`[modulegraph] ${spec} is not in the module graph`);
      } else if (byAbs.has(spec)) {
        abs = spec;
      }
    }
    if (abs !== null) {
      const ld = byAbs.get(abs);
      switch (ld) {
        case 'text': return fs.readFileSync(abs, 'utf8');
        case 'file': return abs;
        case 'napi': return bundleRequire(abs);
        case 'js': case undefined: {
          // Bun's require of a graph ES module returns its namespace,
          // evaluating the module synchronously unless it sits in an active
          // import cycle; then Bun hands out the not-yet-finished namespace
          // whose var-bound exports read undefined until assigned. Node's
          // require(esm) instead throws ERR_REQUIRE_CYCLE_MODULE, and
          // 2.1.250 hits that in several shapes (top-level requires,
          // immediate property reads, cycles reached transitively through a
          // deferred require's subgraph). Two approaches are documented as
          // measured-wrong: hoisting the literals into static imports
          // reorders evaluation (breaks the esbuild lazy-init pattern), and
          // a proxy covering only the direct-cycle case still dies when the
          // deferred require links a subgraph touching an active cycle.
          //
          // So the js case always returns ONE stable lazy namespace proxy
          // per module: evaluation happens on first property access (same
          // sync semantics, shifted to first use); an access while a cycle
          // is open yields undefined WITHOUT memoizing the failure, so later
          // reads heal, exactly the live-binding behavior var-bound exports
          // have under Bun; and the namespace SHAPE (ownKeys/has) comes
          // statically from the source's export clause, so re-export
          // copying works even mid-cycle.
          const virt = virtOfAbs.get(abs);
          let proxy = jsProxies.get(virt);
          if (proxy !== undefined) return proxy;
          let ns = null;
          const tryResolve = () => {
            if (ns !== null) return ns;
            try { return (ns = bundleRequire(virt)); }
            catch (err) {
              if (err && err.code === 'ERR_REQUIRE_CYCLE_MODULE') return null;
              throw err;
            }
          };
          const staticKeys = () => {
            let keys = staticExports.get(virt);
            if (keys === undefined) {
              const src = fs.readFileSync(abs, 'utf8');
              keys = [];
              const re = /export\{([^}]*)\}/g;
              let m; let last = null;
              while ((m = re.exec(src)) !== null) last = m[1];
              if (last !== null) {
                for (const part of last.split(',')) {
                  const name = part.trim().split(/\s+as\s+/).pop();
                  if (name) keys.push(name.trim());
                }
              }
              if (/export\s+default\b/.test(src)) keys.push('default');
              staticExports.set(virt, keys);
            }
            return keys;
          };
          proxy = new Proxy({ __proto__: null }, {
            get: (_, k) => {
              if (k === Symbol.toStringTag) return 'Module';
              const r = tryResolve();
              return r === null ? undefined : r[k];
            },
            has: (_, k) => {
              const r = tryResolve();
              return r === null ? staticKeys().includes(k) : (k in r);
            },
            ownKeys: () => {
              const r = tryResolve();
              return r === null ? staticKeys().slice() : Reflect.ownKeys(r);
            },
            getOwnPropertyDescriptor: (_, k) => {
              const r = tryResolve();
              if (r === null) {
                return staticKeys().includes(k)
                  ? { configurable: true, enumerable: true, value: undefined }
                  : undefined;
              }
              const d = Reflect.getOwnPropertyDescriptor(r, k);
              if (d) d.configurable = true;
              return d;
            },
          });
          jsProxies.set(virt, proxy);
          return proxy;
        }
        default:
          throw new Error(`[modulegraph] unknown loader ${JSON.stringify(ld)} for ${spec}`);
      }
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

// --- require(esm) mid-cycle tolerance -----------------------------------------
// 2.1.258 captures VALUES at module top level in the tool registry chunk:
//   wLn = import.meta.require("/$bunfs/root/chunk-<artifact>.js").ArtifactTool
// while that chunk statically imports the registry chunk back (same shape
// for Workflow, Monitor, ProposeSkills and EndConversation). Bun's
// require(esm) evaluates the target right there, against the registry's
// still-in-flight namespace (ordinary cyclic-evaluation semantics), so the
// tool object exists. Node refuses to even LINK a synchronous require graph
// that touches a module currently evaluating (#checkCachedJobForRequireESM
// in internal/modules/esm/loader: "Cannot import Module X in a cycle"), the
// lazy proxy above hands out undefined, and a captured undefined never heals:
// five tools vanish from the registry and startup dies with "Cannot read
// properties of undefined (reading 'name')".
//
// The refusal is Node policy, not a V8 limit: handed the in-flight job as the
// dependency, V8 links and evaluates the required module against the partial
// namespace exactly as it does inside a static-import cycle (measured:
// bindings the in-flight module assigned before the require are visible,
// later ones read undefined, same as under Bun). The private check cannot be
// reached, so the public getOrCreateModuleJob() is wrapped: on precisely that
// error the cached job is returned instead. "Cannot require() ES Module X in
// a cycle" (the target ITSELF is evaluating) keeps throwing, the proxy above
// covers it. The loader class is only reachable with --expose-internals,
// which NODE_OPTIONS refuses, so launcher.js re-executes itself with the
// flag; without it this returns false and the pre-2.1.258 behaviour stays.
function installRequireCycleTolerance() {
  let esm;
  try { esm = require('internal/modules/esm/loader'); } catch (_) { return false; }
  const proto = Object.getPrototypeOf(esm.getOrInitializeCascadedLoader());
  const orig = proto.getOrCreateModuleJob;
  if (typeof orig !== 'function') return false;
  if (orig.cycleTolerant === true) return true;
  const patched = function getOrCreateModuleJob(parentURL, request, requestType) {
    try {
      return orig.call(this, parentURL, request, requestType);
    } catch (err) {
      if (!(err && err.code === 'ERR_REQUIRE_CYCLE_MODULE' && /^Cannot import Module /.test(err.message))) throw err;
      const { url } = this.resolveSync(parentURL, request);
      const type = request && request.attributes ? request.attributes.type : undefined;
      const job = this.loadCache.get(url, type) || this.loadCache.get(url, undefined) || this.loadCache.get(url, '');
      if (!job) throw err;
      return job;
    }
  };
  patched.cycleTolerant = true;
  proto.getOrCreateModuleJob = patched;
  return true;
}

module.exports = { createModuleGraphLoader, installRequireCycleTolerance, toSafe, BUNFS, BUNFS_URL, INDEX_FORMAT };
