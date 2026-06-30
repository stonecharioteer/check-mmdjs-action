# check-mmdjs-action

GitHub Action that scans Markdown files for fenced Mermaid blocks, plus standalone `.mmd`/`.mermaid` files, and fails the workflow when any diagram cannot be rendered by [`@mermaid-js/mermaid-cli`](https://github.com/mermaid-js/mermaid-cli).

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
      - uses: stonecharioteer/check-mmdjs-action@v1
```

## Inputs

| Input | Default | Description |
| --- | --- | --- |
| `files` | `**/*.md`, `**/*.markdown`, `**/*.mmd`, `**/*.mermaid` | Newline- or comma-separated glob patterns to scan. |
| `ignore` | `.git/**`, `node_modules/**` | Newline- or comma-separated glob patterns to ignore. |
| `mermaid-cli-version` | `latest` | Version of `@mermaid-js/mermaid-cli` to run with `npx`. |
| `fail-fast` | `false` | Stop after the first invalid diagram. |
| `output-dir` | empty | Optional directory where extracted `.mmd` files and rendered `.svg` files are kept. |
| `config-file` | empty | Optional Mermaid config JSON file passed to `mmdc`. |
| `puppeteer-config-file` | generated no-sandbox config | Optional Puppeteer config JSON file passed to `mmdc`. |
| `mmdc-args` | empty | Extra shell-style arguments appended to each `mmdc` invocation. |

Example with options:

```yaml
- uses: stonecharioteer/check-mmdjs-action@v1
  with:
    files: |
      docs/**/*.md
      README.md
    ignore: |
      docs/archive/**
    mermaid-cli-version: 11.4.1
    output-dir: .mermaid-output
    fail-fast: true
```

## Notes

- The action runs on Node 20 and invokes Mermaid CLI through `npx`, so no package installation is required in the consuming repository.
- Workflow annotations point to the Markdown file and line where the failing Mermaid fence starts.
- Fences labelled `mermaid`, `mmd`, or `mermaidjs` are checked.
- Standalone `.mmd` and `.mermaid` files are treated as one diagram each.
