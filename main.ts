// mend — one patch tool for every AI edit format.
//
// A fresh implementation of SPEC.md (version 1), written from the
// specification itself: unified diffs with wrong line numbers,
// SEARCH/REPLACE blocks, V4A patches, and JSON tool calls, applied
// atomically to a tree of text files. Node 22, standard library only.
//
// Usage: node main.ts [--format=NAME] [--check] [--strict] [PATCH]
// When MAKEFUN_ENV_URL is set, the trial harness in runner.ts takes over.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMAT_NAMES = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

/** A parse fault: exit 2 with exactly this one line on stdout. */
class ParseFault extends Error {
  readonly line: string;
  constructor(line: string) {
    super(line);
    this.line = line;
  }
}

/** A failed edit: exit 1 with `error: <code> <path>` for this edit. */
class EditFault extends Error {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    super(`${code} ${path}`);
    this.code = code;
    this.path = path;
  }
}

const isBlank = (s: string): boolean => s.trim() === '';

/** SPEC section 3: a patch's lines are its text split at \n, each with one
 * trailing \r removed, and without the empty piece after a final \n. */
function splitPatch(text: string): string[] {
  if (text === '') return [];
  const parts = text.split('\n');
  if (text.endsWith('\n')) parts.pop();
  return parts.map((p) => (p.endsWith('\r') ? p.slice(0, -1) : p));
}

/** SPEC section 3: a path is safe when it is not empty, does not start with
 * `/`, holds no `\`, and none of its `/`-separated segments is empty, `.`
 * or `..`. */
function isSafePath(p: string): boolean {
  if (p === '' || p.startsWith('/') || p.includes('\\')) return false;
  return p.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

const leadWhitespace = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};
const trimTrailingWs = (s: string): string => s.replace(/[ \t]+$/, '');
const trimBothWs = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');

/** SPEC section 5: line equality at a tier. Tier 0 is exact; tier 1 drops
 * trailing spaces and tabs from both sides; tier 2 drops leading and
 * trailing spaces and tabs from both sides. */
function linesEqual(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimTrailingWs(a) === trimTrailingWs(b);
  return trimBothWs(a) === trimBothWs(b);
}

/** SPEC section 3: a file's line break is CRLF when its first line feed
 * follows a carriage return, and LF otherwise. Lines are the text split at
 * that break; a trailing break means the last empty piece is not a line.
 * An empty file has no lines and no final break. */
interface TextFile {
  lines: string[];
  break: '\r\n' | '\n';
  endsWithBreak: boolean;
}

function parseTextFile(text: string): TextFile {
  if (text === '') return { lines: [], break: '\n', endsWithBreak: false };
  const firstLf = text.indexOf('\n');
  const br: '\r\n' | '\n' = firstLf > 0 && text[firstLf - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const endsWithBreak = text.endsWith(br);
  if (endsWithBreak) parts.pop();
  return { lines: parts, break: br, endsWithBreak };
}

function renderTextFile(doc: TextFile): string {
  if (doc.lines.length === 0) return '';
  return doc.lines.join(doc.break) + (doc.endsWithBreak ? doc.break : '');
}

/**
 * The working tree: files the edits see, overlaid on the directory on
 * disk. `current` holds every path an edit has touched (null = deleted);
 * anything else is read from disk on demand and cached in `disk`.
 * A path counts as an existing directory when some file in the tree sits
 * below it, and as blocked by a file when an ancestor path is a file.
 */
class WorkTree {
  private readonly disk = new Map<string, string | null>();
  readonly current = new Map<string, string | null>();

  private readDisk(p: string): string | null {
    if (!this.disk.has(p)) {
      let value: string | null = null;
      try {
        if (statSync(p).isFile()) value = readFileSync(p, 'utf8');
      } catch {
        value = null;
      }
      this.disk.set(p, value);
    }
    return this.disk.get(p) ?? null;
  }

  /** The file's text now, or null when there is no such file. */
  read(p: string): string | null {
    return this.current.has(p) ? (this.current.get(p) ?? null) : this.readDisk(p);
  }

  /** True when p is a file in the tree now. */
  isFile(p: string): boolean {
    return this.read(p) !== null;
  }

  /** True when p is a directory in the tree now (some file lives below it). */
  isDir(p: string): boolean {
    const prefix = `${p}/`;
    for (const [k, v] of this.current) {
      if (v !== null && k.startsWith(prefix)) return true;
    }
    // Untouched files on disk: check the directory itself.
    try {
      return statSync(p).isDirectory();
    } catch {
      return false;
    }
  }

  /** True when an ancestor of p is a file in the tree now. */
  hasFileAncestor(p: string): boolean {
    const parts = p.split('/');
    for (let i = 1; i < parts.length; i++) {
      if (this.isFile(parts.slice(0, i).join('/'))) return true;
    }
    return false;
  }

  /** True when anything (file or directory) sits at p now. */
  exists(p: string): boolean {
    return this.isFile(p) || this.isDir(p);
  }
}

/** Positions (0-based) where the old lines occur in the file's lines at a
 * tier, at or after `from`. Overlapping occurrences count. */
function occurrencesAt(lines: string[], old: string[], tier: number, from: number): number[] {
  const found: number[] = [];
  if (old.length === 0) return found;
  for (let i = from; i + old.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < old.length; j++) {
      if (!linesEqual(lines[i + j] as string, old[j] as string, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) found.push(i);
  }
  return found;
}

/** The first tier (0, then 1, then 2; only 0 when strict) at which the old
 * lines occur at or after `from`, with that tier's occurrences. */
function firstTierWith(
  lines: string[],
  old: string[],
  from: number,
  strict: boolean,
): { tier: number; positions: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const positions = occurrencesAt(lines, old, tier, from);
    if (positions.length > 0) return { tier, positions };
  }
  return null;
}

/** One line of a replacement: either a context line (taken from the file's
 * own matched line) or a fresh line. `oldIndex` is the context line's index
 * inside the old lines. */
interface ReplacementLine {
  fromFile: boolean;
  text: string;
  oldIndex: number;
}

/**
 * SPEC section 5: build the lines that replace a matched occurrence.
 * Context lines are written as the file's own matched lines, never the
 * patch's. At tier 2 every other non-empty, non-whitespace line that starts
 * with the old first line's leading whitespace has that whitespace replaced
 * by the file's first matched line's leading whitespace.
 */
function buildReplacement(
  fileLines: string[],
  at: number,
  old: string[],
  replacement: ReplacementLine[],
  tier: number,
): string[] {
  const fileLead = leadWhitespace(fileLines[at] as string);
  const oldLead = leadWhitespace(old[0] as string);
  const out: string[] = [];
  for (const item of replacement) {
    if (item.fromFile) {
      out.push(fileLines[at + item.oldIndex] as string);
    } else {
      let text = item.text;
      if (tier === 2 && text !== '' && text.trim() !== '' && text.startsWith(oldLead)) {
        text = fileLead + text.slice(oldLead.length);
      }
      out.push(text);
    }
  }
  return out;
}

/** A body line of a unified hunk or a V4A chunk. */
type BodyLine =
  | { kind: 'context'; text: string }
  | { kind: 'removed'; text: string }
  | { kind: 'added'; text: string }
  | { kind: 'noNewline'; text: string };

function toBodyLine(raw: string): BodyLine {
  if (raw === '') return { kind: 'context', text: '' };
  const head = raw[0] as string;
  if (head === ' ') return { kind: 'context', text: raw.slice(1) };
  if (head === '-') return { kind: 'removed', text: raw.slice(1) };
  if (head === '+') return { kind: 'added', text: raw.slice(1) };
  return { kind: 'noNewline', text: raw };
}

/** Split a hunk/chunk body into its old lines and its replacement lines. */
function splitBody(body: BodyLine[]): { old: string[]; replacement: ReplacementLine[] } {
  const old: string[] = [];
  const replacement: ReplacementLine[] = [];
  for (const item of body) {
    if (item.kind === 'context') {
      old.push(item.text);
      replacement.push({ fromFile: true, text: item.text, oldIndex: old.length - 1 });
    } else if (item.kind === 'removed') {
      old.push(item.text);
    } else if (item.kind === 'added') {
      replacement.push({ fromFile: false, text: item.text, oldIndex: -1 });
    }
  }
  return { old, replacement };
}

/** True when a `\` line follows the body's last context or added line. */
function endsWithoutNewline(body: BodyLine[]): boolean {
  for (let k = body.length - 1; k >= 0; k--) {
    const item = body[k] as BodyLine;
    if (item.kind === 'context' || item.kind === 'added') {
      return body[k + 1] !== undefined && body[k + 1]?.kind === 'noNewline';
    }
  }
  return false;
}

/** SPEC section 4: with --format=auto the format is the first of these
 * that holds. A format named with --format is read as that format whatever
 * the text holds. */
function detectFormat(lines: string[]): string | null {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) return null;
  if ((lines[first] as string).trim() === '*** Begin Patch') return 'v4a';
  const head = (lines[first] as string).trimStart()[0];
  if (head === '[' || head === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (
    lines.some(
      (l, i) =>
        l.startsWith('diff --git ') ||
        (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')),
    )
  ) {
    return 'unified';
  }
  return null;
}

/** One edit: a function that applies itself to the tree or throws
 * EditFault. Edits are parsed fully before any of them runs. */
type EditFn = (tree: WorkTree) => void;

/** Count occurrences of a pattern in text, counting overlapping positions. */
function countOverlapping(text: string, pattern: string): number {
  let count = 0;
  let from = 0;
  for (;;) {
    const at = text.indexOf(pattern, from);
    if (at < 0) break;
    count++;
    from = at + 1;
  }
  return count;
}

interface JsonCommand {
  command: string;
  path: string;
  fileText?: string;
  oldStr?: string;
  newStr?: string;
  insertLine?: number;
}

/**
 * SPEC section 9: validate one edit object. A wrong command or a missing
 * or mistyped key is a parse fault at the given line. For str_replace the
 * specification says new_str absent is empty; for insert it does not, so a
 * missing new_str there is a missing key.
 */
function validateJsonCommand(value: unknown, line: number): JsonCommand {
  const bad = (): never => {
    throw new ParseFault(`error: parse ${line}`);
  };
  if (typeof value !== 'object' || value === null || Array.isArray(value)) bad();
  const obj = value as Record<string, unknown>;
  if (typeof obj.command !== 'string' || !['create', 'str_replace', 'insert'].includes(obj.command)) bad();
  if (typeof obj.path !== 'string') bad();
  if (obj.command === 'create') {
    if (typeof obj.file_text !== 'string') bad();
    return { command: obj.command, path: obj.path, fileText: obj.file_text };
  }
  if (obj.command === 'str_replace') {
    if (typeof obj.old_str !== 'string' || obj.old_str === '') bad();
    if (obj.new_str !== undefined && typeof obj.new_str !== 'string') bad();
    return {
      command: obj.command,
      path: obj.path,
      oldStr: obj.old_str,
      newStr: typeof obj.new_str === 'string' ? obj.new_str : '',
    };
  }
  if (typeof obj.insert_line !== 'number' || !Number.isInteger(obj.insert_line)) bad();
  if (typeof obj.new_str !== 'string') bad();
  return { command: obj.command, path: obj.path, insertLine: obj.insert_line, newStr: obj.new_str };
}

function jsonEditFn(cmd: JsonCommand): EditFn {
  return (tree: WorkTree) => {
    const p = cmd.path;
    if (!isSafePath(p)) throw new EditFault('unsafe', p);
    if (tree.hasFileAncestor(p)) throw new EditFault('exists', p);
    if (cmd.command === 'create') {
      if (tree.exists(p)) throw new EditFault('exists', p);
      tree.current.set(p, cmd.fileText as string);
      return;
    }
    const before = tree.read(p);
    if (before === null) throw new EditFault('missing', p);
    if (cmd.command === 'str_replace') {
      // In a CRLF file the text and both strings are read with every \r\n
      // as \n, and the result is written back with \r\n. No tier applies:
      // the match is exact.
      const firstLf = before.indexOf('\n');
      const crlf = firstLf > 0 && before[firstLf - 1] === '\r';
      const normalize = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const text = normalize(before);
      const old = normalize(cmd.oldStr as string);
      const count = countOverlapping(text, old);
      if (count === 0) throw new EditFault('no-match', p);
      if (count > 1) throw new EditFault('ambiguous', p);
      const at = text.indexOf(old);
      const out = text.slice(0, at) + normalize(cmd.newStr as string) + text.slice(at + old.length);
      tree.current.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
      return;
    }
    const doc = parseTextFile(before);
    const k = cmd.insertLine as number;
    if (k < 0 || k > doc.lines.length) throw new EditFault('no-match', p);
    const inserted = cmd.newStr === '' ? [] : splitPatch(cmd.newStr as string);
    const lines = [...doc.lines.slice(0, k), ...inserted, ...doc.lines.slice(k)];
    tree.current.set(p, renderTextFile({ lines, break: doc.break, endsWithBreak: doc.endsWithBreak }));
  };
}

/** SPEC section 9: the patch is one JSON array of edit objects, or JSON
 * Lines with one edit object a line and blank lines ignored. In array form
 * any fault is a parse fault at the line where the array starts; in JSON
 * Lines form a line that does not hold one valid edit object is a parse
 * fault at that line. */
function parseJson(lines: string[]): EditFn[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new ParseFault('error: parse 1');
  if ((lines[first] as string).trimStart().startsWith('[')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(lines.slice(first).join('\n'));
    } catch {
      throw new ParseFault(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(parsed)) throw new ParseFault(`error: parse ${first + 1}`);
    if (parsed.length === 0) throw new ParseFault('error: parse 1');
    return parsed.map((el) => jsonEditFn(validateJsonCommand(el, first + 1)));
  }
  const edits: EditFn[] = [];
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] as string;
    if (isBlank(raw)) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new ParseFault(`error: parse ${i + 1}`);
    }
    edits.push(jsonEditFn(validateJsonCommand(parsed, i + 1)));
  }
  if (edits.length === 0) throw new ParseFault('error: parse 1');
  return edits;
}

/** SPEC section 6: one hunk of a unified diff. */
interface Hunk {
  /** Old-file start line (1-based) from the @@ header. */
  start: number;
  body: BodyLine[];
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const DIFF_GIT = /^diff --git a\/(\S+) b\/(\S+)\s*$/;

/** The path after `--- ` or `+++ `: text after the four characters, up to
 * the first tab, with surrounding spaces removed. /dev/null means no file;
 * a leading a/ or b/ is removed from either. */
function diffPath(line: string): string | null {
  let rest = line.slice(4);
  const tab = rest.indexOf('\t');
  if (tab >= 0) rest = rest.slice(0, tab);
  rest = rest.trim();
  if (rest === '/dev/null') return null;
  if (rest.startsWith('a/') || rest.startsWith('b/')) rest = rest.slice(2);
  return rest;
}

interface UnifiedSection {
  oldPath: string | null;
  newPath: string | null;
  creation: boolean;
  deletion: boolean;
  move: boolean;
  hunks: Hunk[];
}

interface RunContext {
  strict: boolean;
  moves: Array<{ old: string; new: string }>;
}

/** Apply one hunk to a file's lines. Returns the new lines, the final-break
 * flag, and the change in line count (for the next hunk's drift). */
function applyHunk(
  doc: TextFile,
  hunk: Hunk,
  drift: number,
  strict: boolean,
  path: string,
): { doc: TextFile; delta: number } {
  const { old, replacement } = splitBody(hunk.body);
  if (old.length === 0) {
    const at = Math.max(0, Math.min(hunk.start + drift, doc.lines.length));
    const inserted = replacement.map((item) => item.text);
    const lines = [...doc.lines.slice(0, at), ...inserted, ...doc.lines.slice(at)];
    const endsWithBreak = at === doc.lines.length ? !endsWithoutNewline(hunk.body) : doc.endsWithBreak;
    return { doc: { lines, break: doc.break, endsWithBreak }, delta: replacement.length };
  }
  const found = firstTierWith(doc.lines, old, 0, strict);
  if (found === null) throw new EditFault('no-match', path);
  // Of the occurrences at the tier where O is found, take the one whose
  // 0-based position is nearest to A - 1 + drift; of two equally near, the
  // earlier.
  const target = hunk.start - 1 + drift;
  let best = found.positions[0] as number;
  for (const pos of found.positions) {
    if (Math.abs(pos - target) < Math.abs(best - target)) best = pos;
  }
  const built = buildReplacement(doc.lines, best, old, replacement, found.tier);
  const runsToEnd = best + old.length === doc.lines.length;
  const lines = [...doc.lines.slice(0, best), ...built, ...doc.lines.slice(best + old.length)];
  const endsWithBreak = runsToEnd ? !endsWithoutNewline(hunk.body) : doc.endsWithBreak;
  return { doc: { lines, break: doc.break, endsWithBreak }, delta: replacement.length - old.length };
}

function unifiedEditFn(section: UnifiedSection, ctx: RunContext): EditFn {
  return (tree: WorkTree) => {
    if (section.creation) {
      const p = section.newPath;
      if (p === null) return; // names no file: nothing to create
      if (!isSafePath(p)) throw new EditFault('unsafe', p);
      if (tree.exists(p) || tree.hasFileAncestor(p)) throw new EditFault('exists', p);
      const out: string[] = [];
      for (const hunk of section.hunks) {
        for (const item of hunk.body) if (item.kind === 'added') out.push(item.text);
      }
      let noBreak = false;
      for (let hi = section.hunks.length - 1; hi >= 0 && !noBreak; hi--) {
        const body = (section.hunks[hi] as Hunk).body;
        for (let k = body.length - 1; k >= 0; k--) {
          if ((body[k] as BodyLine).kind === 'added') {
            noBreak = endsWithoutNewline(body.slice(0, k + 2));
            break;
          }
        }
        if (noBreak) break;
        // No added line in this hunk; keep scanning earlier hunks.
        if (body.some((item) => item.kind === 'added')) break;
      }
      tree.current.set(p, out.length === 0 ? '' : out.join('\n') + (noBreak ? '' : '\n'));
      return;
    }
    if (section.deletion) {
      const p = section.oldPath;
      if (p === null) return; // names no file: nothing to delete
      if (!isSafePath(p)) throw new EditFault('unsafe', p);
      if (!tree.isFile(p)) throw new EditFault('missing', p);
      tree.current.set(p, null);
      return;
    }
    const oldP = section.oldPath;
    const newP = section.newPath;
    if (oldP === null || newP === null) return; // names no file either way
    if (!isSafePath(oldP)) throw new EditFault('unsafe', oldP);
    if (!isSafePath(newP)) throw new EditFault('unsafe', newP);
    const before = tree.read(oldP);
    if (before === null) throw new EditFault('missing', oldP);
    if (section.move && (tree.exists(newP) || tree.hasFileAncestor(newP))) {
      throw new EditFault('exists', newP);
    }
    let doc = parseTextFile(before);
    let drift = 0;
    for (const hunk of section.hunks) {
      const res = applyHunk(doc, hunk, drift, ctx.strict, oldP);
      doc = res.doc;
      drift += res.delta;
    }
    const text = renderTextFile(doc);
    if (section.move) {
      tree.current.set(oldP, null);
      tree.current.set(newP, text);
      ctx.moves.push({ old: oldP, new: newP });
    } else {
      tree.current.set(oldP, text);
    }
  };
}

/** Parse one unified section starting at `start` (a `diff --git` line or a
 * `--- ` line followed by a `+++ ` line). Returns the index of the first
 * line after the section. */
function parseUnifiedSection(lines: string[], start: number, edits: EditFn[], ctx: RunContext): number {
  const n = lines.length;
  let i = start;
  let pairOld: string | null = null;
  let pairNew: string | null = null;
  let pairSet = false;
  let renameFrom: string | null = null;
  let renameTo: string | null = null;
  let diffOld: string | null = null;
  let diffNew: string | null = null;
  let newFileMode = false;
  let deletedFileMode = false;
  let inHeader = true;
  const hunks: Hunk[] = [];

  if (lines[i]?.startsWith('diff --git ')) {
    const m = DIFF_GIT.exec(lines[i] as string);
    if (m === null) throw new ParseFault(`error: parse ${i + 1}`);
    diffOld = m[1] as string;
    diffNew = m[2] as string;
    i++;
  }

  while (i < n) {
    const line = lines[i] as string;
    if (line.startsWith('@@')) {
      const m = HUNK_HEADER.exec(line);
      if (m === null) throw new ParseFault(`error: parse ${i + 1}`);
      inHeader = false;
      const startLine = parseInt(m[1] as string, 10);
      const rawBody: string[] = [];
      let j = i + 1;
      while (j < n) {
        const bodyLine = lines[j] as string;
        if (bodyLine.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
        if (
          bodyLine === '' ||
          bodyLine[0] === ' ' ||
          bodyLine[0] === '-' ||
          bodyLine[0] === '+' ||
          bodyLine[0] === '\\'
        ) {
          rawBody.push(bodyLine);
          j++;
        } else {
          break;
        }
      }
      while (rawBody.length > 0 && rawBody[rawBody.length - 1] === '') rawBody.pop();
      hunks.push({ start: startLine, body: rawBody.map(toBodyLine) });
      i = j;
      continue;
    }
    if (line.startsWith('diff --git ')) break;
    if (line.startsWith('--- ')) {
      if ((lines[i + 1] ?? '').startsWith('+++ ')) {
        if (inHeader && !pairSet) {
          pairOld = diffPath(line);
          pairNew = diffPath(lines[i + 1] as string);
          pairSet = true;
          i += 2;
          continue;
        }
        break;
      }
      if (inHeader) throw new ParseFault(`error: parse ${i + 2}`);
      break;
    }
    if (line.startsWith('+++ ')) {
      i++;
      continue;
    }
    if (line.startsWith('rename from ')) {
      renameFrom = line.slice('rename from '.length).trim();
      i++;
      continue;
    }
    if (line.startsWith('rename to ')) {
      renameTo = line.slice('rename to '.length).trim();
      i++;
      continue;
    }
    if (line.startsWith('new file mode')) {
      newFileMode = true;
      i++;
      continue;
    }
    if (line.startsWith('deleted file mode')) {
      deletedFileMode = true;
      i++;
      continue;
    }
    i++;
  }

  let oldPath: string | null;
  let newPath: string | null;
  if (pairSet) {
    oldPath = pairOld;
    newPath = pairNew;
  } else {
    oldPath = renameFrom ?? diffOld;
    newPath = renameTo ?? diffNew;
  }
  const creation = (pairSet && pairOld === null && pairNew !== null) || newFileMode;
  const deletion = (pairSet && pairNew === null && pairOld !== null) || deletedFileMode;
  const move = !creation && !deletion && oldPath !== null && newPath !== null && oldPath !== newPath;
  edits.push(unifiedEditFn({ oldPath, newPath, creation, deletion, move, hunks }, ctx));
  return i;
}

/** SPEC section 6: parse the whole patch as a unified diff. Lines outside
 * bodies that are not part of a section header are ignored. */
function parseUnified(lines: string[], ctx: RunContext): EditFn[] {
  const edits: EditFn[] = [];
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const line = lines[i] as string;
    if (line.startsWith('diff --git ')) {
      i = parseUnifiedSection(lines, i, edits, ctx);
    } else if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      i = parseUnifiedSection(lines, i, edits, ctx);
    } else if (line.startsWith('@@')) {
      throw new ParseFault(`error: parse ${i + 1}`);
    } else {
      i++;
    }
  }
  if (edits.length === 0) throw new ParseFault('error: parse 1');
  return edits;
}

/** SPEC section 7: one SEARCH/REPLACE block is one edit. */
function searchReplaceEditFn(path: string, oldLines: string[], newLines: string[], ctx: RunContext): EditFn {
  return (tree: WorkTree) => {
    if (!isSafePath(path)) throw new EditFault('unsafe', path);
    if (tree.hasFileAncestor(path)) throw new EditFault('exists', path);
    if (oldLines.length === 0) {
      if (tree.exists(path)) throw new EditFault('exists', path);
      tree.current.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const before = tree.read(path);
    if (before === null) throw new EditFault('missing', path);
    const doc = parseTextFile(before);
    const found = firstTierWith(doc.lines, oldLines, 0, ctx.strict);
    if (found === null) throw new EditFault('no-match', path);
    if (found.positions.length > 1) throw new EditFault('ambiguous', path);
    const at = found.positions[0] as number;
    const replacement = newLines.map((text) => ({ fromFile: false, text, oldIndex: -1 }));
    const built = buildReplacement(doc.lines, at, oldLines, replacement, found.tier);
    const lines = [...doc.lines.slice(0, at), ...built, ...doc.lines.slice(at + oldLines.length)];
    tree.current.set(path, renderTextFile({ lines, break: doc.break, endsWithBreak: doc.endsWithBreak }));
  };
}

/** SPEC section 7: parse the whole patch as SEARCH/REPLACE blocks. */
function parseSearchReplace(lines: string[], ctx: RunContext): EditFn[] {
  const edits: EditFn[] = [];
  const n = lines.length;
  let i = 0;
  let prevEnd = 0;
  let prevPath: string | null = null;
  while (i < n) {
    let searchAt = -1;
    for (let k = i; k < n; k++) {
      if ((lines[k] as string).trimEnd() === '<<<<<<< SEARCH') {
        searchAt = k;
        break;
      }
    }
    if (searchAt < 0) break;
    // The path is the nearest line before SEARCH, after the previous
    // block's REPLACE (or the start), that is not blank and does not
    // start with three backticks; the path is that line trimmed.
    let path: string | null = null;
    for (let k = searchAt - 1; k >= prevEnd; k--) {
      const trimmed = (lines[k] as string).trim();
      if (trimmed !== '' && !trimmed.startsWith('```')) {
        path = trimmed;
        break;
      }
    }
    if (path === null) {
      if (prevPath !== null) path = prevPath;
      else throw new ParseFault(`error: parse ${searchAt + 1}`);
    }
    let eqAt = -1;
    for (let k = searchAt + 1; k < n; k++) {
      if ((lines[k] as string).trimEnd() === '=======') {
        eqAt = k;
        break;
      }
    }
    if (eqAt < 0) throw new ParseFault(`error: parse ${searchAt + 1}`);
    let replaceAt = -1;
    for (let k = eqAt + 1; k < n; k++) {
      if ((lines[k] as string).trimEnd() === '>>>>>>> REPLACE') {
        replaceAt = k;
        break;
      }
    }
    if (replaceAt < 0) throw new ParseFault(`error: parse ${searchAt + 1}`);
    edits.push(
      searchReplaceEditFn(path, lines.slice(searchAt + 1, eqAt), lines.slice(eqAt + 1, replaceAt), ctx),
    );
    prevPath = path;
    prevEnd = replaceAt + 1;
    i = replaceAt + 1;
  }
  if (edits.length === 0) throw new ParseFault('error: parse 1');
  return edits;
}

/** SPEC section 8: one chunk of a V4A Update File section. */
interface V4AChunk {
  anchor: string | null;
  endOfFile: boolean;
  body: string[];
}

/** Find the first line at or after `from` equal to the anchor at the first
 * tier where one is (section 5, both sides a single line). */
function findAnchor(lines: string[], anchor: string, from: number, strict: boolean): number | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    for (let i = from; i < lines.length; i++) {
      if (linesEqual(lines[i] as string, anchor, tier)) return i;
    }
  }
  return null;
}

function v4aUpdateEditFn(path: string, moveTo: string | null, chunks: V4AChunk[], ctx: RunContext): EditFn {
  return (tree: WorkTree) => {
    if (!isSafePath(path)) throw new EditFault('unsafe', path);
    if (moveTo !== null && !isSafePath(moveTo)) throw new EditFault('unsafe', moveTo);
    if (tree.hasFileAncestor(path)) throw new EditFault('exists', path);
    const before = tree.read(path);
    if (before === null) throw new EditFault('missing', path);
    if (moveTo !== null && (tree.exists(moveTo) || tree.hasFileAncestor(moveTo))) {
      throw new EditFault('exists', moveTo);
    }
    let doc = parseTextFile(before);
    let cursor = 0;
    for (const chunk of chunks) {
      if (chunk.anchor !== null) {
        const anchorAt = findAnchor(doc.lines, chunk.anchor, cursor, ctx.strict);
        if (anchorAt === null) throw new EditFault('no-match', path);
        cursor = anchorAt + 1;
      }
      const items = chunk.body.map(toBodyLine);
      const { old, replacement } = splitBody(items);
      if (old.length === 0) {
        const at = chunk.endOfFile ? doc.lines.length : cursor;
        const inserted = replacement.map((item) => item.text);
        const lines = [...doc.lines.slice(0, at), ...inserted, ...doc.lines.slice(at)];
        doc = { lines, break: doc.break, endsWithBreak: doc.endsWithBreak };
        cursor = at + inserted.length;
      } else {
        const found = firstTierWith(doc.lines, old, cursor, ctx.strict);
        if (found === null) throw new EditFault('no-match', path);
        let at: number | null = null;
        if (chunk.endOfFile) {
          for (const pos of found.positions) {
            if (pos + old.length === doc.lines.length) {
              at = pos;
              break;
            }
          }
          if (at === null) throw new EditFault('no-match', path);
        } else {
          at = found.positions[0] as number;
        }
        const built = buildReplacement(doc.lines, at, old, replacement, found.tier);
        const lines = [...doc.lines.slice(0, at), ...built, ...doc.lines.slice(at + old.length)];
        doc = { lines, break: doc.break, endsWithBreak: doc.endsWithBreak };
        cursor = at + built.length;
      }
    }
    const text = renderTextFile(doc);
    if (moveTo !== null) {
      tree.current.set(path, null);
      tree.current.set(moveTo, text);
      ctx.moves.push({ old: path, new: moveTo });
    } else {
      tree.current.set(path, text);
    }
  };
}

function v4aAddEditFn(path: string, fileLines: string[]): EditFn {
  return (tree: WorkTree) => {
    if (!isSafePath(path)) throw new EditFault('unsafe', path);
    if (tree.exists(path) || tree.hasFileAncestor(path)) throw new EditFault('exists', path);
    tree.current.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
  };
}

function v4aDeleteEditFn(path: string): EditFn {
  return (tree: WorkTree) => {
    if (!isSafePath(path)) throw new EditFault('unsafe', path);
    if (!tree.isFile(path)) throw new EditFault('missing', path);
    tree.current.set(path, null);
  };
}

/** SPEC section 8: parse the whole patch as a V4A patch. */
function parseV4A(lines: string[], ctx: RunContext): EditFn[] {
  const n = lines.length;
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new ParseFault('error: parse 1');
  if ((lines[first] as string).trim() !== '*** Begin Patch') {
    throw new ParseFault(`error: parse ${first + 1}`);
  }
  let last = -1;
  for (let k = n - 1; k >= 0; k--) {
    if (!isBlank(lines[k] as string)) {
      last = k;
      break;
    }
  }
  if (last < 0 || (lines[last] as string).trim() !== '*** End Patch') {
    throw new ParseFault(`error: parse ${n + 1}`);
  }
  const isSectionStart = (l: string): boolean =>
    l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
  const edits: EditFn[] = [];
  let i = first + 1;
  const end = last;
  while (i < end) {
    const line = lines[i] as string;
    if (isBlank(line)) {
      i++;
      continue;
    }
    if (line.startsWith('*** Add File: ')) {
      const path = line.slice('*** Add File:'.length).trim();
      i++;
      // Collect the section's lines; blank lines at the end of a section
      // (before the next section or *** End Patch) are not part of it.
      const raw: string[] = [];
      while (i < end && !isSectionStart(lines[i] as string)) {
        raw.push(lines[i] as string);
        i++;
      }
      while (raw.length > 0 && isBlank(raw[raw.length - 1] as string)) raw.pop();
      const fileLines: string[] = [];
      for (let k = 0; k < raw.length; k++) {
        const item = raw[k] as string;
        if (item === '') fileLines.push('');
        else if (item.startsWith('+')) fileLines.push(item.slice(1));
        else throw new ParseFault(`error: parse ${i - raw.length + k + 1}`);
      }
      edits.push(v4aAddEditFn(path, fileLines));
      continue;
    }
    if (line.startsWith('*** Delete File: ')) {
      const path = line.slice('*** Delete File:'.length).trim();
      i++;
      edits.push(v4aDeleteEditFn(path));
      continue;
    }
    if (line.startsWith('*** Update File: ')) {
      const updateLine = i;
      const path = line.slice('*** Update File:'.length).trim();
      i++;
      let moveTo: string | null = null;
      if (i < end && (lines[i] as string).startsWith('*** Move to: ')) {
        moveTo = (lines[i] as string).slice('*** Move to:'.length).trim();
        i++;
      }
      const chunks: V4AChunk[] = [];
      let current: V4AChunk | null = null;
      let afterEndOfFile = false;
      const closeChunk = (stripTrailingBlank: boolean): void => {
        if (current === null) return;
        if (stripTrailingBlank) {
          while (current.body.length > 0 && isBlank(current.body[current.body.length - 1] as string)) {
            current.body.pop();
          }
        }
        chunks.push(current);
        current = null;
      };
      while (i < end) {
        const item = lines[i] as string;
        if (isSectionStart(item)) break;
        if (item.startsWith('@@')) {
          closeChunk(false);
          const anchor = item.slice(2).trim();
          current = { anchor: anchor === '' ? null : anchor, endOfFile: false, body: [] };
          afterEndOfFile = false;
          i++;
          continue;
        }
        if (item.trim() === '*** End of File') {
          if (current === null) throw new ParseFault(`error: parse ${i + 1}`);
          current.endOfFile = true;
          closeChunk(false);
          afterEndOfFile = true;
          i++;
          continue;
        }
        if (isBlank(item)) {
          if (afterEndOfFile) {
            i++;
            continue;
          }
          if (current === null) current = { anchor: null, endOfFile: false, body: [] };
          current.body.push(item);
          i++;
          continue;
        }
        if (item[0] === ' ' || item[0] === '-' || item[0] === '+') {
          if (afterEndOfFile) throw new ParseFault(`error: parse ${i + 1}`);
          if (current === null) current = { anchor: null, endOfFile: false, body: [] };
          current.body.push(item);
          i++;
          continue;
        }
        throw new ParseFault(`error: parse ${i + 1}`);
      }
      closeChunk(true);
      if (chunks.length === 0 && moveTo === null) {
        throw new ParseFault(`error: parse ${updateLine + 1}`);
      }
      edits.push(v4aUpdateEditFn(path, moveTo, chunks, ctx));
      continue;
    }
    throw new ParseFault(`error: parse ${i + 1}`);
  }
  if (edits.length === 0) throw new ParseFault('error: parse 1');
  return edits;
}

/** SPEC sections 1, 2 and 10: parse the command line, read and parse the
 * patch, apply the edits to the tree, and report what changed. */
function runCli(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  let positional: string | null = null;
  let ended = false;
  for (const arg of args) {
    if (!ended && arg === '--') {
      ended = true;
      continue;
    }
    if (!ended && arg.startsWith('--format=') && format === null && (FORMAT_NAMES as readonly string[]).includes(arg.slice(9))) {
      format = arg.slice(9);
      continue;
    }
    if (!ended && arg === '--check' && !check) {
      check = true;
      continue;
    }
    if (!ended && arg === '--strict' && !strict) {
      strict = true;
      continue;
    }
    if (!ended && arg.startsWith('-') && arg !== '-') return { code: 2, out: ['error: usage'] };
    if (positional !== null) return { code: 2, out: ['error: usage'] };
    positional = arg;
  }

  let patchText: string;
  if (positional === null || positional === '-') {
    try {
      patchText = readFileSync(0, 'utf8');
    } catch {
      return { code: 2, out: ['error: no-patch'] };
    }
  } else {
    try {
      patchText = readFileSync(positional, 'utf8');
    } catch {
      return { code: 2, out: ['error: no-patch'] };
    }
  }

  const lines = splitPatch(patchText);
  let chosen: string;
  if (format === null || format === 'auto') {
    const detected = detectFormat(lines);
    if (detected === null) return { code: 2, out: ['error: format'] };
    chosen = detected;
  } else {
    chosen = format;
  }

  const ctx: RunContext = { strict, moves: [] };
  let edits: EditFn[];
  try {
    if (chosen === 'unified') edits = parseUnified(lines, ctx);
    else if (chosen === 'search-replace') edits = parseSearchReplace(lines, ctx);
    else if (chosen === 'v4a') edits = parseV4A(lines, ctx);
    else edits = parseJson(lines);
  } catch (e) {
    if (e instanceof ParseFault) return { code: 2, out: [e.line] };
    throw e;
  }

  const tree = new WorkTree();
  const failures: EditFault[] = [];
  for (const edit of edits) {
    const snapshot = new Map(tree.current);
    try {
      edit(tree);
    } catch (e) {
      if (e instanceof EditFault) {
        tree.current.clear();
        for (const [k, v] of snapshot) tree.current.set(k, v);
        failures.push(e);
      } else {
        throw e;
      }
    }
  }
  if (failures.length > 0) {
    const out = failures.map((f) => `error: ${f.code} ${f.path}`);
    out.push(`failed: ${failures.length} of ${edits.length} edits`);
    return { code: 1, out };
  }

  // One line per path whose state changed, in byte order of the paths
  // (UTF-8). A move that succeeded is one R line (sorted by the new path)
  // replacing that pair's D and A lines.
  // A move counts when the old path existed before the patch and not
  // after it, and the new path did not exist before it and does after it.
  // (diskOriginal reads from disk; the tree's `current` holds final state.)
  const moveByNew = new Map<string, string>();
  for (const m of ctx.moves) {
    // original() reads from disk; the tree's `current` holds final state.
    const wasOld = diskOriginal(m.old);
    const nowOld = tree.read(m.old);
    const wasNew = diskOriginal(m.new);
    const nowNew = tree.read(m.new);
    if (wasOld !== null && nowOld === null && wasNew === null && nowNew !== null) {
      moveByNew.set(m.new, m.old);
    }
  }
  const movedOld = new Set<string>(moveByNew.values());
  const rows: Array<{ key: string; line: string }> = [];
  for (const p of tree.current.keys()) {
    const was = diskOriginal(p);
    const now = tree.current.get(p) as string | null;
    if (was === now) continue;
    if (moveByNew.has(p)) {
      rows.push({ key: p, line: `R ${moveByNew.get(p) as string} -> ${p}` });
      continue;
    }
    if (movedOld.has(p)) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key, 'utf8'), Buffer.from(b.key, 'utf8')));
  const changed = rows.length;
  const out = rows.map((r) => r.line);
  out.push(`ok: ${changed} file${changed === 1 ? '' : 's'}`);

  if (!check) {
    // Delete first, then create: a path deleted and recreated in the same
    // patch must end up created, and a parent removed before its child is
    // written must not block the write.
    const deletions: string[] = [];
    const writes: Array<[string, string]> = [];
    for (const [p, v] of tree.current) {
      if (v === null) deletions.push(p);
      else writes.push([p, v]);
    }
    for (const p of deletions) {
      try {
        rmSync(p, { force: true });
      } catch {
        // The file is gone either way.
      }
    }
    for (const [p, v] of writes) {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, v, 'utf8');
    }
  }
  return { code: 0, out };
}

/** Read a file from the disk as it was before the patch ran. Kept apart
 * from the working tree so the output computation can compare before and
 * after without touching the tree's overlay. */
const diskCache = new Map<string, string | null>();
function diskOriginal(p: string): string | null {
  if (!diskCache.has(p)) {
    let value: string | null = null;
    try {
      if (statSync(p).isFile()) value = readFileSync(p, 'utf8');
    } catch {
      value = null;
    }
    diskCache.set(p, value);
  }
  return diskCache.get(p) ?? null;
}

// ---------- Trial hand-over (mandated by the kit) ----------

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const result = runCli(process.argv.slice(2));
  writeSync(1, result.out.map((l) => `${l}\n`).join(''));
  process.exitCode = result.code;
}
