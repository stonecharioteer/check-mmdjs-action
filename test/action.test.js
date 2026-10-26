'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const action = path.resolve(__dirname, '../dist/index.js');
const mermaidVersion = process.env.TEST_MERMAID_VERSION || 'latest';

function runAction(t, files, inputs = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'check-mmdjs-test-'));
  const workspace = path.join(root, 'workspace');
  const tempDir = path.join(root, 'tmp');
  fs.mkdirSync(workspace);
  fs.mkdirSync(tempDir);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(workspace, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }

  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (name.startsWith('INPUT_')) delete env[name];
  }
  Object.assign(env, {
    GITHUB_WORKSPACE: workspace,
    TMPDIR: tempDir,
    TMP: tempDir,
    TEMP: tempDir,
    INPUT_MERMAID_VERSION: mermaidVersion,
    ...inputs,
  });
  const result = spawnSync(process.execPath, [action], {
    cwd: workspace,
    env,
    encoding: 'utf8',
    timeout: 120_000,
  });
  assert.ifError(result.error);
  const output = `${result.stdout}\n${result.stderr}`;
  const parserTempDirs = fs.readdirSync(tempDir).filter((name) => name.startsWith('check-mmdjs-action-'));
  assert.deepEqual(parserTempDirs, [], `Temporary parser files remain after exit ${result.status}:\n${output}`);
  return { status: result.status, output, workspace };
}

// Inline theme values need DOMPurify even when Mermaid only parses the diagram.
// This is the failure path from midinotes/actions/runs/40313889025.
const themedDiagram = [
  '```mermaid',
  '%%{init: {"theme": "base", "flowchart": {"htmlLabels": false}, "themeVariables": {"fontFamily": "system-ui", "primaryColor": "#FDBDE2", "primaryTextColor": "#1B1B19"}} }%%',
  'flowchart TD',
  '  A[Backend condition] --> B[Build payload]',
  '  B --> C[POST /api/v2/tickets]',
  '```',
].join('\n');

const invalidDiagram = 'flowchart TD\n  A -->\n';

function assertSyntaxFailure(result) {
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /::error file=invalid\.mmd,line=1,title=Invalid Mermaid syntax::/);
  assert.doesNotMatch(result.output, /Mermaid parser environment error|purify\./);
}

test('accepts inline theme directives and HTML labels without rendering', (t) => {
  const result = runAction(t, {
    'slides.md': themedDiagram,
    'labels.mmd': 'flowchart TD\n  A["Hello<br/>world"] --> B["<b>Done</b>"]\n',
  });
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /All 2 Mermaid diagram\(s\) passed syntax validation from 2 file\(s\)/);
  assert.doesNotMatch(result.output, /::error/);
});

test('reports syntax errors and continues to the next diagram', (t) => {
  const result = runAction(t, {
    'invalid.mmd': invalidDiagram,
    'valid.md': themedDiagram,
  });
  assertSyntaxFailure(result);
  assert.match(result.output, /Checking valid\.md:1/);
  assert.match(result.output, /Found 1 invalid Mermaid diagram\(s\) out of 2 checked/);
});

test('stops after a syntax error when fail-fast is enabled', (t) => {
  const result = runAction(t, {
    'invalid.mmd': invalidDiagram,
    'valid.md': themedDiagram,
  }, { INPUT_FAIL_FAST: 'true' });
  assertSyntaxFailure(result);
  assert.doesNotMatch(result.output, /Checking valid\.md/);
  assert.match(result.output, /Found 1 invalid Mermaid diagram\(s\) out of 1 checked in 1 file\(s\)/);
});

test('validates Mermaid fences that continue to the end of the file', (t) => {
  const result = runAction(t, { 'invalid.md': `# Diagram\n\n\`\`\`mermaid\n${invalidDiagram}` });
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /::error file=invalid\.md,line=3,title=Invalid Mermaid syntax::/);
});

test('keeps extracted sources in output-dir after removing temporary dependencies', (t) => {
  const result = runAction(t, { 'slides.md': themedDiagram }, { INPUT_OUTPUT_DIR: 'sources' });
  assert.equal(result.status, 0, result.output);
  assert.equal(
    fs.readFileSync(path.join(result.workspace, 'sources', 'slides.md_L1_1.mmd'), 'utf8'),
    `${themedDiagram.split('\n').slice(1, -1).join('\n')}\n`
  );
});

test('reports dependency installation failures as environment errors', (t) => {
  const result = runAction(t, { 'valid.md': themedDiagram }, {
    INPUT_MERMAID_VERSION: '0.0.0-check-mmdjs-nonexistent',
  });
  assert.equal(result.status, 2, result.output);
  assert.match(result.output, /::error title=Mermaid parser dependency installation failed::/);
  assert.match(result.output, /not an invalid diagram/);
  assert.doesNotMatch(result.output, /title=Invalid Mermaid syntax|Found \d+ invalid Mermaid/);
});

test('skips dependency installation when no diagrams exist', (t) => {
  const result = runAction(t, { 'README.md': '# No diagrams\n' });
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /No Mermaid diagrams found/);
  assert.doesNotMatch(result.output, /Installing /);
});
