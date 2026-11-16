// Run with: npm test
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadDomain(file, names) {
  const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  const regions = [...source.matchAll(/\/\* domain:start \*\/([\s\S]*?)\/\* domain:end \*\//g)].map((m) => m[1]);
  return vm.runInNewContext(regions.join('\n') + `\n;({ ${names.join(', ')} })`, {});
}

const code = loadDomain('code.js', ['validateOps', 'hexToRgb', 'describeOp', 'outline']);
const ui = loadDomain('ui.html', ['parseNotionId', 'firstCodeBlock']);
const box = { width: 800, height: 600 };

test('hexToRgb reads short and long hex', () => {
  assert.deepEqual({ ...code.hexToRgb('#fff') }, { r: 1, g: 1, b: 1 });
  assert.deepEqual({ ...code.hexToRgb('000000') }, { r: 0, g: 0, b: 0 });
  assert.equal(code.hexToRgb('red'), null);
});

test('validateOps accepts a string, an array, or { ops }', () => {
  const op = { op: 'rect', x: 10, y: 10, w: 50, h: 50 };
  assert.equal(code.validateOps(JSON.stringify({ ops: [op] }), box).ops.length, 1);
  assert.equal(code.validateOps([op], box).ops.length, 1);
  assert.match(code.validateOps('{bad', box).errors[0], /JSON/);
});

test('validateOps rejects unknown ops, bad colors, and missing text', () => {
  const { ops, errors } = code.validateOps([{ op: 'star' }, { op: 'rect', fill: 'blue' }, { op: 'text' }], box);
  assert.equal(ops.length, 0);
  assert.equal(errors.length, 3);
});

test('validateOps rejects shapes outside the section', () => {
  const { errors } = code.validateOps([{ op: 'rect', x: 700, y: 10, w: 200, h: 50 }], box);
  assert.match(errors[0], /นอก section/);
});

test('validateOps stacks ops without y below each other', () => {
  const { ops } = code.validateOps([{ op: 'rect', h: 100 }, { op: 'rect', h: 100 }], box);
  assert.equal(ops[0].y, 24);
  assert.equal(ops[1].y, 24 + 100 + 24);
});

test('validateOps starts unplaced ops at startY and rejects overflow past the section', () => {
  const r = code.validateOps([{ op: 'rect', h: 100 }, { op: 'rect', h: 50 }], { ...box, startY: 300 });
  assert.equal(r.ops[0].y, 300);
  assert.equal(r.ops[1].y, 300 + 100 + 24);
  const over = code.validateOps([{ op: 'rect', y: 500, h: 200 }], box);
  assert.match(over.errors[0], /นอก section/);
});

test('validateOps requires parent to be an earlier frame', () => {
  const r = code.validateOps(
    [
      { op: 'text', text: 'early', parent: 'card' },
      { op: 'frame', id: 'card', x: 0, y: 0, w: 300, h: 200 },
      { op: 'text', text: 'inside', parent: 'card' },
      { op: 'rect', id: 'r', x: 0, y: 300, w: 10, h: 10 },
      { op: 'text', text: 'bad', parent: 'r' },
    ],
    box,
  );
  assert.deepEqual([...r.ops.map((o) => o.op)], ['frame', 'text', 'rect']);
  assert.equal(r.errors.length, 2);
});

test('describeOp and outline produce readable lines', () => {
  assert.equal(code.describeOp({ op: 'text', text: 'Hi', x: 1, y: 2 }), 'text "Hi" @1,2');
  const md = code.outline({ type: 'SECTION', name: 'S', children: [{ type: 'TEXT', name: 't', text: 'x', x: 0, y: 0, width: 5, height: 5 }] });
  assert.equal(md, '- [SECTION] S\n  - [TEXT] t @0,0 5×5: "x"\n');
});

test('parseNotionId and firstCodeBlock', () => {
  assert.equal(ui.parseNotionId('https://www.notion.so/My-page-c97044952249457ebae48a28d23fd259?pvs=4'), 'c97044952249457ebae48a28d23fd259');
  const blocks = [{ type: 'paragraph' }, { type: 'code', code: { rich_text: [{ plain_text: '{"ops":' }, { plain_text: '[]}' }] } }];
  assert.equal(ui.firstCodeBlock(blocks), '{"ops":[]}');
  assert.equal(ui.firstCodeBlock([]), null);
});
