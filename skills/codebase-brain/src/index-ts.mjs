// TS/JS adapter: the TypeScript compiler writes the facts, not an LLM.
// Pass 1 records declarations (files, top-level symbols, class members).
// Pass 2 resolves every candidate identifier with the type checker and records a typed edge.
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { existsSync } from 'node:fs';
import { TS_EXT, fileFlags, readHead } from './files.mjs';

const ASSET_EXT = /\.(css|scss|sass|less|svg|png|jpe?g|gif|webp|avif|ico|woff2?|ttf|otf|mp4|webm|mp3|wav|txt|md|html|ya?ml|graphql|gql|wasm)$/i;

export function loadTypeScript(repo) {
  // Prefer the compiler the repo builds with; fall back to the one shipped with the kit.
  try {
    const ts = createRequire(join(repo, 'package.json'))('typescript');
    if (Number(ts.version.split('.')[0]) >= 5) return { ts, from: 'repo' };
  } catch {}
  return { ts: createRequire(import.meta.url)('typescript'), from: 'kit' };
}

// ---------- tsconfig discovery: several configs, one program per distinct resolution setup ----------

function parseConfig(ts, abs) {
  const host = { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} };
  return ts.getParsedCommandLineOfConfigFile(abs, {}, host);
}

function resolutionSignature(o) {
  const { paths, baseUrl, pathsBasePath, moduleResolution, module, jsx, customConditions, rootDirs } = o;
  return JSON.stringify({ paths, baseUrl, pathsBasePath, moduleResolution, module, jsx, customConditions, rootDirs });
}

export function planPrograms(ts, repo, tracked) {
  const configPaths = tracked
    .filter((p) => /(^|\/)(tsconfig[^/]*|jsconfig)\.json$/.test(p))
    .sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));
  const codeFiles = new Set(tracked.filter((p) => TS_EXT.test(p)));
  const owner = new Map();           // rel path -> group
  const groups = new Map();          // signature -> { options, configs, files }
  const configReport = [];

  for (const cfg of configPaths) {
    const parsed = parseConfig(ts, join(repo, cfg));
    if (!parsed) { configReport.push({ config: cfg, files: 0, error: 'unparsable' }); continue; }
    const sig = resolutionSignature(parsed.options);
    if (!groups.has(sig)) groups.set(sig, { options: parsed.options, configs: [], files: [], dir: dirname(cfg) });
    const g = groups.get(sig);
    g.configs.push(cfg);
    let owned = 0;
    for (const abs of parsed.fileNames) {
      const rel = relative(repo, abs).split(sep).join('/');
      if (!codeFiles.has(rel) || owner.has(rel)) continue;
      owner.set(rel, g); g.files.push(rel); owned++;
    }
    configReport.push({ config: cfg, files: parsed.fileNames.length, owned });
  }

  // Files no tsconfig includes (scripts, .mjs tools): index them with the nearest config's settings.
  const orphans = [...codeFiles].filter((p) => !owner.has(p));
  const list = [...groups.values()];
  if (!list.length) list.push({ options: {}, configs: ['(defaults)'], files: [], dir: '.' });
  for (const rel of orphans) {
    const g = list
      .filter((x) => x.dir === '.' || rel.startsWith(x.dir + '/'))
      .sort((a, b) => b.dir.length - a.dir.length)[0] || list[0];
    g.files.push(rel); owner.set(rel, g);
  }
  return { groups: list.filter((g) => g.files.length), configReport, orphans: orphans.length, orphanFiles: orphans.sort() };
}

// ---------- the adapter ----------

export function indexTypeScript({ ts, repo, tracked, db, addNode, addEdge, log }) {
  const plan = planPrograms(ts, repo, tracked);
  const fileId = new Map();                              // rel -> node id
  const declId = new Map();                              // "absFile:pos:kind" -> node id (stable across programs)
  const bindingAlias = new Map();                        // `const { X } = await import('m')`: binding decl key -> X's node id
  const declNames = new Set();
  const stats = { programs: plan.groups.length, configs: plan.configReport, orphans: plan.orphans, orphanFiles: plan.orphanFiles,
    files: 0, symbols: 0, moduleEdges: 0, symbolEdges: 0, externalImports: 0, unresolvedLocal: 0,
    unresolvedExternal: 0, unresolvedBuildOutput: 0, assetImports: 0, resolvedIdentifiers: 0 };
  const unresolvedStmt = db.prepare('INSERT INTO unresolved(path, line, spec, local) VALUES (?, ?, ?, ?)');

  for (const rel of plan.groups.flatMap((g) => g.files)) {
    const abs = join(repo, rel);
    fileId.set(rel, addNode({ key: rel, kind: 'file', name: rel.split('/').pop(), path: rel, line: 1,
      lang: rel.endsWith('x') ? 'tsx' : 'ts', flags: fileFlags(rel, readHead(abs)) }));
    stats.files++;
  }

  for (const [gi, group] of plan.groups.entries()) {
    const t0 = Date.now();
    const sec = () => ((Date.now() - t0) / 1000).toFixed(1);
    log(`  program ${gi + 1}/${plan.groups.length} (${group.configs.join(', ')}): parsing ${group.files.length.toLocaleString()} files…`);
    const options = { ...group.options, allowJs: true, checkJs: false, noEmit: true, skipLibCheck: true,
      incremental: false, composite: false, tsBuildInfoFile: undefined, plugins: undefined };
    const host = ts.createCompilerHost(options, true);
    const program = ts.createProgram({ rootNames: group.files.map((f) => join(repo, f)), options, host });
    const checker = program.getTypeChecker();
    const cache = ts.createModuleResolutionCache(repo, (x) => x, options);
    const owned = group.files.map((rel) => ({ rel, sf: program.getSourceFile(join(repo, rel)) })).filter((x) => x.sf);
    const aliasPrefixes = Object.keys(options.paths || {}).map((p) => p.replace(/\*.*$/, '')).filter(Boolean);
    log(`    parsed in ${sec()}s · now resolving imports and symbol uses`);

    // Pass 1: declarations in every repo file this program loaded (owned or not), so edges into
    // files another program owns still resolve. Keys are stable across programs.
    for (const sf of program.getSourceFiles()) {
      const rel = relative(repo, sf.fileName).split(sep).join('/');
      if (fileId.has(rel)) collectDeclarations(ts, sf, rel, fileId.get(rel), addNode, declId, declNames, stats);
    }

    // Pass 2: module edges + symbol edges
    for (const [i, { rel, sf }] of owned.entries()) {
      if (i && i % 1000 === 0) log(`    ${i.toLocaleString()}/${owned.length.toLocaleString()} files · ${sec()}s`);
      const from = fileId.get(rel);
      const localNames = new Set();
      const seenModule = new Set();

      const moduleEdge = (specNode, kind) => {
        const spec = specNode.text;
        const line = sf.getLineAndCharacterOfPosition(specNode.getStart(sf)).line + 1;
        const res = ts.resolveModuleName(spec, sf.fileName, options, host, cache).resolvedModule;
        if (res) {
          const target = relative(repo, res.resolvedFileName).split(sep).join('/');
          if (res.isExternalLibraryImport || target.startsWith('..') || target.includes('node_modules/')) { stats.externalImports++; return; }
          let to = fileId.get(target);
          if (!to) {                                               // .json, untracked .d.ts: a file node without symbols
            to = addNode({ key: target, kind: 'file', name: target.split('/').pop(), path: target, line: 1,
              lang: target.endsWith('.json') ? 'json' : 'ts', flags: target.endsWith('.d.ts') ? 'declaration' : '' });
            fileId.set(target, to);
          }
          const k = `${to}:${kind}`;
          if (seenModule.has(k)) return;
          seenModule.add(k); addEdge(from, to, kind, rel, line, 0); stats.moduleEdges++;
          return;
        }
        const local = spec.startsWith('.') || spec.startsWith('/') || aliasPrefixes.some((p) => spec.startsWith(p));
        if (local && ASSET_EXT.test(spec)) { stats.assetImports++; return; }
        // local = 2: points into build output (.next/, dist/): not source, so not a coverage gap
        const where = !local ? 0 : /(^|\/)(\.next|dist|build|out)\//.test(spec) ? 2 : 1;
        if (where === 1) stats.unresolvedLocal++; else if (where === 0) stats.unresolvedExternal++; else stats.unresolvedBuildOutput++;
        unresolvedStmt.run(rel, line, spec, where);
      };

      // local binding names of imports (default / renamed imports have names pass 1 never saw)
      for (const st of sf.statements) {
        if (ts.isImportDeclaration(st) && st.importClause) {
          const c = st.importClause;
          if (c.name) localNames.add(c.name.text);
          if (c.namedBindings && ts.isNamedImports(c.namedBindings)) for (const el of c.namedBindings.elements) localNames.add(el.name.text);
          if (c.namedBindings && ts.isNamespaceImport(c.namedBindings)) localNames.add(c.namedBindings.name.text);
        }
      }

      const seenSite = new Set();
      const enclosing = [from];
      const visit = (node) => {
        const own = declId.get(declKey(sf, node));
        const pushed = own !== undefined;
        if (pushed) enclosing.push(own);

        if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
          moduleEdge(node.moduleSpecifier, node.importClause?.isTypeOnly ? 'imports-type' : 'imports');
        } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
          moduleEdge(node.moduleSpecifier, 'reexports');
        } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)
          && ts.isStringLiteral(node.moduleReference.expression)) {
          moduleEdge(node.moduleReference.expression, 'imports');
        } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) {
          moduleEdge(node.argument.literal, 'imports-type');
        } else if (ts.isCallExpression(node) && node.arguments.length >= 1 && ts.isStringLiteralLike(node.arguments[0])) {
          const callee = node.expression;
          if (callee.kind === ts.SyntaxKind.ImportKeyword) moduleEdge(node.arguments[0], 'dynamic-import');
          else if (ts.isIdentifier(callee) && callee.text === 'require') moduleEdge(node.arguments[0], 'imports');
          else if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)
            && /^(vi|jest)$/.test(callee.expression.text) && /^(mock|doMock|importActual|requireActual)$/.test(callee.name.text)) {
            moduleEdge(node.arguments[0], 'mocks');
          }
        } else if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent) && ts.isIdentifier(node.name)
          && importsModule(ts, node.parent.parent)) {
          moduleBinding(node);
        } else if (ts.isIdentifier(node) && (declNames.has(node.text) || localNames.has(node.text))) {
          symbolEdge(node);
        }
        ts.forEachChild(node, visit);
        if (pushed) enclosing.pop();
      };

      // the binding acts like a named import: record it, and let later uses of the local name resolve to the export
      const moduleBinding = (el) => {
        const prop = (el.propertyName && ts.isIdentifier(el.propertyName) ? el.propertyName : el.name).text;
        let sym;
        try {
          sym = checker.getTypeAtLocation(el.parent).getProperty(prop);
          if (sym && sym.flags & ts.SymbolFlags.Alias) sym = checker.getAliasedSymbol(sym);
        } catch { return; }
        for (const decl of sym?.declarations || []) {
          const dst = declId.get(declKey(decl.getSourceFile(), decl));
          if (dst === undefined) continue;
          bindingAlias.set(declKey(sf, el), dst);
          const pos = sf.getLineAndCharacterOfPosition(el.name.getStart(sf));
          addEdge(enclosing[enclosing.length - 1], dst, 'import', rel, pos.line + 1, pos.character + 1);
          stats.symbolEdges++;
          return;
        }
      };

      const symbolEdge = (id) => {
        if (ts.isJsxClosingElement(id.parent)) return;              // the opening tag already counted
        const sym = resolveSymbol(ts, checker, id);
        if (!sym || !sym.declarations) return;
        stats.resolvedIdentifiers++;
        for (const decl of sym.declarations) {
          const k = declKey(decl.getSourceFile(), decl);
          const dst = declId.get(k) ?? bindingAlias.get(k);
          if (dst === undefined) continue;
          if (decl.name === id) continue;                            // the definition itself
          const pos = sf.getLineAndCharacterOfPosition(id.getStart(sf));
          const site = `${dst}:${pos.line}:${pos.character}`;
          if (seenSite.has(site)) continue;
          seenSite.add(site);
          addEdge(enclosing[enclosing.length - 1], dst, siteKind(ts, id), rel, pos.line + 1, pos.character + 1);
          stats.symbolEdges++;
        }
      };

      ts.forEachChild(sf, visit);
    }
    log(`    ${owned.length.toLocaleString()}/${owned.length.toLocaleString()} files · ${sec()}s · done`);
  }
  return stats;
}

// `const { X } = await import('m')` or `= require('m')`: a variable declaration whose initializer loads a module
function importsModule(ts, decl) {
  if (!ts.isVariableDeclaration(decl) || !decl.initializer) return false;
  let e = decl.initializer;
  if (ts.isAwaitExpression(e)) e = e.expression;
  if (!ts.isCallExpression(e)) return false;
  return e.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(e.expression) && e.expression.text === 'require');
}

// Same file text parses to the same pos/kind in every program, so this key joins programs.
const declKey = (sf, n) => `${sf.fileName}:${n.pos}:${n.kind}`;

function resolveSymbol(ts, checker, id) {
  const p = id.parent;
  let sym;
  try {
    if (ts.isShorthandPropertyAssignment(p) && p.name === id) sym = checker.getShorthandAssignmentValueSymbol(p);
    else if (ts.isExportSpecifier(p) && !p.parent.parent.moduleSpecifier) sym = checker.getExportSpecifierLocalTargetSymbol(p);
    else sym = checker.getSymbolAtLocation(id);
    if (sym && sym.flags & ts.SymbolFlags.Alias) sym = checker.getAliasedSymbol(sym);
  } catch { return null; }
  return sym;
}

function siteKind(ts, id) {
  const p = id.parent;
  if (ts.isImportSpecifier(p) || ts.isImportClause(p) || ts.isNamespaceImport(p)) return 'import';
  if (ts.isExportSpecifier(p) || ts.isExportAssignment(p)) return 'export';
  const tagOwner = ts.isPropertyAccessExpression(p) && p.name === id ? p.parent : p;
  if ((ts.isJsxOpeningElement(tagOwner) || ts.isJsxSelfClosingElement(tagOwner)) && tagOwner.tagName === (tagOwner === p ? id : p)) return 'renders';
  const callee = ts.isPropertyAccessExpression(p) && p.name === id ? p : id;
  if (ts.isCallExpression(callee.parent) && callee.parent.expression === callee) return 'call';
  if (ts.isNewExpression(callee.parent) && callee.parent.expression === callee) return 'new';
  if (ts.isTaggedTemplateExpression(callee.parent) && callee.parent.tag === callee) return 'call';
  for (let n = p; n && !ts.isSourceFile(n); n = n.parent) {
    if (ts.isHeritageClause(n)) return n.token === ts.SyntaxKind.ExtendsKeyword ? 'extends' : 'implements';
    if (ts.isBlock(n) || ts.isStatement(n)) break;
  }
  if (ts.isPartOfTypeNode(id)) return 'type';
  return 'ref';
}

const DECL_KIND = (ts, n) => {
  if (ts.isFunctionDeclaration(n)) return 'function';
  if (ts.isClassDeclaration(n)) return 'class';
  if (ts.isInterfaceDeclaration(n)) return 'interface';
  if (ts.isTypeAliasDeclaration(n)) return 'type';
  if (ts.isEnumDeclaration(n)) return 'enum';
  if (ts.isModuleDeclaration(n)) return 'namespace';
  return null;
};

const hasModifier = (n, kind) => !!n.modifiers?.some((m) => m.kind === kind);

function collectDeclarations(ts, sf, rel, fileNode, addNode, declId, declNames, stats) {
  const lineOf = (pos) => sf.getLineAndCharacterOfPosition(pos).line + 1;
  const localExports = new Set();
  for (const st of sf.statements) {
    if (ts.isExportDeclaration(st) && !st.moduleSpecifier && st.exportClause && ts.isNamedExports(st.exportClause))
      for (const el of st.exportClause.elements) localExports.add((el.propertyName || el.name).text);
    if (ts.isExportAssignment(st) && ts.isIdentifier(st.expression)) localExports.add(st.expression.text);
  }
  const byName = new Map();                                        // "Name|kind" -> id: overloads and merged interfaces share a node
  const add = (n, name, kind, parent, exported, keyName = name) => {
    const k = declKey(sf, n);
    if (declId.has(k)) return declId.get(k);                       // same file seen by an earlier program
    let id = byName.get(`${keyName}|${kind}`);
    if (id === undefined) {
      const clash = [...byName.keys()].some((x) => x.startsWith(`${keyName}|`));   // `const X` + `type X`
      id = addNode({ key: `${rel}#${keyName}${clash ? `@${kind}` : ''}`, kind, name, path: rel, line: lineOf(n.getStart(sf)),
        end_line: lineOf(n.end), parent, exported: exported ? 1 : 0, lang: 'ts' });
      byName.set(`${keyName}|${kind}`, id); stats.symbols++;
    }
    declId.set(k, id); declNames.add(name);
    return id;
  };

  for (const st of sf.statements) {
    const kind = DECL_KIND(ts, st);
    if (kind) {
      const name = st.name ? st.name.text : 'default';
      const exported = hasModifier(st, ts.SyntaxKind.ExportKeyword) || localExports.has(name);
      const id = add(st, name, kind, fileNode, exported);
      if (ts.isClassDeclaration(st)) {
        for (const m of st.members) {
          if (!m.name || !(ts.isIdentifier(m.name) || ts.isPrivateIdentifier(m.name))) continue;
          if (!(ts.isMethodDeclaration(m) || ts.isPropertyDeclaration(m) || ts.isGetAccessor(m) || ts.isSetAccessor(m))) continue;
          add(m, m.name.text, ts.isPropertyDeclaration(m) ? 'property' : 'method', id, exported, `${name}.${m.name.text}`);
        }
      }
    } else if (ts.isVariableStatement(st)) {
      const exported = hasModifier(st, ts.SyntaxKind.ExportKeyword);
      for (const d of st.declarationList.declarations) {
        if (!ts.isIdentifier(d.name)) continue;
        const init = d.initializer;
        const fn = init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init));
        add(d, d.name.text, fn ? 'function' : 'variable', fileNode, exported || localExports.has(d.name.text));
      }
    } else if (ts.isExportAssignment(st) && !ts.isIdentifier(st.expression)) {
      add(st, 'default', 'variable', fileNode, true);
    }
  }
}
