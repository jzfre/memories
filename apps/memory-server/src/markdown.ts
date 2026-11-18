export function markdownTitle(body: string): string | undefined {
  let fence = '';
  for (const raw of body.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (marker && marker[1]![0] === fence[0] && marker[1]!.length >= fence.length && !marker[2]!.trim()) fence = '';
      continue;
    }
    if (marker) { fence = marker[1]!; continue; }
    const heading = /^ {0,3}#[ \t]+(.*)$/.exec(line);
    if (!heading) continue;
    const text = heading[1]!.trim();
    let end = text.length;
    while (end > 0 && text[end - 1] === '#') end--;
    // Closing hashes need a whitespace separator; C# and F# are literal titles.
    const title = end < text.length && (end === 0 || /[ \t]/.test(text[end - 1]!))
      ? text.slice(0, end).trim() : text;
    if (title) return title;
  }
  return undefined;
}

// Link metadata is best-effort: malformed Markdown must never cause repeated
// scans of the same suffix. Every cursor below moves only forwards.
export function markdownLinks(body: string): string[] {
  const wiki: string[] = [];
  const markdown: string[] = [];
  let fence = '';
  for (const raw of body.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    const marker = /^[ \t]*(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (marker && marker[1]![0] === fence[0] && marker[1]!.length >= fence.length && !marker[2]!.trim()) fence = '';
      continue;
    }
    if (marker) { fence = marker[1]!; continue; }
    const prose = line.replace(/`[^`\r\n]*`/g, '');
    let i = 0;
    const whitespace = (): void => { while (i < prose.length && /\s/.test(prose[i]!)) i++; };
    while (i < prose.length) {
      if (prose[i++] !== '[') continue;
      const isWiki = prose[i] === '[';
      if (isWiki) i++;
      const label = i;
      while (i < prose.length && prose[i] !== '[' && prose[i] !== ']') i++;
      if (prose[i] !== ']') continue;
      const end = i++;
      if (isWiki) {
        if (prose[i] === ']') { wiki.push(prose.slice(label, end)); i++; }
        continue;
      }
      if (prose[i] !== '(') continue;
      i++;
      whitespace();
      const angle = prose[i] === '<';
      if (angle) i++;
      const start = i;
      while (i < prose.length && (angle ? prose[i] !== '>' : !/[\s)]/.test(prose[i]!))) i++;
      const target = prose.slice(start, i);
      if (angle) {
        if (prose[i] !== '>') continue;
        i++;
      }
      const beforeSpace = i;
      whitespace();
      if (i > beforeSpace && prose[i] === '"') {
        i++;
        while (i < prose.length && prose[i] !== '"') i++;
        if (prose[i] !== '"') continue;
        i++;
        whitespace();
      }
      if (prose[i] === ')') { if (target) markdown.push(target); i++; }
    }
  }
  return [...wiki, ...markdown];
}
