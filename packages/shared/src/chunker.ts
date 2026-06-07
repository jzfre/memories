export interface Chunk {
  chunkIndex: number;
  headingPath: string | null;
  content: string;
  tokenCount: number;
}

const MAX_CHARS = 1500;

interface Section {
  headingPath: string | null;
  lines: string[];
}

function approxTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

function splitBySize(text: string, max: number): string[] {
  if (text.length <= max) return [text];
  const paragraphs = text.split(/\n{2,}/);
  const pieces: string[] = [];
  let current = "";
  for (const p of paragraphs) {
    const candidate = current ? `${current}\n\n${p}` : p;
    if (candidate.length > max && current) {
      pieces.push(current);
      current = p;
    } else if (candidate.length > max && !current) {
      // single oversized paragraph: hard-split on length
      for (let i = 0; i < p.length; i += max) pieces.push(p.slice(i, i + max));
      current = "";
    } else {
      current = candidate;
    }
  }
  if (current) pieces.push(current);
  return pieces;
}

export function chunkMarkdown(body: string): Chunk[] {
  const lines = body.split(/\r?\n/);
  const sections: Section[] = [];
  const stack: { level: number; text: string }[] = [];
  let current: Section = { headingPath: null, lines: [] };

  const flush = () => {
    if (current.lines.join("\n").trim() !== "") sections.push(current);
  };

  for (const line of lines) {
    const m = /^(#{1,6})\s+(.*)$/.exec(line);
    if (m) {
      flush();
      const level = m[1].length;
      while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
      stack.push({ level, text: m[2].trim() });
      current = { headingPath: stack.map((s) => s.text).join(" > "), lines: [] };
    } else {
      current.lines.push(line);
    }
  }
  flush();

  const chunks: Chunk[] = [];
  let idx = 0;
  for (const sec of sections) {
    const text = sec.lines.join("\n").trim();
    for (const piece of splitBySize(text, MAX_CHARS)) {
      chunks.push({
        chunkIndex: idx++,
        headingPath: sec.headingPath,
        content: piece,
        tokenCount: approxTokens(piece),
      });
    }
  }
  return chunks;
}
