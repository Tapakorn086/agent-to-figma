// Local bridge between Claude (curl) and the Agent to Figma plugin.
// Run: node bridge.js   (listens on http://localhost:4848)
//
// Plugin side (polls every ~1.5 s):
//   POST /plugin/poll    { selection }            -> { ops?, wantRead? }
//   POST /plugin/context { tree, markdown, png? }  stores what the plugin read
//   POST /plugin/result  { ok, text }              result of Preview/Sync
// Claude side:
//   GET  /status          online?, selection, last result
//   POST /read            ask the plugin to read the selected section
//   GET  /context         last context the plugin sent (markdown + tree)
//   GET  /context.png     last section image
//   POST /ops             { ops: [...], note?, replace? } send ops; the user still presses Sync
//                         replace: true removes the agent's previous output on Sync

const http = require('node:http');

const PORT = Number(process.env.PORT) || 4848;
const ONLINE_MS = 5000;

const state = {
  lastPoll: 0,
  selection: null,
  pendingOps: null, // { id, ops }
  wantRead: false,
  context: null,
  png: null,
  results: [],
};

function send(res, code, body, type = 'application/json') {
  res.writeHead(code, {
    'Content-Type': type,
    // The plugin iframe has a null origin
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(type === 'application/json' ? JSON.stringify(body, null, 2) : body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(new Error('invalid JSON: ' + e.message));
      }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return send(res, 204, '', 'text/plain');
  const route = `${req.method} ${req.url.split('?')[0]}`;
  try {
    const body = req.method === 'POST' ? await readBody(req) : {};
    switch (route) {
      case 'POST /plugin/poll': {
        state.lastPoll = Date.now();
        state.selection = body.selection || null;
        const reply = {};
        if (state.pendingOps) {
          reply.ops = state.pendingOps;
          state.pendingOps = null;
        }
        if (state.wantRead) {
          reply.wantRead = true;
          state.wantRead = false;
        }
        return send(res, 200, reply);
      }
      case 'POST /plugin/context':
        state.context = { at: new Date().toISOString(), tree: body.tree, markdown: body.markdown };
        state.png = body.png ? Buffer.from(body.png, 'base64') : null;
        return send(res, 200, { ok: true });
      case 'POST /plugin/result':
        state.results.unshift({ at: new Date().toISOString(), ...body });
        state.results.length = Math.min(state.results.length, 20);
        return send(res, 200, { ok: true });

      case 'GET /status':
        return send(res, 200, {
          online: Date.now() - state.lastPoll < ONLINE_MS,
          lastSeenMsAgo: state.lastPoll ? Date.now() - state.lastPoll : null,
          selection: state.selection,
          opsWaiting: !!state.pendingOps,
          contextAt: state.context && state.context.at,
          results: state.results.slice(0, 5),
        });
      case 'POST /read':
        state.context = null;
        state.wantRead = true;
        return send(res, 200, { ok: true, note: 'plugin will read on its next poll; then GET /context' });
      case 'GET /context':
        if (!state.context) return send(res, 404, { error: 'no context yet' });
        return send(res, 200, state.context);
      case 'GET /context.png':
        if (!state.png) return send(res, 404, { error: 'no image' });
        return send(res, 200, state.png, 'image/png');
      case 'POST /ops': {
        const ops = Array.isArray(body) ? body : body.ops;
        if (!Array.isArray(ops)) return send(res, 400, { error: 'body must be { ops: [...] }' });
        // replace: true clears the agent's previous output on Sync; default appends below existing content
        state.pendingOps = { id: String(Date.now()), ops, note: body.note || '', replace: !!body.replace };
        return send(res, 200, { ok: true, id: state.pendingOps.id, count: ops.length });
      }
      default:
        return send(res, 404, { error: 'unknown route ' + route });
    }
  } catch (e) {
    return send(res, 400, { error: e.message });
  }
});

server.listen(PORT, '127.0.0.1', () => console.log(`agent-to-figma bridge on http://localhost:${PORT}`));
