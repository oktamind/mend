// main.ts is mend, the CLI SPEC.md specifies: one patch tool for every AI edit format.
// It reads a patch in unified diff, SEARCH/REPLACE, V4A or JSON form, finds the lines each
// edit names at the first of three matching tiers, and writes every change or none.
// Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: Array<[string, string]> = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/** A file's lines, its line break, and whether it ends with one (SPEC.md section 3). */
interface FileModel {
  lines: string[];
  br: string;
  final: boolean;
}

function splitFile(text: string): FileModel {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function joinFile(m: FileModel): string {
  if (m.lines.length === 0) return '';
  return m.lines.join(m.br) + (m.final ? m.br : '');
}

const stripTrailing = (s: string): string => s.replace(/[ \t]+$/, '');
const stripBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadingWs = (s: string): string => /^[ \t]*/.exec(s)?.[0] ?? '';

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return stripTrailing(a) === stripTrailing(b);
  return stripBoth(a) === stripBoth(b);
}

/** Positions where O occurs in lines at one tier. */
function occurrences(lines: string[], o: string[], tier: number): number[] {
  const out: number[] = [];
  if (o.length === 0 || o.length > lines.length) return out;
  for (let i = 0; i + o.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (!lineEq(lines[i + j]!, o[j]!, tier)) { ok = false; break; }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier (0, then 1, then 2; only 0 when strict) at which O occurs, with its positions. */
function findTier(lines: string[], o: string[], strict: boolean): { tier: number; occ: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = occurrences(lines, o, t);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** One line of N: a context line (its index in O) or a new line (null). */
interface NLine {
  text: string;
  ctx: number | null;
}

/** The lines N writes over a match at `at` (SPEC.md section 5). */
function writeN(lines: string[], at: number, o: string[], n: NLine[], tier: number): string[] {
  const out: string[] = [];
  const f = leadingWs(lines[at] ?? '');
  const p = leadingWs(o[0] ?? '');
  for (const item of n) {
    if (item.ctx !== null) {
      out.push(lines[at + item.ctx]!);
    } else if (tier === 2) {
      const t = item.text;
      out.push(t !== '' && t.trim() !== '' && t.startsWith(p) ? f + t.slice(p.length) : t);
    } else {
      out.push(item.text);
    }
  }
  return out;
}

/** One body line of a unified hunk or a V4A chunk: context, old, new, or a `\` marker line. */
interface BodyEntry {
  kind: 'ctx' | 'del' | 'add' | 'bs';
  text: string;
}

/** Split a hunk/chunk body into its old lines O and its new lines N. */
function splitBody(body: BodyEntry[]): { o: string[]; n: NLine[]; bsAfterLastNew: boolean } {
  const o: string[] = [];
  const n: NLine[] = [];
  let lastNew = -1;
  for (let bi = 0; bi < body.length; bi++) {
    const e = body[bi]!;
    if (e.kind === 'ctx') { o.push(e.text); n.push({ text: e.text, ctx: o.length - 1 }); lastNew = bi; }
    else if (e.kind === 'del') { o.push(e.text); }
    else if (e.kind === 'add') { n.push({ text: e.text, ctx: null }); lastNew = bi; }
  }
  return { o, n, bsAfterLastNew: lastNew >= 0 && body[lastNew + 1]?.kind === 'bs' };
}

/* ------------------------------------------------------------------ */
/* Unified diffs (SPEC.md section 6)                                   */
/* ------------------------------------------------------------------ */

interface Hunk {
  a: number;
  body: BodyEntry[];
}

interface UniWork {
  oldDiff: string | null;
  newDiff: string | null;
  oldPair: string | null;
  newPair: string | null;
  hasPair: boolean;
  renameFrom: string | null;
  renameTo: string | null;
  isCreate: boolean;
  isDelete: boolean;
  hasHunk: boolean;
  hunks: Hunk[];
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const DIFF_RE = /^diff --git a\/(.+) b\/(.+)$/;

function isDiffLine(l: string): boolean {
  return l === 'diff --git' || l.startsWith('diff --git ');
}

/** The path a `--- `/`+++ ` line names, after the prefix section 6 removes; null for `/dev/null`. */
function headerPath(line: string): string | null {
  let t = line.slice(4);
  const tab = t.indexOf('\t');
  if (tab >= 0) t = t.slice(0, tab);
  t = t.trim();
  if (t === '/dev/null') return null;
  if (t.startsWith('a/') || t.startsWith('b/')) return t.slice(2);
  return t;
}

const nullIfDevNull = (p: string | null): string | null => (p === '/dev/null' ? null : p);

/** Apply a section's hunks, in order, to a file's lines (section 6). */
function applyHunks(model: FileModel, hunks: Hunk[], path: string, strict: boolean): void {
  let d = 0;
  for (const h of hunks) {
    const { o, n, bsAfterLastNew } = splitBody(h.body);
    if (o.length === 0) {
      const beforeLen = model.lines.length;
      const at = Math.max(0, Math.min(h.a + d, beforeLen));
      model.lines.splice(at, 0, ...n.map((x) => x.text));
      if (at === beforeLen) model.final = !bsAfterLastNew;
      d += n.length;
    } else {
      const found = findTier(model.lines, o, strict);
      if (found === null) throw new Fail('no-match', path);
      const target = h.a - 1 + d;
      let best = found.occ[0]!;
      let bestDist = Math.abs(best - target);
      for (const pos of found.occ) {
        const dist = Math.abs(pos - target);
        if (dist < bestDist) { best = pos; bestDist = dist; }
      }
      const written = writeN(model.lines, best, o, n, found.tier);
      const runsToEnd = best + o.length === model.lines.length;
      model.lines.splice(best, o.length, ...written);
      if (runsToEnd) model.final = !bsAfterLastNew;
      d += n.length - o.length;
    }
  }
}

function makeUnifiedEdit(s: UniWork, strict: boolean): Edit {
  const oldP = s.hasPair ? s.oldPair : (s.renameFrom !== null ? nullIfDevNull(s.renameFrom) : nullIfDevNull(s.oldDiff));
  const newP = s.hasPair ? s.newPair : (s.renameTo !== null ? nullIfDevNull(s.renameTo) : nullIfDevNull(s.newDiff));
  // SPEC section 6 lists creation before deletion, so a section that could
  // be read either way is a creation; a section naming /dev/null on both
  // sides is a no-op (both branches return without touching the tree).
  const isCreate = s.isCreate || oldP === null;
  const isDelete = !isCreate && (s.isDelete || newP === null);
  return (tree) => {
    if (isCreate) {
      if (newP === null) return;
      if (!safe(newP)) throw new Fail('unsafe', newP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const lines: string[] = [];
      let lastPlusBs = false;
      for (const h of s.hunks) {
        for (let bi = 0; bi < h.body.length; bi++) {
          const e = h.body[bi]!;
          if (e.kind === 'add') {
            lines.push(e.text);
            lastPlusBs = h.body[bi + 1]?.kind === 'bs';
          }
        }
      }
      tree.now.set(newP, lines.length === 0 ? '' : lines.join('\n') + (lastPlusBs ? '' : '\n'));
      return;
    }
    if (isDelete) {
      if (oldP === null) return;
      if (!safe(oldP)) throw new Fail('unsafe', oldP);
      if (tree.get(oldP) === null) throw new Fail('missing', oldP);
      tree.now.set(oldP, null);
      return;
    }
    if (oldP !== null && newP !== null && oldP !== newP) {
      if (!safe(oldP)) throw new Fail('unsafe', oldP);
      if (!safe(newP)) throw new Fail('unsafe', newP);
      const before = tree.get(oldP);
      if (before === null) throw new Fail('missing', oldP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const model = splitFile(before);
      applyHunks(model, s.hunks, oldP, strict);
      tree.now.set(oldP, null);
      tree.now.set(newP, joinFile(model));
      tree.moves.push([oldP, newP]);
      return;
    }
    const p = oldP ?? newP;
    if (p === null) return;
    if (!safe(p)) throw new Fail('unsafe', p);
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    const model = splitFile(before);
    applyHunks(model, s.hunks, p, strict);
    tree.now.set(p, joinFile(model));
  };
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: UniWork[] = [];
  let cur: UniWork | null = null;
  const newWork = (oldDiff: string | null, newDiff: string | null): UniWork => ({
    oldDiff, newDiff, oldPair: null, newPair: null, hasPair: false,
    renameFrom: null, renameTo: null, isCreate: false, isDelete: false, hasHunk: false, hunks: [],
  });
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (isDiffLine(line)) {
      const m = DIFF_RE.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = newWork(m[1]!, m[2]!);
      sections.push(cur);
      i++;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const oldP = headerPath(line);
      const newP = headerPath(lines[i + 1]!);
      // SPEC section 6: a ---/+++ pair starts a section unless it is already
      // part of a section's header. So a pair lands on the current section
      // only while that section has no pair and no hunk yet; a second pair
      // in the same header starts a new section instead of overwriting.
      if (cur !== null && !cur.hasHunk && !cur.hasPair) {
        cur.oldPair = oldP;
        cur.newPair = newP;
        cur.hasPair = true;
      } else {
        cur = newWork(null, null);
        cur.oldPair = oldP;
        cur.newPair = newP;
        cur.hasPair = true;
        sections.push(cur);
      }
      i += 2;
      continue;
    }
    if (line.startsWith('--- ')) {
      if (cur !== null && !cur.hasHunk) throw new Exit2(`error: parse ${i + 2}`);
      i++;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = HUNK_RE.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const a = Number(m[1]);
      i++;
      const body: BodyEntry[] = [];
      while (i < lines.length) {
        const l = lines[i]!;
        if (isDiffLine(l)) break;
        if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (l === '') { body.push({ kind: 'ctx', text: '' }); i++; continue; }
        const c = l[0]!;
        if (c === ' ') { body.push({ kind: 'ctx', text: l.slice(1) }); i++; continue; }
        if (c === '-') { body.push({ kind: 'del', text: l.slice(1) }); i++; continue; }
        if (c === '+') { body.push({ kind: 'add', text: l.slice(1) }); i++; continue; }
        if (c === '\\') { body.push({ kind: 'bs', text: l }); i++; continue; }
        break;
      }
      while (body.length > 0 && body[body.length - 1]!.kind === 'ctx' && body[body.length - 1]!.text === '') body.pop();
      cur.hunks.push({ a, body });
      cur.hasHunk = true;
      continue;
    }
    if (cur !== null && !cur.hasHunk) {
      if (line.startsWith('rename from ')) cur.renameFrom = line.slice(12).trim();
      else if (line.startsWith('rename to ')) cur.renameTo = line.slice(10).trim();
      else if (line.startsWith('new file mode')) cur.isCreate = true;
      else if (line.startsWith('deleted file mode')) cur.isDelete = true;
    }
    i++;
  }
  return sections.map((s) => makeUnifiedEdit(s, strict));
}

/* ------------------------------------------------------------------ */
/* SEARCH/REPLACE blocks (SPEC.md section 7)                           */
/* ------------------------------------------------------------------ */

function makeSearchReplaceEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const model = splitFile(before);
    const found = findTier(model.lines, oldLines, strict);
    if (found === null) throw new Fail('no-match', path);
    if (found.occ.length > 1) throw new Fail('ambiguous', path);
    const written = writeN(model.lines, found.occ[0]!, oldLines, newLines.map((t) => ({ text: t, ctx: null })), found.tier);
    model.lines.splice(found.occ[0]!, oldLines.length, ...written);
    tree.now.set(path, joinFile(model));
  };
}

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevReplaceEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() === '<<<<<<< SEARCH') {
      const searchLine = i + 1;
      let path: string | null = null;
      for (let j = i - 1; j > prevReplaceEnd; j--) {
        const l = lines[j]!;
        if (blank(l)) continue;
        if (l.trim().startsWith('```')) continue;
        path = l.trim();
        break;
      }
      if (path === null) {
        if (prevPath === null) throw new Exit2(`error: parse ${searchLine}`);
        path = prevPath;
      }
      let eq = -1;
      for (let j = i + 1; j < lines.length; j++) {
        if (lines[j]!.trimEnd() === '=======') { eq = j; break; }
      }
      if (eq === -1) throw new Exit2(`error: parse ${searchLine}`);
      let rep = -1;
      for (let j = eq + 1; j < lines.length; j++) {
        if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') { rep = j; break; }
      }
      if (rep === -1) throw new Exit2(`error: parse ${searchLine}`);
      edits.push(makeSearchReplaceEdit(path, lines.slice(i + 1, eq), lines.slice(eq + 1, rep), strict));
      prevPath = path;
      prevReplaceEnd = rep;
      i = rep + 1;
    } else {
      i++;
    }
  }
  return edits;
}

/* ------------------------------------------------------------------ */
/* V4A patches (SPEC.md section 8)                                     */
/* ------------------------------------------------------------------ */

interface V4aChunk {
  anchor: string | null;
  eof: boolean;
  body: BodyEntry[];
}

function findSingleLine(lines: string[], anchor: string, from: number, strict: boolean): number {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    for (let k = from; k < lines.length; k++) {
      if (lineEq(lines[k]!, anchor, t)) return k;
    }
  }
  return -1;
}

function findTierFrom(lines: string[], o: string[], from: number, eof: boolean, strict: boolean): { at: number; tier: number } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    for (const pos of occurrences(lines, o, t)) {
      if (pos < from) continue;
      if (eof && pos + o.length !== lines.length) continue;
      return { at: pos, tier: t };
    }
  }
  return null;
}

function makeV4aAdd(path: string, fileLines: string[]): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
  };
}

function makeV4aDelete(path: string): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.now.set(path, null);
  };
}

function makeV4aUpdate(path: string, moveTo: string | null, chunks: V4aChunk[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const model = splitFile(before);
    let cursor = 0;
    for (const chunk of chunks) {
      if (chunk.anchor !== null) {
        const at = findSingleLine(model.lines, chunk.anchor, cursor, strict);
        if (at === -1) throw new Fail('no-match', path);
        cursor = at + 1;
      }
      const { o, n } = splitBody(chunk.body);
      if (o.length === 0) {
        const at = chunk.eof ? model.lines.length : cursor;
        model.lines.splice(at, 0, ...n.map((x) => x.text));
        cursor = at + n.length;
      } else {
        const found = findTierFrom(model.lines, o, cursor, chunk.eof, strict);
        if (found === null) throw new Fail('no-match', path);
        const written = writeN(model.lines, found.at, o, n, found.tier);
        model.lines.splice(found.at, o.length, ...written);
        cursor = found.at + written.length;
      }
    }
    const out = joinFile(model);
    if (moveTo !== null) {
      tree.now.set(path, null);
      tree.now.set(moveTo, out);
      tree.moves.push([path, moveTo]);
    } else {
      tree.now.set(path, out);
    }
  };
}

function parseV4a(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) { last = k; break; }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  const ADD_P = '*** Add File: ';
  const DEL_P = '*** Delete File: ';
  const UPD_P = '*** Update File: ';
  const MOV_P = '*** Move to: ';
  const isStart = (l: string): boolean => l.startsWith(ADD_P) || l.startsWith(DEL_P) || l.startsWith(UPD_P);
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) { i++; continue; }
    if (line.startsWith(ADD_P)) {
      const path = line.slice(ADD_P.length).trim();
      i++;
      const sec: Array<{ text: string; num: number }> = [];
      while (i < last && !isStart(lines[i]!)) { sec.push({ text: lines[i]!, num: i + 1 }); i++; }
      while (sec.length > 0 && blank(sec[sec.length - 1]!.text)) sec.pop();
      const fileLines: string[] = [];
      for (const e of sec) {
        if (e.text === '') fileLines.push('');
        else if (e.text.startsWith('+')) fileLines.push(e.text.slice(1));
        else throw new Exit2(`error: parse ${e.num}`);
      }
      edits.push(makeV4aAdd(path, fileLines));
      continue;
    }
    if (line.startsWith(DEL_P)) {
      edits.push(makeV4aDelete(line.slice(DEL_P.length).trim()));
      i++;
      continue;
    }
    if (line.startsWith(UPD_P)) {
      const path = line.slice(UPD_P.length).trim();
      const updLine = i + 1;
      i++;
      const sec: Array<{ text: string; num: number }> = [];
      while (i < last && !isStart(lines[i]!)) { sec.push({ text: lines[i]!, num: i + 1 }); i++; }
      while (sec.length > 0 && blank(sec[sec.length - 1]!.text)) sec.pop();
      let moveTo: string | null = null;
      let j = 0;
      if (j < sec.length && sec[j]!.text.startsWith(MOV_P)) {
        moveTo = sec[j]!.text.slice(MOV_P.length).trim();
        j++;
      }
      const chunks: V4aChunk[] = [];
      let cur: V4aChunk | null = null;
      while (j < sec.length) {
        const e = sec[j]!;
        const l = e.text;
        if (l === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${e.num}`);
          cur.eof = true;
          cur = null;
          j++;
          continue;
        }
        if (l.startsWith('@@')) {
          const anchor = l.slice(2).trim();
          cur = { anchor: anchor === '' ? null : anchor, eof: false, body: [] };
          chunks.push(cur);
          j++;
          continue;
        }
        if (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+')) {
          if (cur === null) {
            if (chunks.length > 0) throw new Exit2(`error: parse ${e.num}`);
            cur = { anchor: null, eof: false, body: [] };
            chunks.push(cur);
          }
          if (l === '') cur.body.push({ kind: 'ctx', text: '' });
          else if (l.startsWith(' ')) cur.body.push({ kind: 'ctx', text: l.slice(1) });
          else if (l.startsWith('-')) cur.body.push({ kind: 'del', text: l.slice(1) });
          else cur.body.push({ kind: 'add', text: l.slice(1) });
          j++;
          continue;
        }
        throw new Exit2(`error: parse ${e.num}`);
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updLine}`);
      edits.push(makeV4aUpdate(path, moveTo, chunks, strict));
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  return edits;
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines, strict);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else edits = parseV4a(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesLen = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesLen;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rows: Array<{ key: string; text: string }> = [];
  const usedOld = new Set<string>();
  const usedNew = new Set<string>();
  for (const [oldP, newP] of tree.moves) {
    if (usedOld.has(oldP) || usedNew.has(newP)) continue;
    if (tree.original(oldP) !== null && tree.get(oldP) === null && tree.original(newP) === null && tree.get(newP) !== null) {
      rows.push({ key: newP, text: `R ${oldP} -> ${newP}` });
      usedOld.add(oldP);
      usedNew.add(newP);
    }
  }
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (usedOld.has(p) || usedNew.has(p)) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  if (!check) {
    for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  return { code: 0, out: [...rows.map((r) => r.text), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
