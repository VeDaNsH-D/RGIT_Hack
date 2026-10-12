// Lightweight section/declaration boundaries; this is not a language parser.
// Long sections fall back to overlapping line windows while retaining context.
export function splitEvidence(text, maxChars = 1200) {
  const sections = [];
  let lines = [], heading = '', startLine = 1;
  const flush = () => {
    if (lines.length) sections.push({ text: lines.join('\n'), heading, startLine });
    lines = [];
  };
  String(text).split('\n').forEach((line, index) => {
    if (/^#{1,6}\s+|^(?:export\s+(?:default\s+)?)?(?:async\s+)?(?:function|class)\s+|^(?:async\s+)?def\s+|^(?:export\s+)?(?:const|let)\s+\w+\s*=.*(?:=>|function)/.test(line)) {
      flush(); heading = line.trim().slice(0, 120); startLine = index + 1;
    }
    lines.push(line);
  });
  flush();
  return sections.flatMap(section => {
    const chunks = [];
    let offset = 0;
    while (offset < section.text.length) {
      let end = Math.min(offset + maxChars, section.text.length);
      if (end < section.text.length) {
        const boundary = section.text.lastIndexOf('\n', end);
        if (boundary > offset + maxChars / 2) end = boundary;
      }
      chunks.push({ ...section, text: section.text.slice(offset, end), startLine: section.startLine + (section.text.slice(0, offset).match(/\n/g) || []).length });
      if (end === section.text.length) break;
      offset = Math.max(offset + 1, end - 150);
    }
    return chunks;
  });
}

// Rerank a broad lexical shortlist by relevance and new evidence coverage.
// Near-duplicate passages lose priority; source caps and budget still apply.
export function selectEvidence(ranked, { maxSources = 10, budget = 11000 } = {}) {
  const remaining = ranked.slice(0, 80);
  const chosen = [], counts = new Map();
  let chars = 0;
  const highest = ranked[0]?.score || 1;
  while (remaining.length && chosen.length < maxSources) {
    let best = -1, bestScore = -Infinity;
    remaining.forEach((row, index) => {
      const group = row.sourceKey || row.key.split(':').slice(0, 2).join(':');
      if ((counts.get(group) || 0) >= 3 || chars + row.text.length > budget || chosen.some(previous => previous.text === row.text)) return;
      let similarity = 0;
      for (const previous of chosen) {
        const intersection = [...row.terms].filter(term => previous.terms.has(term)).length;
        similarity = Math.max(similarity, intersection / Math.max(1, row.terms.size + previous.terms.size - intersection));
      }
      const score = row.score / highest - .25 * similarity;
      if (score > bestScore) { best = index; bestScore = score; }
    });
    if (best < 0) break;
    const row = remaining.splice(best, 1)[0];
    const group = row.sourceKey || row.key.split(':').slice(0, 2).join(':');
    counts.set(group, (counts.get(group) || 0) + 1);
    chosen.push(row); chars += row.text.length;
  }
  return chosen.map((row, index) => ({ id: `S${index + 1}`, title: row.title, text: row.text, provider: row.provider, url: row.url }));
}
