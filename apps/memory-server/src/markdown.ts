export function markdownTitle(body: string): string | undefined {
  for (const line of body.split('\n')) {
    if (line[0] !== '#' || !line[1] || !/\s/.test(line[1])) continue;
    const text = line.slice(1).trim();
    let end = text.length;
    while (end > 0 && text[end - 1] === '#') end--;
    const title = text.slice(0, end).trim();
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
  for (const line of body.split('\n')) {
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
