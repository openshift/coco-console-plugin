const fs = require('fs');
const path = require('path');
const pluralize = require('pluralize');
const common = require('./common.js');

const publicDir = path.join(__dirname, './../locales/');

// i18next v4 plural categories (keys suffixed `_zero`, `_one`, ..., `_other`)
const V4_PLURAL_SUFFIXES = ['zero', 'one', 'two', 'few', 'many', 'other'];

function determineRule(key) {
  if (key.includes('WithCount_plural')) {
    return 0;
  }
  if (key.includes('WithCount')) {
    return 1;
  }
  if (key.includes('_plural')) {
    return 2;
  }
  return 3;
}

// Detect an i18next v4 plural key ("base_one", "base_other", ...). The parser
// always emits at least two suffixed forms of the same base, so requiring a
// sibling form avoids mangling regular keys that merely end in e.g. "_one".
function getV4Plural(key, allKeys) {
  const idx = key.lastIndexOf('_');
  if (idx === -1) {
    return null;
  }
  const suffix = key.slice(idx + 1);
  if (!V4_PLURAL_SUFFIXES.includes(suffix)) {
    return null;
  }
  const base = key.slice(0, idx);
  const hasSibling = V4_PLURAL_SUFFIXES.some(
    (s) => `${base}_${s}` !== key && allKeys.has(`${base}_${s}`),
  );
  return hasSibling ? { base, suffix } : null;
}

function updateFile(fileName) {
  const file = require(fileName);
  const updatedFile = {};

  const keys = Object.keys(file);
  const keySet = new Set(keys);

  let originalKey;

  for (let i = 0; i < keys.length; i++) {
    const v4Plural = getV4Plural(keys[i], keySet);
    if (v4Plural && (file[keys[i]] === '' || file[keys[i]] === keys[i])) {
      // i18next v4 plural forms. The parser copies the key — including the
      // `_one`/`_other` suffix — as the default value (useKeysAsDefaultValue),
      // which leaks the raw suffix into the UI ("{{count}} nodes_other").
      // Default the `_one` form to the singularized source string and every
      // other form to the source string itself (already the plural wording).
      updatedFile[keys[i]] =
        v4Plural.suffix === 'one' ? pluralize(v4Plural.base, 1) : v4Plural.base;
    } else if (file[keys[i]] === '') {
      // follow i18next rules
      // "key": "item",
      // "key_plural": "items",
      // "keyWithCount": "{{count}} item",
      // "keyWithCount_plural": "{{count}} items"
      switch (determineRule(keys[i])) {
        case 0:
          [originalKey] = keys[i].split('WithCount_plural');
          updatedFile[keys[i]] = `{{count}} ${pluralize(originalKey)}`;
          break;
        case 1:
          [originalKey] = keys[i].split('WithCount');
          updatedFile[keys[i]] = `{{count}} ${originalKey}`;
          break;
        case 2:
          [originalKey] = keys[i].split('_plural');
          updatedFile[keys[i]] = pluralize(originalKey);
          break;
        default:
          updatedFile[keys[i]] = keys[i];
      }
    } else {
      updatedFile[keys[i]] = file[keys[i]];
    }
  }

  fs.promises
    .writeFile(fileName, JSON.stringify(updatedFile, null, 2))
    .catch((e) => console.error(fileName, e));
}

function processLocalesFolder(filePath) {
  if (path.basename(filePath) === 'en') {
    common.parseFolder(filePath, updateFile);
  }
}

common.parseFolder(publicDir, processLocalesFolder);
