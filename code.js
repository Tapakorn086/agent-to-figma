// Agent to Figma — sandbox side.
// Reads the selected Section as context for an agent, and draws the agent's ops into it
// after the user previews them and presses Sync.

/* domain:start */
const OP_KINDS = ['frame', 'rect', 'ellipse', 'text', 'line'];
const GAP = 24;
const MAX_OPS = 500;

function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(hex || '').trim());
  if (!m) return null;
  let h = m[1];
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const n = parseInt(h, 16);
  return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255 };
}

function num(v) {
  return typeof v === 'number' && isFinite(v) ? v : undefined;
}

// Turn the agent's JSON into a list of ops checked against the section size.
// Positions are relative to the section's top-left. An op without x/y is stacked
// below the previous top-level op. Returns { ops, errors }; ops with errors are dropped.
// bounds: { width, height, startY? }. startY is where unplaced ops begin (default GAP).
function validateOps(input, bounds) {
  const errors = [];
  let list = input;
  if (typeof list === 'string') {
    try {
      list = JSON.parse(list);
    } catch (e) {
      return { ops: [], errors: ['JSON ไม่ถูกต้อง: ' + e.message] };
    }
  }
  if (list && !Array.isArray(list)) list = list.ops;
  if (!Array.isArray(list)) return { ops: [], errors: ['ต้องเป็น array ของ ops หรือ { "ops": [...] }'] };
  if (list.length > MAX_OPS) return { ops: [], errors: [`ops เกิน ${MAX_OPS} รายการ`] };

  const ops = [];
  const ids = new Set();
  let cursorY = bounds?.startY ?? GAP;
  list.forEach((raw, i) => {
    const where = `op #${i + 1}`;
    if (!raw || typeof raw !== 'object') return errors.push(`${where}: ไม่ใช่ object`);
    const op = String(raw.op || '').toLowerCase();
    if (!OP_KINDS.includes(op)) return errors.push(`${where}: ไม่รู้จัก op "${raw.op}" (ใช้ได้: ${OP_KINDS.join(', ')})`);
    const parent = raw.parent != null ? String(raw.parent) : undefined;
    if (parent !== undefined && !ids.has(parent)) return errors.push(`${where}: parent "${parent}" ต้องเป็น frame ที่ประกาศไว้ก่อนหน้า`);
    if (op === 'text' && !raw.text) return errors.push(`${where}: text ต้องมี "text"`);

    const isText = op === 'text';
    const w = num(raw.w) ?? (isText ? undefined : 200);
    const h = num(raw.h) ?? (isText ? undefined : op === 'line' ? 0 : 120);
    const x = num(raw.x) ?? GAP;
    const y = num(raw.y) ?? (parent ? GAP : cursorY);
    if (w !== undefined && w < 0) return errors.push(`${where}: w ต้องไม่ติดลบ`);
    if (h !== undefined && h < 0) return errors.push(`${where}: h ต้องไม่ติดลบ`);

    if (!parent && bounds) {
      const right = x + (w ?? 0);
      const bottom = y + (h ?? 0);
      if (x < 0 || y < 0 || right > bounds.width || bottom > bounds.height) {
        return errors.push(`${where}: อยู่นอก section (${Math.round(x)},${Math.round(y)} ขนาด ${w ?? '?'}×${h ?? '?'} ใน ${Math.round(bounds.width)}×${Math.round(bounds.height)})`);
      }
    }

    const fill = raw.fill != null ? hexToRgb(raw.fill) : undefined;
    if (raw.fill != null && !fill) return errors.push(`${where}: fill "${raw.fill}" ไม่ใช่สี hex`);
    const stroke = raw.stroke != null ? hexToRgb(raw.stroke) : undefined;
    if (raw.stroke != null && !stroke) return errors.push(`${where}: stroke "${raw.stroke}" ไม่ใช่สี hex`);

    const clean = { op, x, y, w, h, index: i };
    if (raw.id != null) {
      clean.id = String(raw.id);
      if (ids.has(clean.id)) return errors.push(`${where}: id "${clean.id}" ซ้ำ`);
    }
    if (parent) clean.parent = parent;
    if (raw.name) clean.name = String(raw.name);
    if (fill) clean.fill = fill;
    if (stroke) clean.stroke = stroke;
    if (num(raw.radius) !== undefined) clean.radius = raw.radius;
    if (isText) {
      clean.text = String(raw.text);
      clean.fontSize = num(raw.fontSize) ?? 16;
      clean.bold = !!raw.bold;
    }
    if (op === 'frame' && raw.layout) {
      const layout = String(raw.layout).toLowerCase();
      if (layout === 'vertical' || layout === 'horizontal') clean.layout = layout.toUpperCase();
    }
    if (clean.id) ids.add(clean.id);
    // Text height is unknown before drawing; estimate one line per newline
    const height = h ?? (isText ? clean.fontSize * 1.4 * (clean.text.split('\n').length) : 0);
    if (!parent) cursorY = Math.max(cursorY, y + height + GAP);
    ops.push(clean);
  });
  // A parent must be a frame
  const frames = new Set(ops.filter((o) => o.op === 'frame' && o.id).map((o) => o.id));
  const kept = ops.filter((o) => {
    if (o.parent && !frames.has(o.parent)) {
      errors.push(`op #${o.index + 1}: parent "${o.parent}" ไม่ใช่ frame`);
      return false;
    }
    return true;
  });
  return { ops: kept, errors };
}

// One-line summary per op for the preview list
function describeOp(o) {
  const size = o.w !== undefined ? ` ${Math.round(o.w)}×${Math.round(o.h ?? 0)}` : '';
  const label = o.text ? ` "${o.text.length > 40 ? o.text.slice(0, 40) + '…' : o.text}"` : o.name ? ` ${o.name}` : '';
  const inside = o.parent ? ` ใน ${o.parent}` : '';
  return `${o.op}${label} @${Math.round(o.x)},${Math.round(o.y)}${size}${inside}`;
}

// Markdown outline of a serialized node tree, for pasting to an agent
function outline(tree, depth = 0) {
  const pad = '  '.repeat(depth);
  const pos = tree.x !== undefined ? ` @${tree.x},${tree.y} ${tree.width}×${tree.height}` : '';
  const text = tree.text ? `: "${tree.text}"` : '';
  let out = `${pad}- [${tree.type}] ${tree.name}${pos}${text}\n`;
  for (const c of tree.children || []) out += outline(c, depth + 1);
  return out;
}
/* domain:end */

const RUN_KEY = 'agentRun';
const MAX_DEPTH = 6;

figma.showUI(__html__, { width: 420, height: 620, themeColors: true });

function selectedSection() {
  const sel = figma.currentPage.selection;
  if (sel.length !== 1) return null;
  const n = sel[0];
  return n.type === 'SECTION' || n.type === 'FRAME' ? n : null;
}

// Same key format as figma-to-notion's "Figma key" column, so rows can be matched in Notion
function figmaKey(node) {
  return `${figma.fileKey || 'local'}:${node.id}`;
}

// Enclosing Sections/Frames from the nearest up to the page
function ancestors(node) {
  const out = [];
  for (let p = node.parent; p && p.type !== 'PAGE' && p.type !== 'DOCUMENT'; p = p.parent) {
    out.push({ id: p.id, key: figmaKey(p), name: p.name, type: p.type });
  }
  return out;
}

function sendSelection() {
  const s = selectedSection();
  figma.ui.postMessage({
    type: 'selection',
    section: s
      ? {
          id: s.id,
          key: figmaKey(s),
          name: s.name,
          type: s.type,
          width: Math.round(s.width),
          height: Math.round(s.height),
          page: figma.currentPage.name,
          parents: ancestors(s),
        }
      : null,
    count: figma.currentPage.selection.length,
  });
}

function serialize(node, origin, depth) {
  const out = { type: node.type, name: node.name };
  if ('x' in node && origin) {
    out.x = Math.round(node.absoluteTransform[0][2] - origin.x);
    out.y = Math.round(node.absoluteTransform[1][2] - origin.y);
    out.width = Math.round(node.width);
    out.height = Math.round(node.height);
  }
  if (node.type === 'TEXT') out.text = node.characters;
  else if ((node.type === 'STICKY' || node.type === 'SHAPE_WITH_TEXT') && node.text) out.text = node.text.characters;
  if ('children' in node && depth < MAX_DEPTH) out.children = node.children.map((c) => serialize(c, origin, depth + 1));
  return out;
}

async function readSection(includeImage) {
  const s = selectedSection();
  if (!s) throw new Error('เลือก Section หรือ Frame หนึ่งอันก่อน');
  const origin = { x: s.absoluteTransform[0][2], y: s.absoluteTransform[1][2] };
  const tree = serialize(s, null, 0);
  tree.width = Math.round(s.width);
  tree.height = Math.round(s.height);
  tree.children = 'children' in s ? s.children.map((c) => serialize(c, origin, 1)) : [];
  let png = null;
  if (includeImage) {
    const scale = Math.min(1, 2000 / Math.max(s.width, s.height));
    png = await s.exportAsync({ format: 'PNG', constraint: { type: 'SCALE', value: scale } });
  }
  return { tree, markdown: outline(tree), png };
}

async function loadFonts() {
  const want = [
    { family: 'Inter', style: 'Regular' },
    { family: 'Inter', style: 'Bold' },
  ];
  for (const f of want) {
    try {
      await figma.loadFontAsync(f);
    } catch (e) {
      // Inter is bundled with Figma; if it is missing, text ops fail with a clear message below
    }
  }
}

function paint(rgb) {
  return [{ type: 'SOLID', color: rgb }];
}

// Where the agent's ops start: below the user's own content, so nothing is drawn on top of it.
// In replace mode the previous agent output is removed first, so it is not counted.
function layoutBounds(s, replace) {
  const floor = sectionFloor(s, !replace);
  return { width: s.width, height: s.height, startY: floor > 0 ? floor + GAP : GAP };
}

function sectionFloor(s, includeAgent) {
  let bottom = 0;
  for (const n of s.children) {
    if (!includeAgent && n.getPluginData(RUN_KEY) !== '') continue;
    bottom = Math.max(bottom, n.y + n.height);
  }
  return bottom;
}

async function draw(rawOps, opts = {}) {
  const s = selectedSection();
  if (!s) throw new Error('เลือก Section หรือ Frame หนึ่งอันก่อน');
  // The section keeps its size: ops that do not fit are rejected, not grown into
  const { ops, errors } = validateOps(rawOps, layoutBounds(s, !!opts.replace));
  if (errors.length) throw new Error(errors.join('\n'));
  if (!ops.length) throw new Error('ไม่มี op ให้วาด');

  // Only clear the old output once the new ops are known to be valid
  if (opts.replace) clearAgent();

  await loadFonts();
  const runId = String(Date.now());
  const byId = {};
  const created = [];
  try {
    for (const o of ops) {
      let n;
      if (o.op === 'frame') {
        n = figma.createFrame();
        n.fills = o.fill ? paint(o.fill) : [];
        if (o.layout) {
          n.layoutMode = o.layout;
          n.itemSpacing = 12;
          n.paddingTop = n.paddingBottom = n.paddingLeft = n.paddingRight = 16;
          n.primaryAxisSizingMode = 'AUTO';
          n.counterAxisSizingMode = 'FIXED';
        }
      } else if (o.op === 'rect') {
        n = figma.createRectangle();
        n.fills = paint(o.fill || { r: 0.93, g: 0.93, b: 0.95 });
      } else if (o.op === 'ellipse') {
        n = figma.createEllipse();
        n.fills = paint(o.fill || { r: 0.93, g: 0.93, b: 0.95 });
      } else if (o.op === 'line') {
        n = figma.createLine();
        n.strokes = paint(o.stroke || { r: 0.4, g: 0.4, b: 0.45 });
        n.strokeWeight = 2;
      } else if (o.op === 'text') {
        n = figma.createText();
        n.fontName = { family: 'Inter', style: o.bold ? 'Bold' : 'Regular' };
        n.fontSize = o.fontSize;
        n.characters = o.text;
        if (o.fill) n.fills = paint(o.fill);
        if (o.w !== undefined) {
          n.textAutoResize = 'HEIGHT';
          n.resize(Math.max(1, o.w), n.height);
        }
      }
      if (o.name) n.name = o.name;
      if (o.stroke && o.op !== 'line') {
        n.strokes = paint(o.stroke);
        n.strokeWeight = 1;
      }
      if (o.radius !== undefined && 'cornerRadius' in n) n.cornerRadius = o.radius;
      if (o.op === 'line') n.resize(Math.max(1, o.w), 0);
      else if (o.op !== 'text') n.resize(Math.max(1, o.w), Math.max(1, o.h));

      const parent = o.parent ? byId[o.parent] : s;
      parent.appendChild(n);
      if (!(o.parent && byId[o.parent].layoutMode && byId[o.parent].layoutMode !== 'NONE')) {
        n.x = o.x;
        n.y = o.y;
      }
      n.setPluginData(RUN_KEY, runId);
      if (o.id) byId[o.id] = n;
      created.push(n);
    }
  } catch (e) {
    // Leave nothing half-drawn
    for (const n of created) if (!n.removed) n.remove();
    throw new Error('วาดไม่สำเร็จ ยกเลิกทั้งหมดแล้ว: ' + e.message);
  }
  s.setPluginData('lastRun', runId);
  figma.currentPage.selection = [s];
  return { count: created.length, runId };
}

function undoLast() {
  const s = selectedSection();
  if (!s) throw new Error('เลือก Section ที่จะย้อนกลับก่อน');
  const runId = s.getPluginData('lastRun');
  if (!runId) throw new Error('Section นี้ยังไม่เคย Sync');
  const nodes = s.findAll((n) => n.getPluginData(RUN_KEY) === runId);
  for (const n of nodes) if (!n.removed) n.remove();
  s.setPluginData('lastRun', '');
  return nodes.length;
}

function clearAgent() {
  const s = selectedSection();
  if (!s) throw new Error('เลือก Section ก่อน');
  const nodes = s.findAll((n) => n.getPluginData(RUN_KEY) !== '');
  for (const n of nodes) if (!n.removed) n.remove();
  s.setPluginData('lastRun', '');
  return nodes.length;
}

figma.on('selectionchange', sendSelection);

figma.ui.onmessage = async (msg) => {
  try {
    if (msg.type === 'ready') {
      const settings = (await figma.clientStorage.getAsync('settings')) || {};
      figma.ui.postMessage({ type: 'settings', settings });
      sendSelection();
    } else if (msg.type === 'save-settings') {
      await figma.clientStorage.setAsync('settings', msg.settings);
    } else if (msg.type === 'read') {
      const result = await readSection(msg.image);
      figma.ui.postMessage({ type: 'read-result', forBridge: !!msg.forBridge, ...result });
    } else if (msg.type === 'preview') {
      const s = selectedSection();
      const res = validateOps(msg.ops, s ? layoutBounds(s, !!msg.replace) : null);
      figma.ui.postMessage({ type: 'preview-result', lines: res.ops.map(describeOp), errors: res.errors, hasSection: !!s });
    } else if (msg.type === 'sync') {
      const r = await draw(msg.ops, { replace: !!msg.replace });
      figma.notify(`วาดแล้ว ${r.count} ชิ้น`);
      figma.ui.postMessage({ type: 'done', text: `✓ วาดแล้ว ${r.count} ชิ้นลง section` });
    } else if (msg.type === 'undo') {
      const n = undoLast();
      figma.ui.postMessage({ type: 'done', text: `↶ ลบ ${n} ชิ้นจาก Sync ล่าสุด` });
    } else if (msg.type === 'clear') {
      const n = clearAgent();
      figma.ui.postMessage({ type: 'done', text: `🗑 ลบทุกชิ้นที่ agent วาด (${n})` });
    }
  } catch (e) {
    figma.ui.postMessage({ type: 'error', text: e.message });
  }
};
