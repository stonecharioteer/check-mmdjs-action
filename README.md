# check-mmdjs-action

GitHub Action that scans Markdown files for fenced Mermaid blocks, plus standalone `.mmd`/`.mermaid` files, and fails the workflow when any diagram has invalid Mermaid syntax.

The action uses Mermaid's parser API for syntax-only validation. It does **not** render diagrams and does not launch Puppeteer or Chrome, so runner Chrome dependency failures are not reported as invalid diagrams.

It detects code fences such as:

````markdown
```mermaid
graph TD
  A --> B
```
````

## Usage

```yaml
name: Check Mermaid diagrams

on:
  pull_request:
  push:

jobs:
  mermaid:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: stonecharioteer/check-mmdjs-action@v3
```

## Inputs

| Input | Default | Description |
| --- | --- | --- |
| `files` | `**/*.md`, `**/*.markdown`, `**/*.mmd`, `**/*.mermaid` | Newline- or comma-separated glob patterns to scan. |
| `ignore` | `.git/**`, `node_modules/**` | Newline- or comma-separated glob patterns to ignore. |
| `mermaid-version` | `latest` | Version of the `mermaid` npm package used for parser API syntax validation. |
| `mermaid-cli-version` | empty | Deprecated alias for `mermaid-version`; kept for backwards compatibility. |
| `fail-fast` | `false` | Stop after the first invalid diagram. |
| `output-dir` | empty | Optional directory where extracted `.mmd` files are kept. |
| `config-file` | empty | Optional Mermaid config JSON file passed to `mermaid.initialize` before parsing. |
| `puppeteer-config-file` | empty | Deprecated and ignored. v3 does not use Puppeteer or Chrome. |
| `mmdc-args` | empty | Deprecated and ignored. v3 does not use `mermaid-cli`. |

Example with options:

```yaml
- uses: stonecharioteer/check-mmdjs-action@v3
  with:
    files: |
      docs/**/*.md
      README.md
      diagrams/**/*.mmd
    ignore: |
      docs/archive/**
    mermaid-version: 11.4.1
    output-dir: .mermaid-output
    fail-fast: true
```

## Development

Commit messages are checked against the Conventional Commits format.

Using [`pre-commit`](https://pre-commit.com/):

```sh
pre-commit install --hook-type commit-msg
```

Or with Git's native hooks path:

```sh
git config core.hooksPath .githooks
```

## Notes

- The action runs on Node 24 and installs the `mermaid` npm package in a temporary directory for parser API validation.
- Workflow annotations point to the Markdown file and line where the failing Mermaid fence starts, or line 1 for standalone `.mmd`/`.mermaid` files.
- Fences labelled `mermaid`, `mmd`, or `mermaidjs` are checked.
- Standalone `.mmd` and `.mermaid` files are treated as one diagram each.
