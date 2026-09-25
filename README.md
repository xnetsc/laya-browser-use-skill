# Laya Browser Use

A self-contained Codex skill for bounded browser actions selected by a local Laya decision model.
The model, WebGPU runtime, and Playwright launcher are bundled in this repository. It does not use
a separately managed Laya service or remote decision endpoint.

## Requirements

- macOS with Google Chrome installed in `/Applications/Google Chrome.app`
- Node.js 22 or newer
- WebGPU support
- Codex Computer Use connected to Google Chrome for the page being operated
- About 670 MB of disk space after installation

The private headless Chrome process only hosts the local model. Target-page interaction continues
through Codex Computer Use and Google Chrome.

## Install

From a cloned repository or an extracted archive:

```sh
node scripts/verify.mjs
node scripts/install.mjs
```

The default destination is `~/.codex/skills/laya-browser-use`. Restart Codex after installation so
new tasks can discover the skill.

To install into a different Codex home:

```sh
CODEX_HOME=/absolute/path/to/codex node scripts/install.mjs
```

An existing installation is never overwritten silently. Use `--force` to replace it; the installer
moves the previous copy to a timestamped sibling backup first.

## Verify the real runtime

Static verification checks the complete file set and bundled model digest:

```sh
npm run verify
```

The full verification starts system Google Chrome headlessly, loads the complete model through the
loopback HTTP host, initializes WebGPU, and runs one decision:

```sh
npm run verify:runtime
```

No model download occurs during either check.

## Create a ZIP for direct transfer

```sh
npm run bundle
```

The archive is written to `dist/laya-browser-use.zip`. The recipient extracts it and runs
`node scripts/install.mjs` from the extracted directory.

## Publish on GitHub

The 644 MB checkpoint exceeds GitHub's normal per-file limit, so Git LFS is required. The repository
already contains matching `.gitattributes` rules. Before the first commit:

```sh
brew install git-lfs
git lfs install
git init
git add .
git commit -m "Package local Laya browser skill"
git branch -M main
git remote add origin YOUR_GITHUB_REPOSITORY_URL
git push -u origin main
```

Anyone cloning the repository must have Git LFS installed and run `git lfs pull` if their Git client
does not fetch LFS objects automatically. A GitHub release ZIP is also suitable for direct transfer.

## Layout

- `skills/laya-browser-use/`: the directory installed into Codex
- `scripts/install.mjs`: non-destructive installer
- `scripts/verify.mjs`: static and real-runtime verification
- `scripts/bundle.mjs`: reproducible ZIP builder for direct transfer
- `licenses/` and `THIRD_PARTY_NOTICES.md`: redistribution notices

See `skills/laya-browser-use/SKILL.md` for the operational contract and
`skills/laya-browser-use/references/provider-configuration.md` for runtime maintenance.
