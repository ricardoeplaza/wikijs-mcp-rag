import { describe, expect, it } from 'vitest';
import { chunkMarkdown } from '../../src/rag/chunker.js';

describe('chunkMarkdown (Etapa 5a, port of POC chunkTextMarkdown)', () => {
  it('splits a document into one chunk per H1/H2 section with heading and level', () => {
    const md = [
      '# Intro',
      '',
      'Intro text.',
      '',
      '## Alpha',
      '',
      'Alpha body.',
      '',
      '## Beta',
      '',
      'Beta body.',
    ].join('\n');

    const chunks = chunkMarkdown(md, { maxChars: 1000, overlap: 0 });

    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toMatchObject({ heading: 'Intro', level: 1 });
    expect(chunks[1]).toMatchObject({ heading: 'Alpha', level: 2 });
    expect(chunks[2]).toMatchObject({ heading: 'Beta', level: 2 });
    expect(chunks[0]?.text).toContain('Intro text.');
    expect(chunks[1]?.text).toContain('Alpha body.');
    expect(chunks[2]?.text).toContain('Beta body.');
  });

  it('includes the heading line in the first chunk of each section', () => {
    const md = '# Title\n\nSome content.';
    const chunks = chunkMarkdown(md, { maxChars: 1000, overlap: 0 });
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.text).toContain('# Title');
    expect(chunks[0]?.text).toContain('Some content.');
  });

  it('subdivides a section longer than maxChars into multiple chunks', () => {
    const md = [
      '## Long section',
      '',
      'First paragraph of the long section.',
      '',
      'Second paragraph of the long section.',
      '',
      'Third paragraph of the long section.',
    ].join('\n');

    const chunks = chunkMarkdown(md, { maxChars: 80, overlap: 0 });

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.heading).toBe('Long section');
      expect(chunk.level).toBe(2);
      expect(chunk.text.length).toBeLessThanOrEqual(80);
    }
  });

  it('hard-splits a single paragraph that alone exceeds maxChars', () => {
    const md = `# A\n\n${'x'.repeat(250)}`;
    const chunks = chunkMarkdown(md, { maxChars: 100, overlap: 0 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.text.length).toBeLessThanOrEqual(100);
    }
  });

  it('applies overlap: each chunk starts with the tail of the previous one', () => {
    const md = [
      '## Section',
      '',
      'Paragraph one of the section body.',
      '',
      'Paragraph two of the section body.',
      '',
      'Paragraph three of the section body.',
      '',
      'Paragraph four of the section body.',
    ].join('\n');

    const overlap = 50;
    const chunks = chunkMarkdown(md, { maxChars: 60, overlap });

    expect(chunks.length).toBeGreaterThan(1);
    for (let i = 1; i < chunks.length; i++) {
      const prev = chunks[i - 1];
      const curr = chunks[i];
      if (prev === undefined || curr === undefined) continue;
      expect(curr.text.startsWith(prev.text.slice(-overlap))).toBe(true);
    }
  });

  it('does not apply overlap when overlap is 0', () => {
    const md = [
      '## Section',
      '',
      'Paragraph one of the section body.',
      '',
      'Paragraph two of the section body.',
      '',
      'Paragraph three of the section body.',
    ].join('\n');

    const maxChars = 80;
    const chunks = chunkMarkdown(md, { maxChars, overlap: 0 });

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.text.length).toBeLessThanOrEqual(maxChars);
    }
  });

  it('includes text before the first heading as a chunk without heading', () => {
    const md = 'Preamble paragraph.\n\n# First\n\nBody.';
    const chunks = chunkMarkdown(md, { maxChars: 1000, overlap: 0 });

    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toEqual({ text: 'Preamble paragraph.' });
    expect(chunks[0]?.heading).toBeUndefined();
    expect(chunks[0]?.level).toBeUndefined();
    expect(chunks[1]?.text).toContain('# First');
    expect(chunks[1]?.heading).toBe('First');
  });

  it('returns a single chunk without heading for text with no headings', () => {
    const md = 'Just some text.\n\nAnd another paragraph.';
    const chunks = chunkMarkdown(md, { maxChars: 1000, overlap: 0 });
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.heading).toBeUndefined();
    expect(chunks[0]?.text).toContain('Just some text.');
  });

  it('keeps H3+ content inside the enclosing section', () => {
    const md = ['## Parent', '', '### Child', '', 'Child content.'].join('\n');
    const chunks = chunkMarkdown(md, { maxChars: 1000, overlap: 0 });

    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({ heading: 'Parent', level: 2 });
    expect(chunks[0]?.text).toContain('### Child');
    expect(chunks[0]?.text).toContain('Child content.');
  });

  it('skips headings without body content', () => {
    const md = '# Empty\n\n# Real\n\nContent here.';
    const chunks = chunkMarkdown(md, { maxChars: 1000, overlap: 0 });

    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({ heading: 'Real', level: 1 });
  });

  it('returns an empty array for empty or whitespace-only input', () => {
    expect(chunkMarkdown('')).toEqual([]);
    expect(chunkMarkdown('   \n\n\t  \n')).toEqual([]);
  });

  it('returns an empty array when the document has only headings without body', () => {
    expect(chunkMarkdown('# Only a heading')).toEqual([]);
  });

  it('uses POC defaults (maxChars 800, overlap 100) when no options are given', () => {
    // Five ~192-char paragraphs: the first four pack into one chunk (< 800),
    // the fifth overflows → 2 chunks with the default overlap of 100 applied.
    const para = (n: number) => `Paragraph ${n} ` + 'x'.repeat(180);
    const md = ['## Section', '', para(1), '', para(2), '', para(3), '', para(4), '', para(5)].join('\n');

    const chunks = chunkMarkdown(md);
    expect(chunks.length).toBeGreaterThan(1);

    for (const chunk of chunks) {
      expect(chunk.text.length).toBeLessThanOrEqual(902); // 800 + overlap 100 + '\n\n'
    }
  });
});
