#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { pathToFileURL } = require('url');

const workspace = process.env.GITHUB_WORKSPACE || process.cwd();
process.chdir(workspace);

function getInput(name, fallback = '') {
  const names = [
    `INPUT_${name.replace(/ /g, '_').toUpperCase()}`,
    `INPUT_${name.replace(/ /g, '_').replace(/-/g, '_').toUpperCase()}`,
  ];
  const value = names.map((envName) => process.env[envName]).find((candidate) => candidate !== undefined && candidate !== '');
  return value === undefined ? fallback : value.trim();
}

function parseList(value) {
  return String(value || '')
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizePath(value) {
  return value.replace(/\\/g, '/').replace(/^\.\//, '');
}

function escapeRegex(value) {
  return value.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
}

function globToRegExp(glob) {
  glob = normalizePath(glob);
  let out = '^';
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i];
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        i += 1;
        if (glob[i + 1] === '/') {
          i += 1;
          out += '(?:.*/)?';
        } else {
          out += '.*';
        }
      } else {
        out += '[^/]*';
      }
    } else if (ch === '?') {
      out += '[^/]';
    } else {
      out += escapeRegex(ch);
    }
  }
  out += '$';
  return new RegExp(out);
}

function makeMatcher(patterns) {
  const regexps = patterns.map(globToRegExp);
  return (relPath) => {
    relPath = normalizePath(relPath);
    return regexps.some((regexp) => regexp.test(relPath));
  };
}

function walkFiles(dir, isIgnored, found = []) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const absolute = path.join(dir, entry.name);
    const relative = normalizePath(path.relative(workspace, absolute));
    if (!relative) continue;

    if (entry.isDirectory()) {
      if (isIgnored(relative) || isIgnored(`${relative}/`)) continue;
      walkFiles(absolute, isIgnored, found);
    } else if (entry.isFile()) {
      if (!isIgnored(relative)) found.push(relative);
    }
  }
  return found;
}

function languageFromInfo(info) {
  let token = String(info || '').trim().split(/\s+/)[0] || '';
  token = token.replace(/^\{/, '').replace(/\}$/, '').replace(/^\./, '').toLowerCase();
  return token;
}

function extractMermaidBlocks(markdown) {
  const lines = markdown.split(/\r?\n/);
  const blocks = [];
  let fence = null;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!fence) {
      const match = line.match(/^( {0,3})(`{3,}|~{3,})\s*([^`~]*)$/);
      if (!match) continue;
      const marker = match[2];
      const language = languageFromInfo(match[3]);
      fence = {
        char: marker[0],
        length: marker.length,
        isMermaid: ['mermaid', 'mmd', 'mermaidjs'].includes(language),
        startLine: i + 1,
        content: [],
      };
      continue;
    }

    const closePattern = new RegExp(`^ {0,3}${fence.char}{${fence.length},}\\s*$`);
    if (closePattern.test(line)) {
      if (fence.isMermaid) {
        blocks.push({ startLine: fence.startLine, endLine: i + 1, content: fence.content.join('\n') });
      }
      fence = null;
      continue;
    }

    if (fence.isMermaid) fence.content.push(line);
  }

  return blocks;
}

function commandValue(value) {
  return String(value || '')
    .replace(/%/g, '%25')
    .replace(/\r/g, '%0D')
    .replace(/\n/g, '%0A');
}

function commandProperty(value) {
  return commandValue(value).replace(/:/g, '%3A').replace(/,/g, '%2C');
}

function errorAnnotation(file, line, title, message) {
  console.log(`::error file=${commandProperty(file)},line=${commandProperty(String(line))},title=${commandProperty(title)}::${commandValue(message)}`);
}

function workflowError(title, message) {
  console.log(`::error title=${commandProperty(title)}::${commandValue(message)}`);
}

function notice(message) {
  console.log(`::notice::${commandValue(message)}`);
}

function group(title) {
  console.log(`::group::${commandValue(title)}`);
}

function endgroup() {
  console.log('::endgroup::');
}

function sanitizeFileName(value) {
  return normalizePath(value).replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+|_+$/g, '');
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function readJsonFile(file) {
  const absolute = path.resolve(workspace, file);
  try {
    return JSON.parse(fs.readFileSync(absolute, 'utf8'));
  } catch (error) {
    workflowError('Invalid Mermaid config file', `${file}: ${error.message}`);
    process.exit(2);
  }
}

function installMermaid(version, installRoot) {
  ensureDir(installRoot);
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const packageSpec = `mermaid@${version}`;

  group(`Installing ${packageSpec}`);
  const result = spawnSync(
    npm,
    ['install', '--no-audit', '--no-fund', '--omit=dev', '--prefix', installRoot, packageSpec],
    { cwd: workspace, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 }
  );
  const installOutput = [result.stdout, result.stderr].filter(Boolean).join('\n');
  if (installOutput) process.stdout.write(installOutput.endsWith('\n') ? installOutput : `${installOutput}\n`);
  endgroup();

  if (result.status !== 0) {
    workflowError(
      'Mermaid dependency installation failed',
      `Unable to install ${packageSpec}. This is a runner/dependency environment error, not an invalid diagram. npm exited with status ${result.status}.`
    );
    process.exit(2);
  }

  const mermaidModule = path.join(installRoot, 'node_modules', 'mermaid', 'dist', 'mermaid.esm.mjs');
  if (!fs.existsSync(mermaidModule)) {
    workflowError(
      'Mermaid parser API unavailable',
      `Installed ${packageSpec}, but ${path.relative(workspace, mermaidModule)} was not found. This is a runner/dependency environment error, not an invalid diagram.`
    );
    process.exit(2);
  }
  return mermaidModule;
}

async function loadMermaid(version, tempRoot, configFile) {
  const modulePath = installMermaid(version, path.join(tempRoot, 'mermaid-package'));
  const imported = await import(pathToFileURL(modulePath).href);
  const mermaid = imported.default || imported;
  const config = configFile ? readJsonFile(configFile) : {};
  mermaid.initialize({ startOnLoad: false, ...config });
  return mermaid;
}

function formatParseError(error) {
  const parts = [];
  if (error && error.message) parts.push(error.message);
  else parts.push(String(error));

  if (error && error.hash) {
    const hash = error.hash;
    const location = hash.loc || hash.location;
    if (location && typeof location === 'object') {
      const firstLine = location.first_line ?? location.start?.line;
      const firstColumn = location.first_column ?? location.start?.column;
      if (firstLine !== undefined || firstColumn !== undefined) {
        parts.push(`Parser location: line ${Number(firstLine ?? 0) + 1}, column ${Number(firstColumn ?? 0) + 1}`);
      }
    }
    if (hash.expected) parts.push(`Expected: ${Array.isArray(hash.expected) ? hash.expected.join(', ') : hash.expected}`);
    if (hash.token) parts.push(`Got: ${hash.token}`);
  }

  return parts.filter(Boolean).join('\n');
}

async function main() {
  const includePatterns = parseList(getInput('files', '**/*.md\n**/*.markdown\n**/*.mmd\n**/*.mermaid'));
  const ignorePatterns = parseList(getInput('ignore', '.git/**\nnode_modules/**'));
  const mermaidVersion = getInput('mermaid-version', '') || getInput('mermaid-cli-version', '') || 'latest';
  const failFast = /^true$/i.test(getInput('fail-fast', 'false'));
  const configFile = getInput('config-file', '');
  const outputDirInput = getInput('output-dir', '');

  const isIncluded = makeMatcher(includePatterns);
  const isIgnored = makeMatcher(ignorePatterns);
  const files = walkFiles(workspace, isIgnored).filter((file) => isIncluded(file)).sort();

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'check-mmdjs-action-'));
  const outputRoot = outputDirInput ? path.resolve(workspace, outputDirInput) : tempRoot;
  ensureDir(outputRoot);

  group('Scanning files for Mermaid diagrams');
  console.log(`Workspace: ${workspace}`);
  console.log(`Include patterns: ${includePatterns.join(', ')}`);
  console.log(`Ignore patterns: ${ignorePatterns.join(', ')}`);
  console.log(`Files matched: ${files.length}`);
  console.log(`Validation mode: Mermaid parser API syntax check (no rendering, Puppeteer, or Chrome)`);
  endgroup();

  const checks = [];
  let checkedFiles = 0;
  for (const file of files) {
    const content = fs.readFileSync(path.join(workspace, file), 'utf8');
    const extension = path.extname(file).toLowerCase();
    const blocks = ['.mmd', '.mermaid'].includes(extension)
      ? [{ startLine: 1, endLine: content.split(/\r?\n/).length, content }]
      : extractMermaidBlocks(content);
    if (blocks.length === 0) continue;
    checkedFiles += 1;

    for (let blockIndex = 0; blockIndex < blocks.length; blockIndex += 1) {
      checks.push({ file, blockIndex, block: blocks[blockIndex] });
    }
  }

  if (checks.length === 0) {
    notice(`No Mermaid diagrams found in ${files.length} file(s).`);
    return;
  }

  const mermaid = await loadMermaid(mermaidVersion, tempRoot, configFile);

  let failures = 0;
  for (const check of checks) {
    const { file, blockIndex, block } = check;
    const base = `${sanitizeFileName(file)}_L${block.startLine}_${blockIndex + 1}`;
    const inputFile = path.join(outputRoot, `${base}.mmd`);
    fs.writeFileSync(inputFile, block.content.endsWith('\n') ? block.content : `${block.content}\n`);

    const label = `${file}:${block.startLine}`;
    console.log(`Checking ${label}`);
    try {
      await Promise.resolve(mermaid.parse(block.content, { suppressErrors: false }));
    } catch (error) {
      failures += 1;
      errorAnnotation(file, block.startLine, 'Invalid Mermaid syntax', formatParseError(error));
      if (failFast) break;
    }
  }

  if (outputDirInput) {
    notice(`Extracted Mermaid sources were written to ${path.relative(workspace, outputRoot) || outputRoot}.`);
  }

  if (failures > 0) {
    console.error(`Found ${failures} invalid Mermaid diagram(s) out of ${checks.length} checked in ${checkedFiles} file(s).`);
    process.exit(1);
  }

  console.log(`All ${checks.length} Mermaid diagram(s) passed syntax validation from ${checkedFiles} file(s).`);
}

main().catch((error) => {
  workflowError(
    'Mermaid parser failed',
    `${error && error.stack ? error.stack : error}\nThis is a runner/dependency environment error, not an invalid diagram.`
  );
  process.exit(2);
});
