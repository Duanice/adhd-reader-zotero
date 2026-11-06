/* global Zotero, Services */
"use strict";

const LINEA_ID = "linea-reader@local.linea";
const LINEA_PREF = "extensions.linea-reader.";
const sessions = new Map();
let toolbarHandler;
let running = false;
let startupGeneration = 0;
let glyphMetrics;
const focusGeometryCache = new WeakMap();

function unwrapReaderObject(value) {
  if (!value) return value;
  if (typeof Components !== "undefined") return Components.utils.waiveXrays(value);
  return value.wrappedJSObject || value;
}

function readerOptions(value, win) {
  return typeof Components !== "undefined" && win ? Components.utils.cloneInto(value, win) : value;
}

function internalReader(reader) {
  return reader._internalReader || reader._iframeWindow?.wrappedJSObject?._reader;
}

function projectBox(box, angle) {
  const c = Math.cos(angle), s = Math.sin(angle);
  const points = [[box.x, box.y], [box.right, box.y], [box.x, box.bottom], [box.right, box.bottom]];
  const xs = points.map(([x, y]) => x * c + y * s), ys = points.map(([x, y]) => -x * s + y * c);
  return { x: Math.min(...xs), right: Math.max(...xs), y: Math.min(...ys), bottom: Math.max(...ys) };
}

function classifyReadingRows(allRows, viewport) {
  if (!allRows.length) return { allRows, rows: [], excludedRows: [], angle: 0, orientation: { angle: 0, support: 0, lineCount: 0 } };
  const angleTolerance = Math.sin(Math.PI / 18);
  const groups = [];
  for (const row of allRows) {
    const angle = row.angle || 0;
    const weight = 1 + Math.min(80, [...row.text.replace(/\s/gu, "")].length) / 80;
    let group = groups.find(candidate => Math.abs(Math.sin(angle - candidate.angle)) < angleTolerance);
    if (!group) groups.push(group = { angle, rows: [], weight: 0, cos: 0, sin: 0 });
    group.rows.push(row);
    group.weight += weight;
    group.cos += Math.cos(angle) * weight; group.sin += Math.sin(angle) * weight;
  }
  groups.sort((a, b) => b.weight - a.weight || b.rows.length - a.rows.length);
  const main = groups[0], total = groups.reduce((sum, group) => sum + group.weight, 0);
  const angle = Math.hypot(main.cos, main.sin) > 1e-6 ? Math.atan2(main.sin, main.cos) : main.angle;
  const orientation = { angle, support: main.weight / total, lineCount: main.rows.length };
  const excludedRows = [];
  if (main.rows.length >= 3 && orientation.support >= .65) {
    const scale = viewport.transform ? Math.hypot(viewport.transform[0], viewport.transform[1]) : (viewport.scale || 1) * (viewport.userUnit || 1);
    const readingBox = row => {
      const cos = Math.cos(angle), sin = Math.sin(angle);
      const corners = [[row.x, row.y], [row.right, row.y], [row.x, row.bottom], [row.right, row.bottom]];
      const xs = corners.map(([x, y]) => (cos * x + sin * y) / scale), ys = corners.map(([x, y]) => (-sin * x + cos * y) / scale);
      const point = value => Math.round(value * 1e6) / 1e6;
      const x = point(Math.min(...xs)), y = point(Math.min(...ys)), width = point(Math.max(...xs) - Math.min(...xs)), height = point(Math.max(...ys) - Math.min(...ys));
      return { x, y, width, height, right: x + width, bottom: y + height };
    };
    const projected = main.rows.map(readingBox);
    const body = { x: Math.min(...projected.map(r => r.x)), right: Math.max(...projected.map(r => r.right)), y: Math.min(...projected.map(r => r.y)), bottom: Math.max(...projected.map(r => r.bottom)) };
    const page = readingBox({ x: 0, y: 0, right: viewport.width, bottom: viewport.height });
    const sizes = main.rows.map(row => (row.em || Math.min(row.right - row.x, row.height)) / scale).sort((a, b) => a - b);
    const median = sizes.length % 2 ? sizes[(sizes.length - 1) / 2] : (sizes[sizes.length / 2 - 1] + sizes[sizes.length / 2]) / 2;
    const gap = Math.max(median * 1.2, Math.min(page.width, page.height) * .015);
    for (const row of allRows) {
      if (Math.abs(Math.sin((row.angle || 0) - angle)) < .94) continue;
      const box = readingBox(row), cx = box.x + box.width / 2, cy = box.y + box.height / 2;
      const isolatedEdge = box.right <= body.x - gap && cx <= page.x + page.width * .12
        || box.x >= body.right + gap && cx >= page.x + page.width * .88
        || box.bottom <= body.y - gap && cy <= page.y + page.height * .12
        || box.y >= body.bottom + gap && cy >= page.y + page.height * .88;
      if (isolatedEdge) excludedRows.push(row);
    }
  }
  const excluded = new Set(excludedRows);
  return { allRows, rows: allRows.filter(row => !excluded.has(row)), excludedRows, angle, orientation };
}

function mergeRowParts(parts) {
  const main = parts.reduce((largest, part) => part.em > largest.em ? part : largest, parts[0]);
  const row = { ...main, parts: [...parts].sort((a, b) => a.inlineStart - b.inlineStart || a.baseline - b.baseline) };
  row.x = Math.min(...parts.map(part => part.x)); row.y = Math.min(...parts.map(part => part.y));
  row.right = Math.max(...parts.map(part => part.right)); row.bottom = Math.max(...parts.map(part => part.bottom));
  row.height = row.bottom - row.y;
  row.inlineStart = Math.min(...parts.map(part => part.inlineStart)); row.inlineEnd = Math.max(...parts.map(part => part.inlineEnd));
  row.blockStart = Math.min(...parts.map(part => part.blockStart)); row.blockEnd = Math.max(...parts.map(part => part.blockEnd));
  return row;
}

function buildNativeReadingUnits(rows, scale, structures, viewport) {
  // Keep the host's row schema while sharing the complete mathematical layout
  // model: baseline fragments, scripts, fractions, delimiters and equation labels.
  const lines = rows.map(row => ({ ...row, width: row.right - row.x, fontHeight: row.em,
    baselineOffset: row.baseline, baseline: row.baselineY,
    items: row.parts.map(part => ({ ...part, str: part.text, width: part.right - part.x,
      fontHeight: part.em, baselineOffset: part.baseline, baseline: part.baselineY,
      along: part.inlineStart, nativePart: part })) }));
  const baselineLines = glyphMetrics.attachScriptFragments(lines, scale);
  const model = glyphMetrics.buildReadingUnits({ items: baselineLines.flatMap(line => line.items), baselineLines, structures, viewport });
  const fromUnit = unit => ({ ...mergeRowParts(unit.items.map(item => item.nativePart)),
    x: unit.x, y: unit.y, right: unit.x + unit.width, bottom: unit.y + unit.height, height: unit.height,
    em: unit.fontHeight, baseline: unit.baselineOffset, angle: unit.angle, items: unit.items,
    kind: unit.kind, regionId: unit.regionId, regionBounds: unit.regionBounds,
    regionPath: unit.regionPath, flowId: unit.flowId, readingOrder: unit.readingOrder,
    readingRole: unit.readingRole || "body", exclusionReason: unit.exclusionReason, figureRegionId: unit.figureRegionId, tableRegionId: unit.tableRegionId,
    coreBounds: unit.coreBounds, labelBounds: unit.labelBounds, components: unit.components });
  return { rows: model.units.map(fromUnit), excludedRows: (model.excludedUnits || []).map(fromUnit),
    figureRegions: model.figureRegions || [], tableRegions: model.tableRegions || [],
    excludedRegions: model.excludedRegions || [...(model.figureRegions || []), ...(model.tableRegions || [])],
    rawRows: baselineLines.map(fromUnit), components: model.components, regions: model.regions };
}

function makePageLayout(items, viewport, styles = {}, metricsForItem, structures = { rules: [] }) {
  const spans = [];
  const m = viewport.transform;
  const scale = Math.hypot(m[0], m[1]);
  const metricsPage = {};
  const resolveMetrics = metricsForItem || (item => glyphMetrics.fontMetrics(metricsPage, item.fontName, styles[item.fontName], styles, item.str));
  let textDivIndex = 0;
  for (let index = 0; index < items.length; index++) {
    const item = items[index];
    if (typeof item.str !== "string") continue;
    const divIndex = textDivIndex++;
    if (!item.str?.trim() || !item.transform) continue;
    const t = item.transform;
    const x = m[0] * t[4] + m[2] * t[5] + m[4];
    const y = m[1] * t[4] + m[3] * t[5] + m[5];
    const h = Math.hypot(m[0] * t[2] + m[2] * t[3], m[1] * t[2] + m[3] * t[3]);
    const angle = Math.atan2(m[1] * t[0] + m[3] * t[1], m[0] * t[0] + m[2] * t[1]) + (styles[item.fontName]?.vertical ? Math.PI / 2 : 0);
    const w = Math.abs((styles[item.fontName]?.vertical ? item.height : item.width) * scale);
    const ux = Math.cos(angle), uy = Math.sin(angle);
    const vx = Math.sin(angle), vy = -Math.cos(angle);
    const metrics = resolveMetrics(item), ascent = metrics.ascent, descent = -metrics.descent;
    const points = [[x + vx * h * descent, y + vy * h * descent], [x + ux * w + vx * h * descent, y + uy * w + vy * h * descent], [x + vx * h * ascent, y + vy * h * ascent], [x + ux * w + vx * h * ascent, y + uy * w + vy * h * ascent]];
    const left = Math.min(...points.map(p => p[0]));
    const right = Math.max(...points.map(p => p[0]));
    const top = Math.min(...points.map(p => p[1]));
    const bottom = Math.max(...points.map(p => p[1]));
    if (right - left <= .1 * scale || bottom - top <= .1 * scale) continue;
    const baseline = -x * uy + y * ux, inlineStart = x * ux + y * uy;
    spans.push({ x: left, y: top, right, bottom, height: bottom - top, text: item.str, index, textDivIndex: divIndex, fontName: item.fontName, baseline, baselineX: x, baselineY: y, em: h, angle,
      inlineStart, inlineEnd: inlineStart + w, blockStart: baseline - h * ascent, blockEnd: baseline - h * descent });
  }
  const clusters = [];
  for (const span of spans.sort((a, b) => a.baseline - b.baseline || a.inlineStart - b.inlineStart)) {
    let cluster = clusters.find(row => Math.abs(row.baseline - span.baseline) <= Math.max(2 * scale, span.em * .3) && Math.abs(row.angle - span.angle) < .1);
    if (!cluster) clusters.push(cluster = { baseline: span.baseline, angle: span.angle, parts: [] });
    cluster.parts.push(span);
  }
  let rows = [];
  for (const cluster of clusters) {
    let segment = [];
    for (const span of cluster.parts.sort((a, b) => a.inlineStart - b.inlineStart)) {
      const previous = segment.at(-1);
      if (previous && span.inlineStart - previous.inlineEnd > Math.max(18 * scale, span.em * 2.2)) { rows.push(mergeRowParts(segment)); segment = []; }
      segment.push(span);
    }
    if (segment.length) rows.push(mergeRowParts(segment));
  }
  const model = buildNativeReadingUnits(rows, scale, structures, viewport);
  rows = model.rows;
  for (const row of [...rows, ...model.excludedRows]) {
    row.text = row.parts.sort((a, b) => a.inlineStart - b.inlineStart).map(part => part.text).join(" ");
    delete row.parts;
  }
  // Reading order is a separate view of all extracted text. Native PDF text
  // selection and annotation continue to use every item, including marginalia.
  const layout = classifyReadingRows(rows, viewport);
  for (const row of layout.excludedRows) { row.readingRole = "margin"; row.exclusionReason = "isolated-perpendicular-margin"; }
  layout.excludedRows.push(...model.excludedRows); layout.allRows.push(...model.excludedRows);
  Object.assign(layout, { rawRows: model.rawRows, components: model.components, regions: model.regions,
    figureRegions: model.figureRegions, tableRegions: model.tableRegions, excludedRegions: model.excludedRegions });
  // Use the same physical-row order as the standalone reader. A second
  // center-of-page column heuristic would split formula/explanation blocks.
  layout.rows = glyphMetrics.orderReadingLines(layout.rows.map(row => {
    const box = projectBox(row, layout.angle);
    return { row, x: box.x / scale, y: box.y / scale,
      width: (box.right - box.x) / scale, height: (box.bottom - box.y) / scale,
      regionId: row.regionId, regionPath: row.regionPath, flowId: row.flowId, readingOrder: row.readingOrder, regionBounds: row.regionBounds && {
        x: row.regionBounds.x / scale, y: row.regionBounds.y / scale,
        width: row.regionBounds.width / scale, height: row.regionBounds.height / scale,
      } };
  })).map(({ row }) => row);
  return layout;
}

function makeRows(items, viewport, styles = {}, metricsForItem, structures) {
  return makePageLayout(items, viewport, styles, metricsForItem, structures).rows;
}

function focusBox(rows, index, paddingX = 6, paddingY = 3) {
  let cache = focusGeometryCache.get(rows);
  if (!cache) { cache = { frames: new Map(), boxes: new Map() }; focusGeometryCache.set(rows, cache); }
  const key = `${index}:${paddingX}:${paddingY}`;
  if (cache.boxes.has(key)) return cache.boxes.get(key);
  const angle = rows[index].angle || 0;
  let projected = cache.frames.get(angle);
  if (!projected) {
    projected = rows.map(row => { const box = projectBox(row, angle); return { ...row, ...box, height: box.bottom - box.y }; });
    cache.frames.set(angle, projected);
  }
  const box = focusAxisBox(projected, index, paddingX, paddingY);
  const result = projectBox(box, -angle);
  const bounds = { ...result, width: result.right - result.x, height: result.bottom - result.y };
  cache.boxes.set(key, bounds);
  return bounds;
}

function focusAxisBox(rows, index, paddingX, paddingY) {
  const row = rows[index];
  let top = row.y - paddingY, bottom = row.bottom + paddingY;
  let left = row.x - paddingX, right = row.right + paddingX;
  const cy = (row.y + row.bottom) / 2;
  for (const other of rows) {
    if (other === row) continue;
    // Only neighbors in the same column constrain vertical padding. The
    // midpoint also partitions overlapping font boxes without favoring row order.
    if (Math.min(row.right, other.right) > Math.max(row.x, other.x)) {
      const oy = (other.y + other.bottom) / 2;
      const separation = Math.abs(oy - cy);
      if (separation > Math.min(row.height, other.height) * .05) {
        // A tall equation delimiter can contain another run's whole box.
        // Keep a boundary between their centers so neither window collapses.
        const inset = Math.min(row.height, other.height, separation) * .05;
        if (oy < cy) top = Math.max(top, Math.max(oy + inset, Math.min(cy - inset, (other.bottom + row.y) / 2)));
        else bottom = Math.min(bottom, Math.max(cy + inset, Math.min(oy - inset, (row.bottom + other.y) / 2)));
      }
    }
    if (Math.abs((other.y + other.bottom) / 2 - cy) < Math.min(row.height, other.height) * .45) {
      if (other.right <= row.x) left = Math.max(left, (other.right + row.x) / 2);
      else if (other.x >= row.right) right = Math.min(right, (row.right + other.x) / 2);
    }
  }
  // A fraction or matrix is one reading unit. Neighbor spacing may remove
  // padding, but it cannot clip any member of the complete expression.
  if (row.kind === "equation") { top = Math.min(top, row.y); bottom = Math.max(bottom, row.bottom); }
  return { x: left, y: top, right, bottom, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
}

function closestRow(rows, x, y, excludedRows = [], excludedRegions = []) {
  if (excludedRegions.some(region => x >= region.x && x <= (region.right ?? region.x + region.width) && y >= region.y && y <= (region.bottom ?? region.y + region.height))) return -1;
  if (excludedRows.some(row => x >= row.x && x <= row.right && y >= row.y && y <= row.bottom)) return -1;
  let directIndex = -1, directScore = Infinity;
  rows.forEach((row, index) => {
    for (const item of row.items || []) {
      if (x < item.x || x > item.x + item.width || y < item.y || y > item.y + item.height) continue;
      const score = ((x - item.x - item.width / 2) / item.width) ** 2 + ((y - item.y - item.height / 2) / item.height) ** 2;
      if (score < directScore) { directScore = score; directIndex = index; }
    }
  });
  if (directIndex >= 0) return directIndex;
  let score = Infinity, index = -1;
  rows.forEach((r, i) => {
    const box = focusBox(rows, i, Math.min(6, r.em * .6), Math.min(3, r.em * .3));
    if (x < box.x || x > box.right || y < box.y || y > box.bottom) return;
    const dx = Math.max(r.x - x, 0, x - r.right);
    const dy = y - (r.y + r.bottom) / 2;
    const d = dy * dy + dx * dx;
    if (d < score) { score = d; index = i; }
  });
  return index;
}

class GuideSession {
  constructor(reader, doc) {
    this.reader = reader; this.doc = doc;
    this.enabled = false; this.dark = false; this.current = null; this.focusAnchor = null;
    this.cache = new Map(); this.pendingRows = new Map(); this.metricPages = new WeakMap();
    this.cleanups = []; this.buttons = new Set();
    this.menus = new Set(); this.toolbarDocuments = new Map();
    this.level = Number(Zotero.Prefs.get(LINEA_PREF + "dim", true) || 72) / 100;
    this.disposed = false; this.operation = 0; this.layoutEpoch = 0; this.followVersion = 0;
    this.pendingMoves = []; this.scrollDirection = 1;
    this.toggleVersion = 0;
  }
  isActive() {
    if (this.disposed || this.reader._isUninitialized || this.reader._isTabClosed) return false;
    const tabs = this.reader._window?.Zotero_Tabs;
    return !this.reader.tabID || !tabs || tabs.selectedID === this.reader.tabID;
  }
  valid(owner) { return this.enabled && this.isActive() && owner === this.operation; }
  lockedFocus() { return this.focusAnchor; }
  selectFocus(position) {
    this.current = position;
    const row = position && this.pageData?.get(position.page)?.rows[position.index];
    this.focusAnchor = position && { ...position, item: row?.items[0]?.index };
  }
  remapFocus(anchor, rows) {
    if (!anchor) return;
    const index = anchor.item === undefined ? anchor.index : rows.findIndex(row => row.items.some(item => item.index === anchor.item));
    this.current = index >= 0 && rows[index] ? { page: anchor.page, index } : null;
    // A temporarily absent source glyph is still the reading anchor. It must
    // not turn into the unrelated row now occupying the old numeric index.
    this.focusAnchor = { page: anchor.page, index: this.current?.index ?? anchor.index, item: anchor.item };
  }
  closeMenus({ except = null, focusReader = false } = {}) {
    let closed = false;
    for (const menu of this.menus) {
      if (!menu.isConnected) { this.menus.delete(menu); continue; }
      if (menu !== except && menu.open) { menu.open = false; closed = true; }
    }
    if (closed && focusReader && this.isActive()) this.win?.focus?.();
    return closed;
  }
  registerMenu(menu, doc) {
    this.menus.add(menu);
    if (this.toolbarDocuments.has(doc)) return;
    const pointer = event => {
      const inside = [...this.menus].find(menu => menu.contains?.(event.target));
      this.closeMenus({ except: inside });
    };
    const key = event => {
      if (event.key !== "Escape" || event.isComposing || event.keyCode === 229) return;
      if (this.closeMenus({ focusReader: true })) { event.preventDefault(); event.stopPropagation(); }
    };
    doc.addEventListener?.("pointerdown", pointer, true);
    doc.addEventListener?.("keydown", key, true);
    this.toolbarDocuments.set(doc, () => {
      doc.removeEventListener?.("pointerdown", pointer, true);
      doc.removeEventListener?.("keydown", key, true);
    });
  }
  cancelNavigation({ preserveFocus = false } = {}) {
    if (preserveFocus && this.geometrySettling?.anchor) {
      const anchor = this.geometrySettling.anchor, viewport = this.app?.pdfViewer.getPageView(anchor.page)?.viewport;
      this.stableFocus = { ...anchor, scale: viewport?.scale, rotation: viewport?.rotation, viewerScale: this.app?.pdfViewer.currentScale };
    }
    this.operation++; this.followVersion++;
    this.scrollMotion?.cancel(); this.scrollOwner = null;
    this.cancelGeometrySettle(); this.layoutRefreshOwner = null;
    if (!preserveFocus) this.stableFocus = null;
    for (const job of this.pendingMoves.splice(0)) job.resolve(false);
    this.runner?.job?.resolve(false); this.runner = null; this.scrollTarget = null;
  }
  scroller() { return this.app?.pdfViewer?.container || this.win?.document?.getElementById?.("viewerContainer"); }
  scrollPosition() { const el = this.scroller(); return { top: el?.scrollTop || 0, left: el?.scrollLeft || 0 }; }
  cancelGeometrySettle() {
    const settling = this.geometrySettling;
    if (settling?.frame != null) settling.win.cancelAnimationFrame(settling.frame);
    this.geometrySettling = null;
  }
  orientationRequest() {
    const anchor = this.lockedFocus();
    if (!anchor || !this.app) return null;
    const page = anchor.page, data = this.pageData?.get(page), viewer = this.app.pdfViewer, view = viewer.getPageView(page);
    if (!data || !view) return null;
    const rotation = this.pageOrientation(page);
    if (rotation == null || data.viewport.rotation === rotation && !(this.orientationRefresh && this.orientationRefresh.page === page && this.orientationRefresh.rotation !== rotation)) return null;
    return { page, rotation, app: this.app };
  }
  pageOrientation(page) {
    const viewer = this.app?.pdfViewer, view = viewer?.getPageView(page);
    return typeof viewer?.pagesRotation === "number" ? (((view?.pdfPage?.rotate || 0) + viewer.pagesRotation) % 360 + 360) % 360 : view?.viewport?.rotation;
  }
  ensureOrientation() {
    const request = this.orientationRequest();
    if (!request) return Promise.resolve();
    const previous = this.orientationRefresh;
    if (previous?.page === request.page && previous.rotation === request.rotation && previous.app === request.app) return previous.promise;
    const state = { ...request }; this.orientationRefresh = state;
    // Data orientation is independent of keyboard/zoom interaction ownership.
    // A later scale event may cancel navigation, but must not lose this refresh.
    state.promise = this.refreshLayout().finally(() => {
      if (this.orientationRefresh === state) this.orientationRefresh = null;
    }).then(() => {
      if (this.app === state.app && this.enabled && this.isActive()) this.onViewportChange();
    });
    return state.promise;
  }
  readingAnchor() {
    const data = this.current && this.pageData?.get(this.current.page), row = data?.rows[this.current.index];
    if (!row) return null;
    const saved = this.stableFocus, item = this.lockedFocus()?.item ?? row.items[0]?.index;
    const box = this.screenBox(), bounds = this.viewportBounds();
    const viewport = this.app.pdfViewer.getPageView(this.current.page)?.viewport;
    const scaleChanged = saved && (saved.scale !== viewport?.scale || saved.viewerScale !== this.app.pdfViewer.currentScale);
    if (saved && saved.page === this.current.page && saved.item === item && saved.win === this.win && saved.document === this.app.pdfDocument && saved.epoch === this.layoutEpoch
      && (this.intersects(box, bounds) || scaleChanged)) return saved;
    if (!this.intersects(box, bounds) && !this.scrollMotion?.active) return null;
    return { page: this.current.page, index: this.current.index, item, win: this.win, document: this.app.pdfDocument, epoch: this.layoutEpoch,
      ratio: this.intersects(box, bounds) ? ((box.top + box.bottom) / 2 - bounds.top) / bounds.height : .4 };
  }
  compensateScale(state) {
    const anchor = state.anchor, source = this.lockedFocus();
    if (!anchor || !this.valid(state.owner) || anchor.win !== this.win || anchor.document !== this.app.pdfDocument || anchor.epoch !== this.layoutEpoch) return;
    if (!source || source.page !== anchor.page || source.item !== anchor.item) return;
    const rows = this.pageData?.get(anchor.page)?.rows;
    if (!rows?.length) return;
    const index = rows.findIndex(row => row.items.some(item => item.index === anchor.item));
    if (index < 0) return;
    this.remapFocus(source, rows);
    const box = this.screenBox(), bounds = this.viewportBounds(), container = this.scroller();
    if (!box || !container) return;
    const center = box.height > bounds.height - 16 ? box.height / 2 + 8
      : Math.max(box.height / 2 + 8, Math.min(anchor.ratio * bounds.height, bounds.height - box.height / 2 - 8));
    const top = Math.max(0, Math.min(container.scrollTop + (box.top + box.bottom) / 2 - bounds.top - center, Math.max(0, container.scrollHeight - container.clientHeight)));
    if (Math.abs(top - container.scrollTop) > .1) {
      this.committing = true;
      try { container.scrollTop = top; } finally { this.committing = false; }
    }
    this.scrollTarget = this.scrollPosition(); this.lastScrollPosition = this.scrollTarget;
  }
  onScaleChange(preserveAnchor = true) {
    const anchor = this.geometrySettling?.anchor || (preserveAnchor ? this.readingAnchor() : null);
    this.cancelNavigation({ preserveFocus: !preserveAnchor });
    if (!this.enabled || !this.isActive() || !this.win) return;
    const state = { win: this.win, owner: this.operation, anchor, stable: 0, previous: null, frame: null };
    this.geometrySettling = state;
    const tick = () => {
      if (this.geometrySettling !== state || !this.valid(state.owner)) return;
      this.compensateScale(state);
      const bounds = this.viewportBounds(), position = this.scrollPosition();
      const geometry = [bounds.width, bounds.height, position.top, position.left, this.app.pdfViewer.currentScale || 0];
      for (const page of new Set([this.current?.page, ...this.visiblePages()])) {
        if (page === undefined) continue;
        const div = this.app.pdfViewer.getPageView(page)?.div, rect = div?.getBoundingClientRect();
        if (rect) geometry.push(page, rect.left, rect.top, div.clientWidth, div.clientHeight, this.app.pdfViewer.getPageView(page)?.viewport?.scale || 0);
      }
      state.stable = state.previous && geometry.length === state.previous.length && geometry.every((value, index) => Math.abs(value - state.previous[index]) < .1) ? state.stable + 1 : 0;
      state.previous = geometry;
      this.paint();
      if (state.stable >= 2) {
        this.geometrySettling = null;
        this.paint();
        if (!state.anchor) this.followVisible().catch(error => this.error(error));
      } else state.frame = state.win.requestAnimationFrame(tick);
    };
    this.compensateScale(state); this.paint(); state.frame = state.win.requestAnimationFrame(tick);
  }
  ensureScrollMotion() {
    if (this.scrollMotion) return this.scrollMotion;
    const win = this.win, app = this.app;
    this.scrollMotion = glyphMetrics.createReadingScroll({
      read: () => this.scrollPosition(),
      write: (top, left) => {
        const container = this.scroller();
        if (!container) return;
        this.committing = true;
        try {
          // Only primitive values cross from the add-on into the reader realm.
          container.scrollLeft = left; container.scrollTop = top;
          this.lastScrollPosition = this.scrollPosition();
        } finally { this.committing = false; }
      },
      requestFrame: callback => win.requestAnimationFrame(callback),
      cancelFrame: id => win.cancelAnimationFrame(id),
      now: () => win.performance.now(),
      reducedMotion: () => !!win.matchMedia?.("(prefers-reduced-motion: reduce)").matches,
      isValid: () => this.win === win && this.app === app && this.scrollOwner?.epoch === this.layoutEpoch && this.valid(this.scrollOwner.operation),
      onFrame: () => { this.scrollTarget = this.scrollPosition(); this.paint(); },
      onFinish: completed => {
        if (completed && this.scrollOwner && this.valid(this.scrollOwner.operation)) {
          this.paint();
          if (!this.runner) this.followVisible().catch(error => this.error(error));
        }
      },
    });
    return this.scrollMotion;
  }
  async attach() {
    const core = internalReader(this.reader), view = core?._primaryView;
    const frame = view?._iframeWindow || view?._iframe?.contentWindow;
    const win = frame?.wrappedJSObject || frame;
    if (!win?.PDFViewerApplication?.pdfDocument) throw new Error("PDF 尚未就绪，请稍后再点击行读。");
    if (this.win === win) return;
    this.detach(); this.win = win; this.app = win.PDFViewerApplication;
    this.overlay = win.document.createElement("div");
    this.overlay.setAttribute("aria-hidden", "true");
    this.overlay.style.cssText = "position:fixed;z-index:2147483000;pointer-events:none;border:0;box-sizing:border-box;display:none;";
    win.document.body.append(this.overlay);
    const listen = (target, name, fn, capture = false) => {
      target.addEventListener(name, fn, capture);
      this.cleanups.push(() => target.removeEventListener(name, fn, capture));
    };
    let down;
    listen(win.document, "pointerdown", e => {
      this.closeMenus();
      this.cancelNavigation(); down = e.button === 0 ? { x: e.clientX, y: e.clientY, time: Date.now() } : null;
    }, true);
    listen(win.document, "pointercancel", () => { down = null; }, true);
    listen(win.document, "pointerup", e => {
      const start = down; down = null;
      const tool = internalReader(this.reader)?._state?.tool?.type;
      if (!this.enabled || !start || ![undefined, "pointer", "hand"].includes(tool) || this.hasSelection()) return;
      if (Date.now() - start.time > 400 || Math.hypot(e.clientX - start.x, e.clientY - start.y) > 6) return;
      const page = e.target.closest?.(".page[data-page-number]");
      if (page) this.chooseAt(Number(page.dataset.pageNumber) - 1, e.clientX, e.clientY).catch(e => this.error(e));
    }, true);
    listen(win, "keydown", e => this.handleKeyDown(e).catch(error => this.error(error)), true);
    listen(win, "wheel", event => this.cancelNavigation({ preserveFocus: !!(event.ctrlKey || event.metaKey) }), true);
    listen(win, "touchstart", () => this.cancelNavigation(), true);
    const viewportChanged = () => this.onViewportChange();
    listen(win, "scroll", viewportChanged, true);
    listen(win, "resize", () => this.onScaleChange(false));
    listen(win, "unload", () => this.dispose());
    if (this.doc?.addEventListener) listen(this.doc, "visibilitychange", () => {
      if (!this.isActive()) this.cancelNavigation(); else this.onViewportChange();
    });
    if (Zotero.Notifier?.registerObserver) {
      const observer = { notify: (event, type) => {
        if (type !== "tab" || event !== "select") return;
        if (!this.isActive()) this.cancelNavigation(); else this.onViewportChange();
      } };
      const id = Zotero.Notifier.registerObserver(observer, ["tab"], "adhd-reader-guide");
      this.cleanups.push(() => Zotero.Notifier.unregisterObserver(id));
    }
    const bus = this.app.eventBus;
    const scaleChanged = () => this.onScaleChange();
    bus.on("scalechanging", scaleChanged); this.cleanups.push(() => bus.off("scalechanging", scaleChanged));
    for (const name of ["rotationchanging"]) {
      const refresh = () => this.ensureOrientation().catch(e => this.error(e));
      bus.on(name, refresh); this.cleanups.push(() => bus.off(name, refresh));
    }
    for (const name of ["pagerendered", "updateviewarea"]) {
      bus.on(name, viewportChanged); this.cleanups.push(() => bus.off(name, viewportChanged));
    }
    this.lastScrollPosition = this.scrollPosition(); this.priorScheme = core?._state?.colorScheme;
  }
  hasSelection() {
    if (this.win?.document.getSelection()?.isCollapsed === false) return true;
    const ranges = internalReader(this.reader)?._primaryView?._selectionRanges;
    for (let i = 0; i < (ranges?.length || 0); i++) if (!ranges[i].collapsed && ranges[i].text?.trim()) return true;
    return false;
  }
  async handleKeyDown(e) {
    if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || e.isComposing || e.keyCode === 229) return;
    if (e.key === "Escape" && this.closeMenus({ focusReader: true })) { e.preventDefault(); e.stopImmediatePropagation(); return; }
    const target = e.target;
    if (target?.isContentEditable || target?.closest?.("input,textarea,select,button,summary,a[href],[contenteditable]:not([contenteditable=false]),[role=textbox],[role=button],[role=dialog],dialog,.dialog-popup-overlay,.modal-popup")) return;
    if (["PageUp", "PageDown", "Home", "End", " "].includes(e.key)) { this.cancelNavigation(); return; }
    if (!["ArrowUp", "ArrowDown", "Enter"].includes(e.key)) return;
    const core = internalReader(this.reader);
    if (!this.enabled || !this.isActive() || this.hasSelection() || core?._state?.selectedAnnotationIDs?.length || ![undefined, "pointer", "hand"].includes(core?._state?.tool?.type)) return;
    e.preventDefault(); e.stopImmediatePropagation();
    await this.move(e.key === "ArrowUp" ? -1 : 1);
  }
  async rows(pageIndex) {
    const app = this.app, epoch = this.layoutEpoch;
    if (!app) return [];
    const page = unwrapReaderObject(await app.pdfDocument.getPage(pageIndex + 1));
    if (this.app !== app || epoch !== this.layoutEpoch) return [];
    const pageView = app.pdfViewer.getPageView(pageIndex);
    // Offscreen page views may still have the first page's placeholder dimensions.
    // Attach page metadata before measuring/navigation; this does not rasterize it.
    if (pageView && !pageView.pdfPage && pageView.setPdfPage) pageView.setPdfPage(page);
    // PDF zoom changes the display transform, not the reading units. Cache one
    // canonical geometry per page/orientation and map it through the live page.
    // rotationchanging may precede page-view viewport updates (and fit zoom).
    // The viewer's committed rotation, plus intrinsic page rotation, owns the
    // canonical layout even while the display still shows its old viewport.
    const desiredRotation = () => typeof app.pdfViewer.pagesRotation === "number"
      ? (((page.rotate || 0) + app.pdfViewer.pagesRotation) % 360 + 360) % 360
      : pageView?.viewport?.rotation ?? (page.rotate || 0);
    const rotation = desiredRotation();
    const viewport = unwrapReaderObject(page.getViewport(readerOptions({ scale: 1, rotation }, this.win)));
    const key = `${pageIndex}:${rotation}`;
    if (!this.cache.has(key)) {
      let pending = this.pendingRows.get(key);
      if (!pending) {
        pending = (async () => {
          const content = unwrapReaderObject(await page.getTextContent());
          if (this.app !== app || epoch !== this.layoutEpoch) return null;
          const metrics = glyphMetrics;
          let metricPage = this.metricPages.get(page);
          if (!metricPage) {
            metricPage = { commonObjs: { has: key => page.commonObjs?.has(key), get: key => unwrapReaderObject(page.commonObjs?.get(key)) } };
            if (page.getOperatorList) metricPage.getOperatorList = async () => metricPage.operators ||= unwrapReaderObject(await page.getOperatorList());
            this.metricPages.set(page, metricPage);
          }
          const ops = unwrapReaderObject(this.win?.pdfjsLib?.OPS);
          const maps = Object.values(content.styles || {}).some(style => !metrics.ordinaryMetrics(style)) ? await metrics.glyphMapForPage(metricPage, ops) : new Map();
          if (this.app !== app || epoch !== this.layoutEpoch) return null;
          const metricsForItem = item => metrics.fontMetrics(metricPage, item.fontName, content.styles?.[item.fontName], content.styles || {}, item.str, maps, this.win?.document);
          const structures = metricPage.getOperatorList && ops ? metrics.extractDrawingStructures(await metricPage.getOperatorList(), ops, viewport) : { rules: [] };
          if (this.app !== app || epoch !== this.layoutEpoch) return null;
          return { ...makePageLayout(content.items, viewport, content.styles, metricsForItem, structures), viewport };
        })();
        this.pendingRows.set(key, pending);
      }
      let data;
      try { data = await pending; } finally { if (this.pendingRows.get(key) === pending) this.pendingRows.delete(key); }
      if (this.app !== app || epoch !== this.layoutEpoch) return [];
      this.cache.set(key, data);
    }
    if (desiredRotation() !== rotation) return this.rows(pageIndex);
    this.pageData ||= new Map();
    const data = this.cache.get(key), previous = this.pageData.get(pageIndex);
    const locked = this.lockedFocus(), anchor = locked?.page === pageIndex && { ...locked };
    this.pageData.set(pageIndex, data);
    if (anchor && (previous !== data || !this.current)) this.remapFocus(anchor, data.rows);
    return data.rows;
  }
  viewportBounds() {
    const el = this.scroller(), rect = el?.getBoundingClientRect?.();
    const left = rect ? rect.left + (el.clientLeft || 0) : 0, top = rect ? rect.top + (el.clientTop || 0) : 0;
    const width = el?.clientWidth || this.win?.innerWidth || 100000, height = el?.clientHeight || this.win?.innerHeight || 100000;
    return { left, top, right: left + width, bottom: top + height, width, height };
  }
  screenBox(position = this.current) {
    const data = position && this.pageData?.get(position.page), row = data?.rows[position.index];
    const div = position && this.app?.pdfViewer.getPageView?.(position.page)?.div;
    if (!row || !div?.clientWidth || !div?.clientHeight) return null;
    const rect = div.getBoundingClientRect(), actual = this.app.pdfViewer.getPageView(position.page)?.viewport;
    let sx = div.clientWidth / data.viewport.width, sy = div.clientHeight / data.viewport.height;
    let box = focusBox(data.rows, position.index, 6 / sx, 3 / sy);
    if (actual && actual.rotation !== data.viewport.rotation) {
      const a = data.viewport.transform, b = actual.transform, determinant = a[0] * a[3] - a[1] * a[2];
      const points = [[box.x, box.y], [box.right, box.y], [box.x, box.bottom], [box.right, box.bottom]].map(([x, y]) => {
        const px = ((x - a[4]) * a[3] - (y - a[5]) * a[2]) / determinant;
        const py = ((y - a[5]) * a[0] - (x - a[4]) * a[1]) / determinant;
        return [b[0] * px + b[2] * py + b[4], b[1] * px + b[3] * py + b[5]];
      });
      box = { x: Math.min(...points.map(p => p[0])), y: Math.min(...points.map(p => p[1])), right: Math.max(...points.map(p => p[0])), bottom: Math.max(...points.map(p => p[1])) };
      box.width = box.right - box.x; box.height = box.bottom - box.y;
      sx = div.clientWidth / actual.width; sy = div.clientHeight / actual.height;
    }
    const left = rect.left + (div.clientLeft || 0) + box.x * sx, top = rect.top + (div.clientTop || 0) + box.y * sy;
    return { left, top, right: left + box.width * sx, bottom: top + box.height * sy, width: box.width * sx, height: box.height * sy };
  }
  intersects(box, bounds = this.viewportBounds()) { return !!box && box.bottom > bounds.top && box.top < bounds.bottom && box.right > bounds.left && box.left < bounds.right; }
  fullyVisible(box, bounds = this.viewportBounds()) {
    return !!box && box.top >= bounds.top + 7.5 && box.bottom <= bounds.bottom - 7.5 && box.left >= bounds.left - .5 && box.right <= bounds.right + .5;
  }
  visiblePages() {
    const indices = [], viewer = this.app?.pdfViewer;
    try {
      const views = viewer?._getVisiblePages?.()?.views;
      for (let i = 0; i < (views?.length || 0); i++) if (views[i].id > 0) indices.push(views[i].id - 1);
    } catch {}
    if (!indices.length && viewer) {
      const current = (viewer.currentPageNumber || 1) - 1;
      for (let page = Math.max(0, current - 1); page <= Math.min(this.app.pdfDocument.numPages - 1, current + 1); page++) {
        const div = viewer.getPageView(page)?.div, r = div?.getBoundingClientRect();
        if (r && this.intersects({ left:r.left,top:r.top,right:r.right ?? r.left+div.clientWidth,bottom:r.bottom ?? r.top+div.clientHeight })) indices.push(page);
      }
    }
    return indices.sort((a, b) => a - b);
  }
  visibleCandidate(pages = this.visiblePages()) {
    const candidates = pages.flatMap(page => {
      const data = this.pageData?.get(page);
      if (!data || data.viewport.rotation !== this.pageOrientation(page)) return [];
      return data.rows.map((row, index) => ({ page, index,
        flowId: row.flowId == null ? undefined : `${page}:${row.flowId}`, regionId: row.regionId == null ? undefined : `${page}:${row.regionId}` }));
    });
    const previousIndex = candidates.findIndex(value => value.page === this.current?.page && value.index === this.current?.index);
    const selected = glyphMetrics.chooseVisibleReadingLine(candidates, { previousIndex, viewport: this.viewportBounds(), direction: this.scrollDirection,
      boundsForLine: value => this.screenBox(value) });
    const best = candidates[selected];
    return best && { page: best.page, index: best.index };
  }
  chooseVisibleCached(pages = this.visiblePages()) {
    const candidate = this.visibleCandidate(pages);
    if (!candidate) return false;
    this.selectFocus(candidate); return true;
  }
  viewportPage() {
    const pages = this.visiblePages(), bounds = this.viewportBounds(), cursor = bounds.top + bounds.height * .35;
    let best, distance = Infinity;
    for (const page of pages) {
      const div = this.app.pdfViewer.getPageView(page)?.div, rect = div?.getBoundingClientRect();
      if (!rect) continue;
      const d = Math.max(rect.top - cursor, cursor - (rect.top + div.clientHeight), 0);
      if (d < distance) { distance = d; best = page; }
    }
    return best ?? Math.max(0, (this.app?.pdfViewer.currentPageNumber || 1) - 1);
  }
  prefetchNeighbors() {
    if (!this.enabled || !this.isActive() || !this.current || !this.win?.document || !this.scroller()) return;
    for (const page of [this.current.page - 1, this.current.page + 1]) if (page >= 0 && page < this.app.pdfDocument.numPages) this.rows(page).catch(() => {});
  }
  async followVisible({ initialize = false } = {}) {
    if (!this.enabled || !this.isActive() || this.runner || this.scrollMotion?.active || this.geometrySettling || this.layoutRefreshOwner != null || this.orientationRefresh) return false;
    if (this.lockedFocus() || !initialize) { this.paint(); return !!this.current; }
    const owner = this.operation, version = ++this.followVersion;
    const before = this.scrollPosition();
    const pages = this.visiblePages();
    if (this.chooseVisibleCached(pages)) { this.paint(); this.prefetchNeighbors(); return true; }
    this.paint();
    await Promise.all(pages.map(page => this.rows(page)));
    const after = this.scrollPosition();
    if (!this.valid(owner) || this.lockedFocus() || before.top !== after.top || before.left !== after.left || version !== this.followVersion || this.runner || this.scrollMotion?.active || this.geometrySettling || this.layoutRefreshOwner != null || this.orientationRefresh) return false;
    const found = this.chooseVisibleCached(); this.paint(); this.prefetchNeighbors(); return found;
  }
  onViewportChange() {
    if (!this.enabled || !this.app || !this.isActive()) return;
    if (this.orientationRequest()) { this.ensureOrientation().catch(error => this.error(error)); this.paint(); return; }
    // PDF.js can publish its new scale through updateviewarea before the
    // scalechanging event. Establish ownership before visible-line following.
    const saved = this.stableFocus, viewer = this.app.pdfViewer;
    const live = saved && viewer.getPageView(saved.page)?.viewport;
    if (!this.geometrySettling && saved && saved.win === this.win && saved.document === this.app.pdfDocument && saved.epoch === this.layoutEpoch
      && live?.rotation === saved.rotation && (live.scale !== saved.scale || viewer.currentScale !== saved.viewerScale)) {
      this.onScaleChange(); return;
    }
    if (this.geometrySettling) this.compensateScale(this.geometrySettling);
    const now = this.scrollPosition(), prior = this.lastScrollPosition;
    if (prior && (now.top !== prior.top || now.left !== prior.left)) {
      this.scrollDirection = Math.sign(now.top - prior.top) || this.scrollDirection;
      const expected = this.scrollMotion?.isExpectedPosition(now) || this.scrollTarget && Math.abs(now.top - this.scrollTarget.top) < 1 && Math.abs(now.left - this.scrollTarget.left) < 1;
      if ((this.runner || this.scrollMotion?.active) && !this.committing && !expected) this.cancelNavigation();
    }
    this.lastScrollPosition = now;
    this.paint();
    if (!this.runner && !this.scrollMotion?.active && !this.geometrySettling && this.layoutRefreshOwner == null && !this.orientationRefresh) this.followVisible().catch(e => this.error(e));
  }
  async refreshLayout() {
    const locked = this.lockedFocus(), anchor = locked && { ...locked };
    this.cancelNavigation(); const owner = this.operation;
    this.layoutEpoch++; this.cache.clear(); this.pendingRows.clear();
    this.layoutRefreshOwner = owner;
    this.paint();
    try {
      if (anchor) {
        await this.rows(anchor.page);
        if (!this.valid(owner)) return;
      }
    } finally { if (this.layoutRefreshOwner === owner) this.layoutRefreshOwner = null; }
    if (this.valid(owner)) await this.followVisible();
  }
  async chooseAt(page, x, y) {
    this.cancelNavigation(); const owner = this.operation, before = this.scrollPosition();
    const originalDiv = this.app?.pdfViewer.getPageView(page)?.div;
    const originalRect = originalDiv?.getBoundingClientRect();
    const geometry = originalRect && [originalRect.left, originalRect.top, originalDiv.clientWidth, originalDiv.clientHeight];
    const rows = await this.rows(page);
    const after = this.scrollPosition();
    if (!this.valid(owner) || before.top !== after.top || before.left !== after.left) return false;
    const div = this.app.pdfViewer.getPageView(page)?.div;
    if (!div || !rows.length) return false;
    const rect = div.getBoundingClientRect(), data = this.pageData.get(page), viewport = data.viewport;
    if (geometry && [rect.left, rect.top, div.clientWidth, div.clientHeight].some((value, index) => Math.abs(value - geometry[index]) > .1)) return false;
    const index = closestRow(rows, (x - rect.left - (div.clientLeft || 0)) * viewport.width / div.clientWidth, (y - rect.top - (div.clientTop || 0)) * viewport.height / div.clientHeight, data.excludedRows, data.excludedRegions || data.figureRegions);
    if (index < 0) return false;
    this.selectFocus({ page, index }); this.paint(); this.prefetchNeighbors(); return true;
  }
  move(delta) {
    if (!this.enabled || !this.isActive() || !this.app || !delta) return Promise.resolve(false);
    if (this.geometrySettling || this.layoutRefreshOwner != null) this.cancelNavigation();
    // Explicit input owns the viewport as it exists now. A delayed host
    // notification for browsing that preceded this key must not cancel it.
    this.lastScrollPosition = this.scrollPosition();
    this.followVersion++;
    const owner = this.operation;
    const result = new Promise((resolve, reject) => this.pendingMoves.push({ delta: Math.sign(delta), owner, resolve, reject }));
    if (!this.runner) this.drainMoves();
    return result;
  }
  async drainMoves() {
    const runner = {}; this.runner = runner;
    try {
      while (this.runner === runner && this.pendingMoves.length) {
        const job = this.pendingMoves.shift(); runner.job = job;
        try { job.resolve(await this.performMove(job.delta, job.owner)); } catch (e) { job.reject(e); }
        runner.job = null;
      }
    } finally { if (this.runner === runner) { this.runner = null; this.paint(); } }
  }
  async performMove(delta, owner) {
    if (!this.valid(owner)) return false;
    const anchor = this.lockedFocus(), previousPage = anchor?.page;
    let page = anchor ? anchor.page : this.viewportPage();
    const rowsAtStart = await this.rows(page);
    if (!this.valid(owner)) return false;
    let rows = rowsAtStart, index = null;
    if (anchor) {
      const mapped = anchor.item === undefined ? anchor.index : rows.findIndex(row => row.items.some(item => item.index === anchor.item));
      if (mapped < 0 || !rows[mapped]) {
        // An explicit reading key may leave a source newly classified as a
        // table. Only the shared reading tree supplies its adjacent prose.
        const layout = this.pageData.get(page);
        const excluded = anchor.item !== undefined && layout?.excludedRows?.find(row => row.readingRole === "table" && row.items.some(item => item.index === anchor.item));
        const region = excluded && layout.tableRegions?.find(region => region.id === excluded.tableRegionId);
        const adjacent = region?.readingNeighbors?.[delta > 0 ? "next" : "previous"];
        if (adjacent === null) index = delta > 0 ? rows.length : -1;
        else if (Array.isArray(adjacent)) {
          const sources = new Set(adjacent);
          index = rows.findIndex(row => row.items.some(item => sources.has(item.index)));
          if (index < 0) { this.paint(); return false; }
        } else { this.paint(); return false; }
      } else { this.remapFocus(anchor, rows); index = mapped + delta; }
    }
    if (index === null) {
      const visible = this.visibleCandidate([page]);
      if (visible) index = visible.index;
      else {
        const bounds = this.viewportBounds();
        index = delta > 0 ? rows.findIndex((row, i) => this.screenBox({page,index:i})?.bottom > bounds.top) : -1;
        if (delta < 0) for (let i = rows.length - 1; i >= 0; i--) if (this.screenBox({page,index:i})?.top < bounds.bottom) { index = i; break; }
        if (delta > 0 && index < 0) index = rows.length;
      }
    }
    while (index < 0 || index >= rows.length) {
      if (page + delta < 0 || page + delta >= this.app.pdfDocument.numPages) { this.revealCurrent(owner, false, delta); this.paint(); return false; }
      page += delta; rows = await this.rows(page); if (!this.valid(owner)) return false;
      index = delta > 0 ? 0 : rows.length - 1;
    }
    this.selectFocus({ page, index });
    this.revealCurrent(owner, page !== previousPage, delta); this.paint(); this.prefetchNeighbors();
    if (this.valid(owner)) this.win?.focus?.();
    return true;
  }
  revealCurrent(owner, center = false, direction = 0) {
    if (!this.valid(owner)) return;
    const container = this.scroller(), visible = this.screenBox();
    if (!container || !visible) return;
    const position = this.scrollPosition(), pending = !center && this.scrollMotion?.active && this.scrollMotion.target;
    const projected = pending ? { ...visible, top: visible.top + position.top - pending.top, bottom: visible.bottom + position.top - pending.top,
      left: visible.left + position.left - pending.left, right: visible.right + position.left - pending.left } : visible;
    const target = glyphMetrics.readingScrollTarget(projected, this.viewportBounds(), pending || position, { center, direction });
    target.top = Math.max(0, Math.min(target.top, Math.max(0, container.scrollHeight - container.clientHeight)));
    target.left = Math.max(0, Math.min(target.left, Math.max(0, container.scrollWidth - container.clientWidth)));
    this.scrollOwner = { operation: owner, epoch: this.layoutEpoch };
    this.ensureScrollMotion().retarget(target.top, target.left);
  }
  paint() {
    if (!this.overlay) return;
    if (!this.enabled) { this.overlay.style.display = "none"; return; }
    const box = this.screenBox(), bounds = this.viewportBounds();
    const visible = this.intersects(box, bounds);
    // Mask state belongs to the enabled guide, including empty pages and pending text extraction.
    Object.assign(this.overlay.style, { display:"block", top:`${visible ? box.top : bounds.top}px`, left:`${visible ? box.left : bounds.left}px`, width:`${visible ? box.width : 0}px`, height:`${visible ? box.height : 0}px`, boxShadow:`0 0 0 200vmax rgba(${this.dark ? "26,26,26" : "255,255,255"},${this.level})` });
    if (visible && !this.geometrySettling && this.layoutRefreshOwner == null) {
      const row = this.pageData?.get(this.current.page)?.rows[this.current.index], viewport = this.app.pdfViewer.getPageView(this.current.page)?.viewport;
      this.stableFocus = { page: this.current.page, index: this.current.index, item: this.lockedFocus()?.item ?? row?.items[0]?.index, win: this.win, document: this.app.pdfDocument, epoch: this.layoutEpoch,
        ratio: ((box.top + box.bottom) / 2 - bounds.top) / bounds.height, scale: viewport?.scale, rotation: viewport?.rotation, viewerScale: this.app.pdfViewer.currentScale };
    } else if (!visible && !this.geometrySettling) this.stableFocus = null;
  }
  async toggle() {
    const desired = !(this.toggleDesired ?? this.enabled), version = ++this.toggleVersion;
    this.toggleDesired = desired;
    try {
      if (!desired) {
        this.enabled = false; this.cancelNavigation();
        internalReader(this.reader)?.setColorScheme?.(this.priorScheme); this.paint();
      } else {
        await this.attach();
        if (version !== this.toggleVersion || !this.isActive()) return;
        this.cancelNavigation(); const owner = this.operation;
        this.enabled = true; this.priorScheme = internalReader(this.reader)?._state?.colorScheme;
        this.lastScrollPosition = this.scrollPosition();
        internalReader(this.reader)?.setColorScheme?.(this.dark ? "dark" : "light");
        this.paint(); await this.followVisible({ initialize: !this.lockedFocus() });
        if (this.valid(owner)) this.win?.focus?.();
      }
    } finally {
      if (version === this.toggleVersion) { this.toggleDesired = undefined; this.updateButtons(); }
    }
  }
  updateButtons() {
    for (const button of this.buttons) {
      if (!button.isConnected) { this.buttons.delete(button); continue; }
      button.setAttribute("aria-pressed", String(this.enabled));
      button.style.background = this.enabled ? "#ececec" : "transparent";
      button.style.color = this.enabled ? "#222" : "inherit";
    }
  }
  error(error) {
    if (this.disposed) return;
    Zotero.logError(error);
    const button = [...this.buttons].find(b => b.isConnected);
    if (button) { button.title = error.message; button.textContent = "重试行读"; }
  }
  detach() {
    this.cancelNavigation(); this.layoutEpoch++;
    this.orientationRefresh = null;
    this.scrollMotion = null;
    for (const cleanup of this.cleanups.splice(0)) { try { cleanup(); } catch {} }
    this.overlay?.remove(); this.overlay = null;
    this.cache.clear(); this.pendingRows.clear(); this.pageData?.clear(); this.metricPages = new WeakMap(); this.current = null; this.focusAnchor = null; this.win = null; this.app = null;
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    if (this.enabled) { try { internalReader(this.reader)?.setColorScheme?.(this.priorScheme); } catch {} }
    this.detach();
    for (const cleanup of this.toolbarDocuments.values()) cleanup();
    this.toolbarDocuments.clear(); this.menus.clear();
    for (const button of this.buttons) (button.closest(".linea-toolbar-section") || button.closest(".linea-toolbar"))?.remove();
    this.buttons.clear(); sessions.delete(this.reader);
  }
}

function renderToolbar({ reader, doc, append }) {
  if (reader.type !== "pdf") return;
  if (doc.querySelector?.(".toolbar .end .custom-sections .linea-toolbar")) return;
  let session = sessions.get(reader);
  if (!session) { session = new GuideSession(reader, doc); sessions.set(reader, session); }
  const container = doc.createElement("div");
  container.className = "linea-toolbar";
  container.style.cssText = "display:flex;align-items:center;gap:4px;margin-inline:5px;font:12px system-ui;";
  // Zotero's toolbar is a native window-drag region. Exempt the complete
  // extension control tree, including settings opened outside the toolbar row.
  // DOM click dispatch alone cannot test the OS hit testing that consumes drags.
  const interactionStyle = doc.createElement("style");
  interactionStyle.textContent = ".linea-toolbar, .linea-toolbar * { -moz-window-dragging: no-drag; }";
  container.append(interactionStyle);
  const button = (label, title, action) => {
    const el = doc.createElement("button");
    el.type = "button"; el.textContent = label; el.title = title;
    el.setAttribute("aria-label", title);
    el.style.cssText = "height:28px;padding:0 8px;border:0;border-radius:6px;background:transparent;color:inherit;cursor:pointer;white-space:nowrap;font:inherit;";
    el.addEventListener("click", () => Promise.resolve(action(el)).catch(e => session.error(e)));
    container.append(el); return el;
  };
  const toggle = button("行读", "逐行聚焦 · 点击定位 · ↑ ↓ Enter 换行", async el => { await session.toggle(); el.textContent = "行读"; });
  toggle.setAttribute("aria-pressed", String(session.enabled)); session.buttons.add(toggle);
  const controls = doc.createElement("details"); controls.style.position = "relative";
  const summary = doc.createElement("summary"); summary.textContent = "⋯"; summary.title = "行读设置";
  summary.style.cssText = "display:flex;align-items:center;justify-content:center;box-sizing:border-box;height:28px;min-width:28px;cursor:pointer;list-style:none;padding:0 6px;font-weight:bold;";
  controls.append(summary);
  const panel = doc.createElement("div");
  panel.style.cssText = "position:absolute;right:0;top:32px;z-index:10000;width:180px;padding:14px;border:1px solid #d5d5d5;border-radius:10px;background:Canvas;color:CanvasText;box-shadow:0 8px 30px #0002;display:grid;gap:12px;";
  const label = doc.createElement("label"); label.textContent = "淡化背景";
  const slider = doc.createElement("input"); slider.type = "range"; slider.min = "20"; slider.max = "95"; slider.value = String(Math.round(session.level * 100)); slider.setAttribute("aria-label", "背景淡化程度"); slider.style.width = "100%";
  slider.addEventListener("input", () => { session.level = Number(slider.value) / 100; Zotero.Prefs.set(LINEA_PREF + "dim", Number(slider.value), true); session.paint(); });
  label.append(slider); panel.append(label);
  const theme = doc.createElement("button"); theme.type = "button"; theme.textContent = "夜间模式";
  theme.addEventListener("click", () => { session.dark = !session.dark; theme.textContent = session.dark ? "白天模式" : "夜间模式"; if (session.enabled) internalReader(reader)?.setColorScheme?.(session.dark ? "dark" : "light"); session.paint(); });
  panel.append(theme);
  const exportButton = doc.createElement("button"); exportButton.type = "button"; exportButton.textContent = "导出带标注的 PDF";
  exportButton.addEventListener("click", () => { controls.open = false; reader.export(); });
  panel.append(exportButton); controls.append(panel); container.append(controls);
  session.registerMenu(controls, doc);
  append(container); session.updateButtons();
}

async function mountExistingReader(reader, generation) {
  if (reader.type !== "pdf") return;
  await reader._initPromise;
  if (!running || generation !== startupGeneration || reader._isUninitialized || reader._isTabClosed) return;
  const doc = reader._iframeWindow?.document;
  const slot = doc?.querySelector(".toolbar .end .custom-sections");
  if (!slot || slot.querySelector(".linea-toolbar")) return;
  // Registering an event does not rerender Zotero's memoized toolbar slot.
  // Backfill this existing slot once; future toolbars use the normal event.
  renderToolbar({ reader, doc, append: element => {
    const section = doc.createElement("div");
    section.className = "section linea-toolbar-section";
    section.append(element); slot.append(section);
  } });
}

async function startup(data) {
  running = true;
  const generation = ++startupGeneration;
  await Zotero.initializationPromise;
  if (!running || generation !== startupGeneration) return;
  const scope = {};
  // Zotero's bootstrap contract passes rootURI as a string (including jar: XPI roots).
  const rootURI = data.rootURI || data.resourceURI?.spec;
  if (typeof rootURI !== "string") throw new Error("ADHD Reader 插件资源路径不可用");
  const resourceURL = path => `${rootURI.endsWith("/") ? rootURI : rootURI + "/"}${path}`;
  Services.scriptloader.loadSubScript(resourceURL("glyph-metrics.js"), scope, "UTF-8");
  glyphMetrics = scope.ADHDGlyphMetrics;
  toolbarHandler = renderToolbar;
  Zotero.Reader.registerEventListener("renderToolbar", toolbarHandler, LINEA_ID);
  for (const reader of Zotero.Reader._readers || []) {
    mountExistingReader(reader, generation).catch(error => {
      if (running && generation === startupGeneration) Zotero.logError(error);
    });
  }
}

function shutdown() {
  running = false;
  startupGeneration++;
  if (toolbarHandler) Zotero.Reader.unregisterEventListener("renderToolbar", toolbarHandler);
  for (const session of [...sessions.values()]) session.dispose();
  sessions.clear(); toolbarHandler = null; glyphMetrics = null;
}

function install() {}
function uninstall() {}
