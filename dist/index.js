#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

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

function shellSplit(input) {
  const args = [];
  let current = '';
  let quote = null;
  let escaping = false;

  for (const ch of String(input || '')) {
    if (escaping) {
      current += ch;
      escaping = false;
      continue;
    }
    if (ch === '\\') {
      escaping = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current) {
        args.push(current);
        current = '';
      }
      continue;
    }
    current += ch;
  }

  if (escaping) current += '\\';
  if (current) args.push(current);
  return args;
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

const includePatterns = parseList(getInput('files', '**/*.md\n**/*.markdown\n**/*.mmd\n**/*.mermaid'));
const ignorePatterns = parseList(getInput('ignore', '.git/**\nnode_modules/**'));
const mermaidCliVersion = getInput('mermaid-cli-version', 'latest');
const failFast = /^true$/i.test(getInput('fail-fast', 'false'));
const configFile = getInput('config-file', '');
const userPuppeteerConfigFile = getInput('puppeteer-config-file', '');
const outputDirInput = getInput('output-dir', '');
const extraArgs = shellSplit(getInput('mmdc-args', ''));

const isIncluded = makeMatcher(includePatterns);
const isIgnored = makeMatcher(ignorePatterns);
const files = walkFiles(workspace, isIgnored).filter((file) => isIncluded(file)).sort();

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'check-mmdjs-action-'));
const defaultPuppeteerConfigFile = path.join(tempRoot, 'puppeteer-config.json');
fs.writeFileSync(defaultPuppeteerConfigFile, JSON.stringify({ args: ['--no-sandbox', '--disable-setuid-sandbox'] }, null, 2));
const puppeteerConfigFile = userPuppeteerConfigFile || defaultPuppeteerConfigFile;
const outputRoot = outputDirInput ? path.resolve(workspace, outputDirInput) : tempRoot;
ensureDir(outputRoot);

let diagrams = 0;
let failures = 0;
let checkedFiles = 0;
const packageSpec = `@mermaid-js/mermaid-cli@${mermaidCliVersion}`;
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';

group('Scanning Markdown files for Mermaid diagrams');
console.log(`Workspace: ${workspace}`);
console.log(`Include patterns: ${includePatterns.join(', ')}`);
console.log(`Ignore patterns: ${ignorePatterns.join(', ')}`);
console.log(`Files matched: ${files.length}`);
endgroup();

for (const file of files) {
  const content = fs.readFileSync(path.join(workspace, file), 'utf8');
  const extension = path.extname(file).toLowerCase();
  const blocks = ['.mmd', '.mermaid'].includes(extension)
    ? [{ startLine: 1, endLine: content.split(/\r?\n/).length, content }]
    : extractMermaidBlocks(content);
  if (blocks.length === 0) continue;
  checkedFiles += 1;

  for (let blockIndex = 0; blockIndex < blocks.length; blockIndex += 1) {
    const block = blocks[blockIndex];
    diagrams += 1;
    const base = `${sanitizeFileName(file)}_L${block.startLine}_${blockIndex + 1}`;
    const inputFile = path.join(outputRoot, `${base}.mmd`);
    const outputFile = path.join(outputRoot, `${base}.svg`);
    fs.writeFileSync(inputFile, block.content.endsWith('\n') ? block.content : `${block.content}\n`);

    const args = [
      '--yes',
      '--package',
      packageSpec,
      'mmdc',
      '--input',
      inputFile,
      '--output',
      outputFile,
      '--puppeteerConfigFile',
      path.resolve(workspace, puppeteerConfigFile),
    ];
    if (configFile) args.push('--configFile', path.resolve(workspace, configFile));
    args.push(...extraArgs);

    const label = `${file}:${block.startLine}`;
    console.log(`Checking ${label}`);
    const result = spawnSync(npx, args, { cwd: workspace, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
    if (result.status !== 0) {
      failures += 1;
      const output = [result.stdout, result.stderr].filter(Boolean).join('\n').trim() || `mmdc exited with status ${result.status}`;
      errorAnnotation(file, block.startLine, 'Invalid Mermaid diagram', output);
      if (failFast) break;
    }
  }
  if (failFast && failures > 0) break;
}

if (diagrams === 0) {
  notice(`No Mermaid diagrams found in ${files.length} file(s).`);
  process.exit(0);
}

if (outputDirInput) {
  notice(`Extracted Mermaid sources and rendered SVGs were written to ${path.relative(workspace, outputRoot) || outputRoot}.`);
}

if (failures > 0) {
  console.error(`Found ${failures} invalid Mermaid diagram(s) out of ${diagrams} checked in ${checkedFiles} file(s).`);
  process.exit(1);
}

console.log(`All ${diagrams} Mermaid diagram(s) compiled successfully from ${checkedFiles} file(s).`);
