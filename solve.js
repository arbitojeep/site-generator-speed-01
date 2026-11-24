// Fast site generator: a faster drop-in for makefun-site 1.0.0.
//
// Written from the spec in the kit (baseline README.md: front matter, template
// dialect, Markdown subset, slug rule, report) with the reference code as the
// arbiter wherever the two differ. Same answers as makefun-site 1.0.0 for every
// input, byte for byte — just faster: single-pass scans instead of a regex per
// line, chunked inline rendering with a fast path for plain text, templates
// compiled once per case into flat op lists and rendered into a chunk array,
// words counted while the body is scanned, cards computed once per page.
//
// Entry: solve.js (ES module) exports run(input); main.ts drives it.

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const RESERVED = ['posts', 'tags', 'page'];
const INCLUDE_DEPTH = 8;

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_RE = /[&<>"']/g;

/** `text` with & < > " and ' escaped (README.md, "Text"). */
function escapeHtml(text) {
  ESC_RE.lastIndex = 0;
  let m;
  let last = 0;
  let out = '';
  let found = false;
  while ((m = ESC_RE.exec(text)) !== null) {
    found = true;
    if (m.index > last) out += text.slice(last, m.index);
    out += ESCAPES[m[0]];
    last = m.index + 1;
  }
  if (!found) return text;
  if (last < text.length) out += text.slice(last);
  return out;
}

/** Whether code unit `c` is JavaScript whitespace (what \s matches). */
function isWS(c) {
  return c === 32 || c === 9 || c === 10 || c === 11 || c === 12 || c === 13 ||
    c === 0xA0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200A) || c === 0x2028 || c === 0x2029 ||
    c === 0x202F || c === 0x205F || c === 0x3000 || c === 0xFEFF;
}

/** The slug of `text` (README.md, "Text"). ASCII input takes a fast path: NFKD is
 *  the identity on ASCII and there are no combining marks to drop. */
function slugify(text) {
  let ascii = true;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 127) { ascii = false; break; }
  }
  if (ascii) {
    let out = '';
    let gap = false;
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      let keep = -1;
      if (c >= 65 && c <= 90) keep = c + 32;
      else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) keep = c;
      if (keep === -1) { gap = out.length > 0; continue; }
      if (gap) out += '-';
      gap = false;
      out += String.fromCharCode(keep);
    }
    out = out.slice(0, 64);
    let e = out.length;
    while (e > 0 && out.charCodeAt(e - 1) === 45) e--;
    out = out.slice(0, e);
    return out === '' ? 'untitled' : out;
  }
  const plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
  let out = '';
  let gap = false;
  for (const ch of plain) {
    let keep = null;
    if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
    else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
    if (keep === null) { gap = out.length > 0; continue; }
    if (gap) out += '-';
    gap = false;
    out += keep;
  }
  out = out.slice(0, 64).replace(/-+$/, '');
  return out === '' ? 'untitled' : out;
}

/** `slug` made unique against `taken` (and added to it). */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

/** A YYYY-MM-DD date in words, from the string alone. */
function longDate(date) {
  return `${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`;
}

/** Whether `line` is blank (spaces and tabs only). */
function isBlank(line) {
  for (let j = 0; j < line.length; j++) {
    const c = line.charCodeAt(j);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** `line` with spaces and tabs dropped at both ends. */
function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  return line.slice(a, b);
}

/** The words of `line`: its runs of characters other than whitespace. */
function countWords(line) {
  let n = 0;
  let inWord = false;
  for (let j = 0; j < line.length; j++) {
    if (isWS(line.charCodeAt(j))) inWord = false;
    else if (!inWord) { n++; inWord = true; }
  }
  return n;
}

// ---------------------------------------------------------------- front matter
// The 7 known keys (README.md, "Front matter"). Values are a bare string, a
// double-quoted string with \" and \\ escapes, a date, a comma-separated list
// of tags, a boolean, or a layout/template name.

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TAG_RE = /^[^"[\]]+$/;
const LAYOUT_RE = /^[a-z0-9-]+$/;
const SLUG_VALUE_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const KEYS = new Set(['title', 'summary', 'date', 'tags', 'draft', 'layout', 'slug']);

/** The days of month `m` (1-12) of year `y`, by the Gregorian rule. */
function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** Parse `raw` as the value of a quoted string (README.md: quotes take
 *  \" and \\, and nothing else; a stray quote inside is an error). */
function stringOf(raw) {
  if (!raw.startsWith('"')) {
    if (raw.startsWith('[')) return { error: 'a bare string opens on [' };
    return { value: raw };
  }
  if (raw.length < 2 || !raw.endsWith('"')) return { error: 'a quoted string is not closed' };
  let out = '';
  for (let i = 1; i < raw.length - 1; i++) {
    const c = raw[i];
    if (c === '\\') {
      const n = raw[i + 1];
      if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
      out += n;
      i++;
      continue;
    }
    if (c === '"') return { error: 'a quoted string holds a stray quote' };
    out += c;
  }
  return { value: out };
}

/** Parse `raw` as the value of key `key`. */
function valueOf(key, raw) {
  if (key === 'title' || key === 'summary') {
    const s = stringOf(raw);
    return s.error === undefined ? s : { error: `key "${key}": ${s.error}` };
  }
  if (key === 'date') {
    const m = DATE_RE.exec(raw);
    const y = m === null ? 0 : Number(m[1]);
    const mo = m === null ? 0 : Number(m[2]);
    const d = m === null ? 0 : Number(m[3]);
    if (m === null || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
    return { value: raw };
  }
  if (key === 'tags') {
    if (!raw.startsWith('[') || !raw.endsWith(']')) return { error: 'key "tags": not a list [a, b]' };
    const inner = raw.slice(1, -1);
    if (inner.trim() === '') return { value: [] };
    const tags = inner.split(',').map((t) => t.trim());
    for (const t of tags) {
      if (t === '' || !TAG_RE.test(t)) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
    }
    return { value: tags };
  }
  if (key === 'draft') {
    if (raw === 'true') return { value: true };
    if (raw === 'false') return { value: false };
    return { error: 'key "draft": true or false' };
  }
  if (key === 'layout') {
    if (!LAYOUT_RE.test(raw)) return { error: 'key "layout": not a template name' };
    return { value: raw };
  }
  // slug: the raw value itself must be a slug (at most 64 characters).
  if (!SLUG_VALUE_RE.test(raw) || raw.length > 64) return { error: 'key "slug": not a slug' };
  return { value: raw };
}

/** The front matter of `lines` (a file's lines, newlines already normalized):
 *  { data, close } on success, { error } on refusal. */
function parseFrontMatter(lines) {
  if (lines[0] !== '---') return { error: 'no front matter' };
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') { close = i; break; }
  }
  if (close === -1) return { error: 'the front matter is not closed' };
  const data = {};
  for (let i = 1; i < close; i++) {
    const line = lines[i];
    if (isBlank(line) || line.charCodeAt(0) === 35) continue;
    const c = line.indexOf(':');
    if (c < 1) return { error: `line ${i + 1} is not "key: value"` };
    let keyOk = true;
    for (let j = 0; j < c; j++) {
      const ch = line.charCodeAt(j);
      if (!((ch >= 97 && ch <= 122) || ch === 95)) { keyOk = false; break; }
    }
    if (!keyOk) return { error: `line ${i + 1} is not "key: value"` };
    const key = line.slice(0, c);
    let raw;
    if (c === line.length - 1) raw = '';
    else if (line.charCodeAt(c + 1) === 32) raw = line.slice(c + 2);
    else return { error: `line ${i + 1} is not "key: value"` };
    let end = raw.length;
    while (end > 0 && (raw.charCodeAt(end - 1) === 32 || raw.charCodeAt(end - 1) === 9)) end--;
    raw = raw.slice(0, end);
    if (!KEYS.has(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = valueOf(key, raw);
    if (v.error !== undefined) return { error: v.error };
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, close };
}

// ------------------------------------------------------------------ Markdown
// The Markdown subset (README.md, "Markdown"): fences, headings, hr,
// blockquotes, flat lists, paragraphs, and inline escapes, code spans,
// strong, emphasis, links. Rendered in one pass over the body lines; the
// excerpt is the first paragraph's HTML and the table of contents gathers
// level 2 and 3 headings in order.

const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);

/** Find `what` at or after `from`, skipping escaped characters. */
function findUnescaped(s, what, from) {
  for (let j = from; j <= s.length - what.length; j++) {
    if (s[j] === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) { j++; continue; }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** Find a single `*` at or after `from`, skipping escapes and `**`. */
function findSingleStar(s, from) {
  for (let j = from; j < s.length; j++) {
    const c = s[j];
    if (c === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) { j++; continue; }
    if (c !== '*') continue;
    if (s[j + 1] === '*') { j++; continue; }
    return j;
  }
  return -1;
}

const LINK_TARGET_WS_RE = /\s/;
const INLINE_MARK_RE = /[\\`*\[&<>"']/;

/** Render inline Markdown. Plain runs (no marker) are escaped in bulk;
 *  each construct is found by a cheap scan from its opener. */
function inline(s, link) {
  // Fast path: no backslash escape, code span, strong/emphasis, link or HTML
  // character anywhere — the text is already its own rendering.
  if (!INLINE_MARK_RE.test(s)) return s;
  let out = '';
  let runStart = 0;
  let i = 0;
  const n = s.length;
  while (i < n) {
    const c = s[i];
    if (c === '\\' && i + 1 < n && ESCAPABLE.has(s[i + 1])) {
      if (i > runStart) out += escapeHtml(s.slice(runStart, i));
      out += escapeHtml(s[i + 1]);
      i += 2;
      runStart = i;
      continue;
    }
    if (c === '`') {
      const j = s.indexOf('`', i + 1);
      if (j > i + 1) {
        if (i > runStart) out += escapeHtml(s.slice(runStart, i));
        out += '<code>' + escapeHtml(s.slice(i + 1, j)) + '</code>';
        i = j + 1;
        runStart = i;
      } else {
        i++;
      }
      continue;
    }
    if (c === '*') {
      if (s[i + 1] === '*') {
        const j = findUnescaped(s, '**', i + 2);
        if (j > i + 2) {
          if (i > runStart) out += escapeHtml(s.slice(runStart, i));
          out += '<strong>' + inline(s.slice(i + 2, j), link) + '</strong>';
          i = j + 2;
          runStart = i;
        } else {
          i += 2;
        }
        continue;
      }
      const j = findSingleStar(s, i + 1);
      if (j > i + 1) {
        if (i > runStart) out += escapeHtml(s.slice(runStart, i));
        out += '<em>' + inline(s.slice(i + 1, j), link) + '</em>';
        i = j + 1;
        runStart = i;
      } else {
        i++;
      }
      continue;
    }
    if (c === '[') {
      const k = findUnescaped(s, ']', i + 1);
      const m = (k !== -1 && s[k + 1] === '(') ? s.indexOf(')', k + 2) : -1;
      const target = m === -1 ? '' : s.slice(k + 2, m);
      if (target !== '' && !LINK_TARGET_WS_RE.test(target)) {
        if (i > runStart) out += escapeHtml(s.slice(runStart, i));
        out += '<a href="' + escapeHtml(link(target)) + '">' + inline(s.slice(i + 1, k), link) + '</a>';
        i = m + 1;
        runStart = i;
      } else {
        i++;
      }
      continue;
    }
    i++;
  }
  if (n > runStart) out += escapeHtml(s.slice(runStart, n));
  return out;
}

/** The fence language of a fence-opening line, or null. */
function fenceOpen(line) {
  if (!line.startsWith('```')) return null;
  let j = 3;
  while (j < line.length) {
    const c = line.charCodeAt(j);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45) j++;
    else break;
  }
  const lang = line.slice(3, j);
  while (j < line.length && (line.charCodeAt(j) === 32 || line.charCodeAt(j) === 9)) j++;
  if (j !== line.length) return null;
  return lang;
}

/** Whether `line` closes a fence (``` and then only spaces/tabs). */
function isFenceClose(line) {
  if (!line.startsWith('```')) return false;
  for (let j = 3; j < line.length; j++) {
    const c = line.charCodeAt(j);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** The heading depth and text of `line`, or null. */
function headingOf(line) {
  let k = 0;
  while (k < line.length && line.charCodeAt(k) === 35) k++;
  if (k === 0 || k > 6) return null;
  if (k >= line.length || (line.charCodeAt(k) !== 32 && line.charCodeAt(k) !== 9)) return null;
  let j = k;
  while (j < line.length && (line.charCodeAt(j) === 32 || line.charCodeAt(j) === 9)) j++;
  let end = line.length;
  while (end > j && (line.charCodeAt(end - 1) === 32 || line.charCodeAt(end - 1) === 9)) end--;
  if (end === j) return null;
  return { depth: k, text: line.slice(j, end) };
}

/** Whether `line` is a horizontal rule (--- or *** then only spaces/tabs). */
function isHR(line) {
  if (!line.startsWith('---') && !line.startsWith('***')) return false;
  for (let j = 3; j < line.length; j++) {
    const c = line.charCodeAt(j);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** Whether `line` starts a bullet item, and its text. */
function bulletOf(line) {
  const c = line.charCodeAt(0);
  if ((c === 45 || c === 42) && line.charCodeAt(1) === 32) return line.slice(2);
  return null;
}

/** Whether `line` starts an ordered item: its number and text. */
function orderedOf(line) {
  let j = 0;
  while (j < line.length && line.charCodeAt(j) >= 48 && line.charCodeAt(j) <= 57) j++;
  if (j === 0 || j > 9) return null;
  if (line.charCodeAt(j) !== 46 || line.charCodeAt(j + 1) !== 32) return null;
  return { num: line.slice(0, j), rest: line.slice(j + 2) };
}

/** Whether `line` continues a list item (two or more spaces, then a
 *  non-whitespace character). */
function isContinued(line) {
  let j = 0;
  while (j < line.length && line.charCodeAt(j) === 32) j++;
  return j >= 2 && j < line.length && !isWS(line.charCodeAt(j));
}

/** Whether `line` ends a paragraph. */
function endsParagraph(line) {
  return isBlank(line) || fenceOpen(line) !== null || headingOf(line) !== null || isHR(line);
}

/** Render the body (`lines` from `start`) into { html, toc, excerpt, words }. */
function renderMarkdown(lines, start, link) {
  const ids = new Set();
  const out = [];
  const toc = [];
  let excerpt = null;
  let words = 0;
  const n = lines.length;
  let i = start;
  while (i < n) {
    const line = lines[i];
    words += countWords(line);
    if (isBlank(line)) { i++; continue; }
    const fence = fenceOpen(line);
    if (fence !== null) {
      const body = [];
      i++;
      while (i < n && !isFenceClose(lines[i])) { words += countWords(lines[i]); body.push(lines[i++]); }
      if (i < n) words += countWords(lines[i]); // the closing fence line: ``` is a word
      i++;
      const cls = fence === '' ? '' : ` class="language-${escapeHtml(fence)}"`;
      let code = '';
      for (const l of body) code += escapeHtml(l) + '\n';
      out.push(`<pre><code${cls}>${code}</code></pre>\n`);
      continue;
    }
    const hd = headingOf(line);
    if (hd !== null) {
      const id = uniqueSlug(slugify(hd.text), ids);
      const html = inline(hd.text, link);
      out.push(`<h${hd.depth} id="${id}">${html}</h${hd.depth}>\n`);
      if (hd.depth === 2 || hd.depth === 3) toc.push({ level: hd.depth, id, html });
      i++;
      continue;
    }
    if (isHR(line)) { out.push('<hr>\n'); i++; continue; }
    if (line.charCodeAt(0) === 62) {
      const body = [line.length > 1 && line.charCodeAt(1) === 32 ? line.slice(2) : line.slice(1)];
      i++;
      while (i < n && lines[i].charCodeAt(0) === 62) {
        const l = lines[i++];
        words += countWords(l);
        body.push(l.length > 1 && l.charCodeAt(1) === 32 ? l.slice(2) : l.slice(1));
      }
      const text = body.map(trimLine).filter((l) => l !== '').join('\n');
      if (text === '') out.push('<blockquote>\n</blockquote>\n');
      else out.push(`<blockquote>\n<p>${inline(text, link)}</p>\n</blockquote>\n`);
      continue;
    }
    const bullet = bulletOf(line);
    const ordered = bullet === null ? orderedOf(line) : null;
    if (bullet !== null || ordered !== null) {
      const isOrdered = ordered !== null;
      const items = [];
      let startNum = 1;
      if (isOrdered) {
        startNum = Number(ordered.num);
        items.push([trimLine(ordered.rest)]);
        i++;
        while (i < n) {
          const m = orderedOf(lines[i]);
          if (m !== null) { words += countWords(lines[i]); items.push([trimLine(m.rest)]); i++; }
          else if (isContinued(lines[i])) { words += countWords(lines[i]); items[items.length - 1].push(trimLine(lines[i])); i++; }
          else break;
        }
      } else {
        items.push([trimLine(bullet)]);
        i++;
        while (i < n) {
          const m = bulletOf(lines[i]);
          if (m !== null) { words += countWords(lines[i]); items.push([trimLine(m)]); i++; }
          else if (isContinued(lines[i])) { words += countWords(lines[i]); items[items.length - 1].push(trimLine(lines[i])); i++; }
          else break;
        }
      }
      const tag = isOrdered ? 'ol' : 'ul';
      const open = isOrdered && startNum !== 1 ? `<ol start="${startNum}">` : `<${tag}>`;
      let s = open + '\n';
      for (const item of items) s += `<li>${inline(item.join('\n'), link)}</li>\n`;
      s += `</${tag}>\n`;
      out.push(s);
      continue;
    }
    const body = [trimLine(line)];
    i++;
    while (i < n && !endsParagraph(lines[i])) { words += countWords(lines[i]); body.push(trimLine(lines[i++])); }
    const html = inline(body.join('\n'), link);
    if (excerpt === null) excerpt = html;
    out.push(`<p>${html}</p>\n`);
  }
  return { html: out.join(''), toc, excerpt: excerpt ?? '', words };
}

// ----------------------------------------------------------------- Templates
// The template dialect (README.md, "Templates"): {{ path }} escaped,
// {{{ path }}} raw, {% for name in path %}, {% if [not] path %}, {% else %},
// {% include "name" %}, {% endif %}, {% endfor %}. Templates compile once per
// case into flat op lists: ['t', text] ['v', path] ['r', path]
// ['f', name, path, body] ['i', not, path, then, else] ['n', name].
// An include counts its own depth; a missing include renders nothing.

class TemplateError extends Error {}

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** Split `src` into tokens, honoring the standalone-tag rule: a {% tag %}
 *  that is the only thing on its line, spaces aside, eats the whole line. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) { text += src.slice(i); break; }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') { text += src.slice(i, open + 1); i = open + 1; continue; }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** Compile `src` into op lists, or throw a TemplateError. */
function parseTemplate(name, src) {
  const root = [];
  const stack = [{ k: 'root', body: root }];
  let body = root;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') { body.push(['t', tok.text]); continue; }
    if (tok.t === 'var' || tok.t === 'raw') { body.push([tok.t === 'var' ? 'v' : 'r', tok.path]); continue; }
    const tag = tok.tag;
    const top = stack[stack.length - 1];
    let m;
    if ((m = FOR_RE.exec(tag)) !== null) {
      const node = ['f', m[1], pathOf(name, m[2]), []];
      body.push(node);
      stack.push({ k: 'for', node });
      body = node[3];
    } else if ((m = IF_RE.exec(tag)) !== null) {
      const node = ['i', m[1] !== undefined, pathOf(name, m[2]), [], null];
      body.push(node);
      stack.push({ k: 'if', node });
      body = node[3];
    } else if (tag === 'else') {
      if (top.k !== 'if' || top.node[4] !== null) throw new TemplateError(`template "${name}": an else outside an if`);
      top.node[4] = [];
      body = top.node[4];
    } else if (tag === 'endfor' || tag === 'endif') {
      const want = tag === 'endfor' ? 'for' : 'if';
      if (top.k !== want) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
      stack.pop();
      const parent = stack[stack.length - 1];
      body = parent.k === 'root' ? parent.body : parent.k === 'for' ? parent.node[3] : (parent.node[4] ?? parent.node[3]);
    } else if ((m = INCLUDE_RE.exec(tag)) !== null) {
      body.push(['n', m[1]]);
    } else {
      throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].k} is not closed`);
  return root;
}

/** Look `path` up through the scope chain (a name shadows outer scopes). */
function lookup(scope, path) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s.vars, path[0])) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** `v` as text (README.md, "Templates": the value of a variable). */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** The truth of `v` (README.md: a value is false only when it is missing,
 *  null, false, 0, an empty string or an empty array). */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/** Render `nodes` into `out` (an array of chunks). */
function renderNodes(nodes, scope, templates, depth, out) {
  for (let ni = 0; ni < nodes.length; ni++) {
    const n = nodes[ni];
    switch (n[0]) {
      case 't': out.push(n[1]); break;
      case 'v': out.push(escapeHtml(textOf(lookup(scope, n[1])))); break;
      case 'r': out.push(textOf(lookup(scope, n[1]))); break;
      case 'i': {
        const branch = truthy(lookup(scope, n[2])) !== n[1] ? n[3] : n[4];
        if (branch !== null) renderNodes(branch, scope, templates, depth, out);
        break;
      }
      case 'f': {
        const xs = lookup(scope, n[2]);
        if (!Array.isArray(xs)) break;
        const len = xs.length;
        for (let k = 0; k < len; k++) {
          const vars = { [n[1]]: xs[k], loop: { index: k + 1, first: k === 0, last: k === len - 1, length: len } };
          renderNodes(n[3], { vars, parent: scope }, templates, depth, out);
        }
        break;
      }
      case 'n': {
        const t = templates.get(n[1]);
        if (t !== undefined && depth < INCLUDE_DEPTH) renderNodes(t, scope, templates, depth + 1, out);
        break;
      }
    }
  }
}

// ---------------------------------------------------------------------- build
// The pipeline (README.md, "Build order"): sources sorted by path; front
// matter first (refusals recorded, in order); permalinks; Markdown; then
// collections, tags, layouts; and the report.

function dirOf(path) {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i);
}

function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  const segs = rel.split('/');
  for (const seg of segs) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

const SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]*:/;

function byCodeUnits(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function run(input) {
  // Templates are parsed in name order; a parse failure is a report line
  // and the template is simply missing from then on.
  const templates = new Map();
  const report = [];
  const names = Object.keys(input.templates).sort();
  for (const name of names) {
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (err instanceof TemplateError) report.push(err.message);
      else throw err;
    }
  }

  const base = input.site.base_url.replace(/\/+$/, '');

  // Sources sorted by path, code-unit order; front matter; refusals recorded.
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) {
      sources.push({ path: f.path, lines: f.content.replace(/\r\n?/g, '\n').split('\n') });
    } else statics.push(f);
  }
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.lines);
    if (fm.error !== undefined) { report.push(`refused ${s.path}: ${fm.error}`); continue; }
    s.data = fm.data;
    s.bodyStart = fm.close + 1;
    s.post = s.path.startsWith('posts/');
    const own = RESERVED.find((d) => d !== 'posts' && s.path.startsWith(`${d}/`));
    if (own !== undefined) { report.push(`refused ${s.path}: ${own}/ is the generator's own`); continue; }
    if (s.post && !Object.hasOwn(s.data, 'date')) { report.push(`refused ${s.path}: a post needs a date`); continue; }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) { report.push(`refused ${s.path}: layout "${layout}" is no template that parses`); continue; }
    s.layout = layout;
    if (s.data.draft === true) { report.push(`draft ${s.path}`); continue; }
    kept.push(s);
  }

  // Permalinks: unique slugs per directory; the root directory's reserved
  // names are its own, so a root page can never take them.
  const taken = new Map();
  const bySource = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    s.slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), set);
    s.outDir = dir === '' ? s.slug : `${dir}/${s.slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // Markdown, with links resolved against the kept sources and the static
  // files (a link to anything else is recorded once and left as written).
  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();
  for (const s of kept) {
    const dir = dirOf(s.path);
    const link = (target) => {
      if (SCHEME_RE.test(target) || target.startsWith('/') || target.startsWith('#')) return target;
      const hash = target.indexOf('#');
      const rel = hash === -1 ? target : target.slice(0, hash);
      const frag = hash === -1 ? '' : target.slice(hash);
      const path = rel === '' ? null : resolvePath(dir, rel);
      if (path !== null && bySource.has(path)) return bySource.get(path).url + frag;
      if (path !== null && staticPaths.has(path)) return `${base}/${path}${frag}`;
      broken.add(`broken-link ${s.path} -> ${target}`);
      return target;
    };
    const md = renderMarkdown(s.lines, s.bodyStart, link);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
    s.words = md.words;
  }

  // Collections: posts newest first, ties by slug; tags by count then slug.
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  for (let k = 0; k < posts.length; k++) {
    posts[k].newer = k === 0 ? null : posts[k - 1];
    posts[k].older = k === posts.length - 1 ? null : posts[k + 1];
  }
  const bySlug = new Map();
  for (const p of posts) {
    p.tagRefs = [];
    const seen = new Set();
    for (const name of (p.data.tags ?? [])) {
      const slug = slugify(name);
      if (seen.has(slug)) continue;
      seen.add(slug);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) {
    if (s.post) continue;
    s.tagRefs = [];
    const seen = new Set();
    for (const name of (s.data.tags ?? [])) {
      const slug = slugify(name);
      if (seen.has(slug)) continue;
      seen.add(slug);
      s.tagRefs.push(bySlug.get(slug) ?? { name, slug, url: '', posts: [] });
    }
  }
  const tags = [...bySlug.values()].sort((x, y) => (y.posts.length - x.posts.length) || byCodeUnits(x.slug, y.slug));

  // Layouts.
  const cardOf = (s) => {
    if (s.card !== undefined) return s.card;
    const c = {
      title: s.data.title,
      url: s.url,
      date: s.data.date ?? '',
      date_long: s.data.date === undefined ? '' : longDate(s.data.date),
      summary: s.data.summary ?? '',
      excerpt: s.excerpt,
      reading_minutes: Math.max(1, Math.ceil(s.words / 200)),
      tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
    };
    s.card = c;
    return c;
  };
  const linkOf = (s) => s === null ? null : {
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
  };
  const pageOf = (s) => ({
    ...cardOf(s),
    slug: s.slug,
    content: s.html,
    toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  });
  const cards = new Map();
  for (const p of posts) cards.set(p, cardOf(p));
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const render = (name, vars) => {
    const nodes = templates.get(name);
    if (nodes === undefined) return null;
    const out = [];
    renderNodes(nodes, { vars: { site, tags: allTags, recent, ...vars }, parent: null }, templates, 0, out);
    return out.join('');
  };

  const output = {};
  for (const s of kept) output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s) });
  // The index is paginated: per_page posts a page, page 1 at index.html and
  // the rest under page/<n>/, each with its pager record.
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', { tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) } });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  const lines = [...report, ...broken].sort();
  const pageCount = kept.filter((s) => !s.post).length;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = `${lines.join('\n')}\n`;
  return output;
}
