import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const source = await readFile(path.join(root, 'apps/desktop/src/shared/createDesktopBridge.ts'), 'utf8');
const commands = [...new Set([...source.matchAll(/\.invoke\('([^']+)'/g)].map(match => match[1]))].sort();
const events = [...new Set([...source.matchAll(/\.on\('([^']+)'/g)].map(match => match[1]))].sort();

const implementations = [
  'apps/desktop-tauri/src-tauri/src/main.rs',
  'crates/loomtv-core/src/store.rs',
  'crates/loomtv-core/src/segments.rs',
  'crates/loomtv-core/src/stremio_store.rs',
];
const native = await Promise.all(implementations.map(async source => ({ source, text: await readFile(path.join(root, source), 'utf8') })));
const sourceOrder = new Map(implementations.map((source, index) => [source, index]));

function isWhitespace(ch) {
  return ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n' || ch === ',';
}

function skipWhitespaceAndComments(value, start) {
  let i = start;
  while (i < value.length) {
    const char = value[i];
    if (isWhitespace(char)) {
      i += 1;
      continue;
    }
    if (char === '/' && value[i + 1] === '/') {
      const nextNewline = value.indexOf('\n', i + 2);
      i = nextNewline === -1 ? value.length : nextNewline + 1;
      continue;
    }
    if (char === '/' && value[i + 1] === '*') {
      const nextEnd = value.indexOf('*/', i + 2);
      i = nextEnd === -1 ? value.length : nextEnd + 2;
      continue;
    }
    break;
  }
  return i;
}

function findMatching(value, start, open, close) {
  let i = start;
  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  let inBacktick = false;
  let inLineComment = false;
  let inBlockComment = false;

  while (i < value.length) {
    const char = value[i];
    const next = value[i + 1];
    if (inLineComment) {
      if (char === '\n') {
        inLineComment = false;
      }
      i += 1;
      continue;
    }
    if (inBlockComment) {
      if (char === '*' && next === '/') {
        inBlockComment = false;
        i += 2;
      } else {
        i += 1;
      }
      continue;
    }
    if (inSingle) {
      if (char === '\\') {
        i += 2;
        continue;
      }
      if (char === "'") inSingle = false;
      i += 1;
      continue;
    }
    if (inDouble) {
      if (char === '\\') {
        i += 2;
        continue;
      }
      if (char === '"') inDouble = false;
      i += 1;
      continue;
    }
    if (inBacktick) {
      if (char === '\\') {
        i += 2;
        continue;
      }
      if (char === '`') inBacktick = false;
      i += 1;
      continue;
    }

    if (char === "'" ) {
      inSingle = true;
      i += 1;
      continue;
    }
    if (char === '"') {
      inDouble = true;
      i += 1;
      continue;
    }
    if (char === '`') {
      inBacktick = true;
      i += 1;
      continue;
    }
    if (char === '/' && next === '/') {
      inLineComment = true;
      i += 2;
      continue;
    }
    if (char === '/' && next === '*') {
      inBlockComment = true;
      i += 2;
      continue;
    }

    if (char === open) {
      depth += 1;
    } else if (char === close) {
      depth -= 1;
      if (depth === 0) return i;
    } else if (char === '(' || char === '{' || char === '[') {
      depth += 1;
    } else if (char === ')' || char === '}' || char === ']') {
      depth -= 1;
    }
    i += 1;
  }
  return -1;
}

function findTopLevelNeedle(value, start, needle) {
  let i = start;
  let inSingle = false;
  let inDouble = false;
  let inBacktick = false;
  let inLineComment = false;
  let inBlockComment = false;
  let depthParen = 0;
  let depthBrace = 0;
  let depthBracket = 0;

  while (i <= value.length - needle.length) {
    const char = value[i];
    const next = value[i + 1];
    if (inLineComment) {
      if (char === '\n') inLineComment = false;
      i += 1;
      continue;
    }
    if (inBlockComment) {
      if (char === '*' && next === '/') {
        inBlockComment = false;
        i += 2;
      } else {
        i += 1;
      }
      continue;
    }
    if (inSingle) {
      if (char === '\\') {
        i += 2;
        continue;
      }
      if (char === "'") inSingle = false;
      i += 1;
      continue;
    }
    if (inDouble) {
      if (char === '\\') {
        i += 2;
        continue;
      }
      if (char === '"') inDouble = false;
      i += 1;
      continue;
    }
    if (inBacktick) {
      if (char === '\\') {
        i += 2;
        continue;
      }
      if (char === '`') inBacktick = false;
      i += 1;
      continue;
    }

    if (char === "'" ) {
      inSingle = true;
      i += 1;
      continue;
    }
    if (char === '"') {
      inDouble = true;
      i += 1;
      continue;
    }
    if (char === '`') {
      inBacktick = true;
      i += 1;
      continue;
    }
    if (char === '/' && next === '/') {
      inLineComment = true;
      i += 2;
      continue;
    }
    if (char === '/' && next === '*') {
      inBlockComment = true;
      i += 2;
      continue;
    }

    if (char === '(') depthParen += 1;
    else if (char === ')') depthParen = Math.max(0, depthParen - 1);
    else if (char === '{') depthBrace += 1;
    else if (char === '}') depthBrace = Math.max(0, depthBrace - 1);
    else if (char === '[') depthBracket += 1;
    else if (char === ']') depthBracket = Math.max(0, depthBracket - 1);

    if (!depthParen && !depthBrace && !depthBracket && value.startsWith(needle, i)) {
      return i;
    }
    i += 1;
  }
  return -1;
}

function extractMatchBlocks(value) {
  const blocks = [];
  let from = 0;
  while (from < value.length) {
    const channelMatch = value.indexOf('match channel', from);
    if (channelMatch === -1) break;
    const braceStart = value.indexOf('{', channelMatch);
    if (braceStart === -1) break;
    const braceEnd = findMatching(value, braceStart, '{', '}');
    if (braceEnd === -1) break;
    blocks.push(value.slice(braceStart + 1, braceEnd));
    from = braceEnd + 1;
  }
  return blocks;
}

function isUnsupportedBody(body) {
  if (/\bSTREMIO_PLUGIN_NOT_IMPLEMENTED\b/.test(body)) return true;
  if (/\banalysis_unavailable\s*\(/.test(body) && !/\bOk\s*\(/.test(body)) return true;
  if (/\bstremio_configuration_write_unsupported\s*\(/.test(body) && !/\bOk\s*\(/.test(body)) return true;
  if (/Err\s*\(\s*Error::unsupported\s*\(/.test(body) && !/\bOk\s*\(/.test(body)) return true;
  return false;
}

function collectMatchArmRules(matchBlock) {
  const rules = [];
  let cursor = 0;
  while (cursor < matchBlock.length) {
    cursor = skipWhitespaceAndComments(matchBlock, cursor);
    if (cursor >= matchBlock.length) break;
    if (matchBlock[cursor] === ',') {
      cursor += 1;
      continue;
    }

    const arrow = findTopLevelNeedle(matchBlock, cursor, '=>');
    if (arrow === -1) break;
    const patternText = matchBlock.slice(cursor, arrow).trim();
    if (!patternText) break;
    if (patternText === '_' || patternText.startsWith('_')) {
      cursor = matchBlock.indexOf(',', arrow);
      if (cursor === -1) break;
      cursor += 1;
      continue;
    }

    let bodyStart = skipWhitespaceAndComments(matchBlock, arrow + 2);
    if (bodyStart >= matchBlock.length) break;
    let bodyEnd;
    if (matchBlock[bodyStart] === '{') {
      bodyEnd = findMatching(matchBlock, bodyStart, '{', '}') + 1;
    } else {
      bodyEnd = findTopLevelNeedle(matchBlock, bodyStart, ',');
      if (bodyEnd === -1) bodyEnd = matchBlock.length;
    }

    const body = matchBlock.slice(bodyStart, bodyEnd).trim();
    const isUnsupported = isUnsupportedBody(body);
    const exact = [...patternText.matchAll(/"([^"]+)"/g)].map(match => match[1]);
    const prefixes = [...patternText.matchAll(/starts_with\("([^"]+)"\)/g)].map(match => match[1]);
    rules.push({ exact, prefixes, unsupported: isUnsupported });
    cursor = bodyEnd + 1;
  }
  return rules;
}

const implementationRules = native.flatMap(({ source, text }) => {
  const matchBlocks = extractMatchBlocks(text);
  const rules = matchBlocks.flatMap(collectMatchArmRules);
  return rules.map(rule => ({
    source,
    ...rule,
  }));
});

function collectHandlers(command) {
  const sources = new Set();
  for (const { source, exact, prefixes, unsupported } of implementationRules) {
    if (unsupported) continue;
    if (exact.includes(command)) {
      sources.add(source);
      continue;
    }
    if (prefixes.some(prefix => command.startsWith(prefix))) {
      sources.add(source);
    }
  }
  return [...sources].sort((left, right) => sourceOrder.get(left) - sourceOrder.get(right));
}

const entries = commands.map(channel => ({
  channel,
  status: 'unverified',
  handlerSources: collectHandlers(channel),
}));
const missing = entries.filter(entry => entry.handlerSources.length === 0).map(entry => entry.channel);
const report = {
  referenceSha: 'e5907d2be8d43309d5f3b648735e08dc584dd84b',
  scope: 'desktop',
  complete: false,
  explanation: 'A referenced command name does not prove implementation or behavior parity. All native behavior remains unverified.',
  commands: entries,
  events,
  missingHandlers: missing,
};
if (process.argv.includes('--write')) {
  await writeFile(path.join(root, 'docs/tauri-port/bridge-coverage.json'), JSON.stringify(report, null, 2) + '\n');
}
console.log(`${commands.length} invoke channels, ${events.length} event channels, ${missing.length} channels without a Rust handler reference.`);
console.log('Full desktop parity is incomplete. Native behavior has not been tested.');
if (!process.argv.includes('--write')) process.exitCode = 1;
