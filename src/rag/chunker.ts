/**
 * Markdown chunker.
 *
 * Chunking algorithm for Markdown documents, with H1/H2 section awareness:
 *
 * 1. The document is split into a preamble (text before the first heading) and
 *    sections, one per H1 (`# `) / H2 (`## `) heading. Deeper headings (H3+) do
 *    not start a new section; they stay inside the enclosing one.
 * 2. Each section is packed greedily into chunks of at most `maxChars` characters,
 *    using paragraphs (blank-line separated blocks) as the atomic unit. A part that
 *    alone exceeds `maxChars` is hard-split so no chunk ever grows far beyond the limit.
 * 3. If `overlap > 0`, every chunk after the first starts with the last `overlap`
 *    characters of the previous chunk, providing cross-chunk context for retrieval.
 */

export interface Chunk {
  text: string;
  heading?: string;
  level?: 1 | 2;
}

export interface ChunkOptions {
  /** Maximum target size per chunk in characters (default 800). */
  maxChars?: number;
  /** Characters repeated from the end of the previous chunk at the start of the next one (default 100). */
  overlap?: number;
}

const DEFAULT_MAX_CHARS = 800;
const DEFAULT_OVERLAP = 100;

interface Section {
  heading: string;
  level: 1 | 2;
  body: string;
}

/** Matches an H1 (`# `) or H2 (`## `) ATX heading line. H3+ and non-heading lines return null. */
function headingMatch(line: string): { heading: string; level: 1 | 2 } | null {
  const h1 = /^#\s+(.+)$/.exec(line);
  if (h1 !== null) return { heading: h1[1]!.trim(), level: 1 };
  const h2 = /^##\s+(.+)$/.exec(line);
  if (h2 !== null) return { heading: h2[1]!.trim(), level: 2 };
  return null;
}

/** Splits the document into a preamble plus one section per H1/H2 heading. */
function splitSections(text: string): { preamble: string; sections: Section[] } {
  const lines = text.split('\n');

  let firstHeadingLine = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line !== undefined && headingMatch(line) !== null) {
      firstHeadingLine = i;
      break;
    }
  }

  const preamble = firstHeadingLine === -1 ? text : lines.slice(0, firstHeadingLine).join('\n');

  const sections: Section[] = [];
  let current: Section | null = null;
  for (const line of lines) {
    const m = headingMatch(line);
    if (m !== null) {
      current = { ...m, body: '' };
      sections.push(current);
    } else if (current !== null) {
      current.body = current.body === '' ? line : `${current.body}\n${line}`;
    }
  }

  return { preamble, sections };
}

/** Splits a text into paragraphs (blocks separated by one or more blank lines). */
function toParagraphs(text: string): string[] {
  return text
    .split(/\n{2,}/g)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Hard-splits a part that alone exceeds `maxChars` into fixed-size pieces. */
function splitOversized(part: string, maxChars: number): string[] {
  if (part.length <= maxChars) return [part];
  const pieces: string[] = [];
  for (let i = 0; i < part.length; i += maxChars) {
    pieces.push(part.slice(i, i + maxChars));
  }
  return pieces;
}

/**
 * Greedily packs parts into chunks of at most `maxChars` characters, keeping
 * parts intact. A part that does not fit starts a new chunk; the previous one
 * is flushed first.
 */
function packParts(parts: string[], maxChars: number): string[] {
  const chunks: string[] = [];
  let current = '';
  for (const part of parts) {
    if ((current + '\n\n' + part).length > maxChars) {
      if (current !== '') chunks.push(current);
      current = part;
    } else {
      current = current === '' ? part : `${current}\n\n${part}`;
    }
  }
  if (current !== '') chunks.push(current);
  return chunks;
}

/**
 * Splits a Markdown document into chunks.
 *
 * Pure function, string ops only. Returns `[]` for empty/whitespace input.
 */
export function chunkMarkdown(text: string, opts: ChunkOptions = {}): Chunk[] {
  if (!text.trim()) return [];

  const maxChars = Math.max(1, opts.maxChars ?? DEFAULT_MAX_CHARS);
  const overlap = Math.max(0, opts.overlap ?? DEFAULT_OVERLAP);

  const { preamble, sections } = splitSections(text);

  const logical: Chunk[] = [];

  for (const chunkText of packParts(toParagraphs(preamble).flatMap((p) => splitOversized(p, maxChars)), maxChars)) {
    logical.push({ text: chunkText });
  }

  for (const section of sections) {
    const body = section.body.trim();
    if (!body) continue; // heading without content: nothing to embed
    const parts = [`${'#'.repeat(section.level)} ${section.heading}`];
    for (const paragraph of toParagraphs(body)) parts.push(paragraph);
    for (const chunkText of packParts(parts.flatMap((p) => splitOversized(p, maxChars)), maxChars)) {
      logical.push({ text: chunkText, heading: section.heading, level: section.level });
    }
  }

  if (logical.length === 0) return [];

  const result: Chunk[] = [];
  for (const chunk of logical) {
    let chunkText = chunk.text;
    if (overlap > 0 && result.length > 0) {
      const prev = result[result.length - 1];
      if (prev !== undefined) chunkText = `${prev.text.slice(-overlap)}\n\n${chunkText}`;
    }
    result.push({ ...chunk, text: chunkText });
  }

  return result;
}
