const segmenter = typeof Intl.Segmenter === 'function' && new Intl.Segmenter('en', { granularity: 'sentence' });
const abbreviation = /\b(?:figs?|eqs?|refs?|secs?|dr|mr|mrs|prof|vs|et\s+al|e\.g|i\.e)\.$/iu;
const initial = /\b[A-Z]\.$/u;
const eastAsian = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;

function* sentenceSegments(text) {
  if (segmenter) {
    yield* segmenter.segment(text);
    return;
  }
  // Zotero 7 is based on Firefox 115, which predates Intl.Segmenter.
  let start = 0;
  for (const match of text.matchAll(/(?:[。！？!?…]+|\.+(?=["'”’」』）》）\]]*(?:\s|$)))["'”’」』）》）\]]*\s*/gu)) {
    const end = match.index + match[0].length;
    yield { index: start, segment: text.slice(start, end) };
    start = end;
  }
  if (start < text.length) yield { index: start, segment: text.slice(start) };
}

function continuesRow(previous, row) {
  const em = Math.max(previous.em, row.em);
  const gap = row.baseline - previous.baseline;
  return previous.kind === 'text' && row.kind === 'text'
    && previous.readingRole === row.readingRole && previous.flowId === row.flowId
    && Math.abs(previous.angle - row.angle) < .1
    && Math.min(previous.em, row.em) >= .83 * em
    && gap > .35 * em && gap <= 1.9 * em
    && row.inlineStart <= previous.inlineStart + .85 * em;
}

function sliceItem(item, start, end, measureWidth) {
  if (start === 0 && end === item.str.length) return item;
  const offset = index => index === 0 ? 0 : measureWidth(item.str.slice(0, index), item.fontName);
  const length = offset(item.str.length);
  const lo = length > 0 ? offset(start) / length : start / item.str.length;
  const hi = end === item.str.length ? 1 : length > 0 ? offset(end) / length : end / item.str.length;
  const advance = item.inlineEnd - item.inlineStart;
  const x = Math.cos(item.angle) * advance, y = Math.sin(item.angle) * advance;
  return { ...item, start, end, str: item.str.slice(start, end),
    x: item.x + Math.max(0, x) * lo - Math.min(0, x) * (1 - hi),
    y: item.y + Math.max(0, y) * lo - Math.min(0, y) * (1 - hi),
    width: Math.max(.01, item.width - Math.abs(x) * (1 - hi + lo)),
    height: Math.max(.01, item.height - Math.abs(y) * (1 - hi + lo)) };
}

function enclosingBox(boxes) {
  const x = Math.min(...boxes.map(box => box.x)), y = Math.min(...boxes.map(box => box.y));
  const right = Math.max(...boxes.map(box => box.right)), bottom = Math.max(...boxes.map(box => box.bottom));
  return { x, y, right, bottom, height: bottom - y };
}

// shortcut: sentences stop at the page boundary until page layouts can share a reading unit.
export function buildSentenceUnits(physicalRows, measureWidth = text => [...text].length) {
  const rows = [], fragments = [];
  let text = '', spans = [];
  const appendUnit = (sentence, parts) => {
    const indices = parts.map(part => {
      const index = fragments.length;
      fragments.push({ ...part, unitIndex: rows.length });
      return index;
    });
    rows.push({ ...parts[0], ...enclosingBox(parts), text: sentence, fragments: indices,
      items: parts.flatMap(part => part.items) });
  };
  const flush = () => {
    let start = 0, firstSpan = 0;
    for (const { segment, index } of sentenceSegments(text)) {
      const end = index + segment.trimEnd().length;
      if (index + segment.length < text.length && (abbreviation.test(segment.trimEnd()) || initial.test(segment.trimEnd()))) continue;
      const parts = new Map();
      while (firstSpan < spans.length && spans[firstSpan].end <= start) firstSpan++;
      for (let i = firstSpan; i < spans.length && spans[i].start < end; i++) {
        const span = spans[i];
        const lo = Math.max(0, start - span.start), hi = Math.min(span.item.str.length, end - span.start);
        const part = span.item.str.slice(lo, hi);
        if (!part.trim()) continue;
        const item = sliceItem(span.item, lo + part.length - part.trimStart().length, lo + part.trimEnd().length, measureWidth);
        if (!parts.has(span.row)) parts.set(span.row, []);
        parts.get(span.row).push(item);
      }
      if (parts.size) appendUnit(text.slice(start, end).trim(), Array.from(parts, ([row, items]) => ({
        ...row, ...enclosingBox(items.map(item => ({ ...item, right: item.x + item.width, bottom: item.y + item.height }))),
        items,
      })));
      start = index + segment.length;
    }
    text = '';
    spans = [];
  };
  let previous = null;
  for (const row of physicalRows) {
    if (previous && !continuesRow(previous, row)) flush();
    if (row.kind !== 'text') {
      appendUnit(row.text, [row]);
      previous = null;
      continue;
    }
    let previousItem;
    for (const item of row.items) {
      if (text && !/\s$/u.test(text) && !/^\s/u.test(item.str)
        && !(eastAsian.test(text.at(-1)) && eastAsian.test(item.str[0]))
        && (!previousItem || item.inlineStart - previousItem.inlineEnd > row.em * .08)) text += ' ';
      const start = text.length;
      text += item.str;
      spans.push({ start, end: text.length, item, row });
      previousItem = item;
    }
    previous = row;
  }
  flush();
  return { rows, fragments };
}
