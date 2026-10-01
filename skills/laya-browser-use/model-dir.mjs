// Which directory under `runtime/models/` holds the checkpoint.
//
// Found, not named. Whichever directory carries a `manifest.json` is the model, so swapping
// the checkpoint is dropping a directory in and taking the old one out: there is no path
// literal to chase through the scripts, the tests, the page and the docs, which is what a
// hardcoded name costs every single time the model changes. It cost exactly that once
// already, which is why this exists.
//
// `LAYA_MODEL_DIR` names it explicitly, which is only needed when more than one is present.
//
// Kept dependency-free on purpose: the runtime updater runs before `prepare-model.mjs` is
// even imported, and both have to agree on where the model is.

import {existsSync, readdirSync} from 'node:fs';
import {join} from 'node:path';

export function modelsRoot(skillRoot) {
  return join(skillRoot, 'runtime', 'models');
}

export function modelDirName(skillRoot) {
  const asked = process.env.LAYA_MODEL_DIR;
  if (asked) return asked;
  const root = modelsRoot(skillRoot);
  let found = [];
  try {
    found = readdirSync(root, {withFileTypes: true})
      // A dot-prefixed directory is work in progress, not a model. The updater stages a new
      // checkpoint as a sibling of the installed one, manifest and all, and that staging
      // directory would otherwise count as a second model and make the choice ambiguous --
      // which is exactly what happened, and what the update test now holds in place.
      .filter((e) => e.isDirectory() && !e.name.startsWith('.')
        && existsSync(join(root, e.name, 'manifest.json')))
      .map((e) => e.name)
      .sort();
  } catch {
    throw new Error(`No model directory under ${root}. Run: node skills/laya-browser-use/prepare-model.mjs`);
  }
  if (found.length === 1) return found[0];
  if (!found.length) throw new Error(`No manifest.json under any directory in ${root}.`);
  throw new Error(`Several model directories under ${root} (${found.join(', ')}). `
    + 'Set LAYA_MODEL_DIR to the one to use, or remove the others.');
}

/** Where the model's files live inside the skill, e.g. `runtime/models/xdecision/`. */
export function modelPrefix(skillRoot) {
  return `runtime/models/${modelDirName(skillRoot)}/`;
}

/** Where the local server mounts them, e.g. `/models/xdecision/`. */
export function modelMount(skillRoot) {
  return `/models/${modelDirName(skillRoot)}/`;
}

/** The directory itself. */
export function modelRoot(skillRoot) {
  return join(modelsRoot(skillRoot), modelDirName(skillRoot));
}
