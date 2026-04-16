/**
 * responses-shim.js
 * Translates OpenAI Responses API (/v1/responses) to Chat Completions API (/v1/chat/completions)
 * and passes all other requests through to copilot-api.
 * Listens on :4142, upstream is copilot-api:4141.
 * Zero npm dependencies — pure Node.js built-ins only.
 */

'use strict';

const http = require('http');

const UPSTREAM_HOST = process.env.UPSTREAM_HOST || 'copilot-api';
const UPSTREAM_PORT = parseInt(process.env.UPSTREAM_PORT || '4141', 10);
const LISTEN_PORT = parseInt(process.env.LISTEN_PORT || '4142', 10);

// ── helpers ──────────────────────────────────────────────────────────────────

function forwardRaw(method, path, headers, body, callback) {
  const opts = {
    hostname: UPSTREAM_HOST,
    port: UPSTREAM_PORT,
    method,
    path,
    headers: Object.assign({}, headers, { host: `${UPSTREAM_HOST}:${UPSTREAM_PORT}` }),
  };
  const req = http.request(opts, (res) => {
    const chunks = [];
    res.on('data', c => chunks.push(c));
    res.on('end', () => callback(null, res.statusCode, res.headers, Buffer.concat(chunks)));
  });
  req.on('error', callback);
  if (body && body.length) req.write(body);
  req.end();
}

// Flatten content — handles string, array of {type,text} objects, etc.
function flattenContent(content) {
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map(c => (typeof c === 'string' ? c : (c.text || c.content || '')))
      .join('');
  }
  return String(content);
}

// ── /v1/responses handler ─────────────────────────────────────────────────────

function handleResponsesRequest(reqBody, authHeader, callback) {
  let parsed;
  try { parsed = JSON.parse(reqBody); }
  catch (e) {
    console.error('[shim] JSON parse error. Raw body (hex):', Buffer.from(reqBody).toString('hex').slice(0, 80));
    return callback({ status: 400, message: 'Invalid JSON in request body' });
  }
  console.log('[shim] Request model:', parsed.model, '| stream:', parsed.stream,
    '| input type:', typeof parsed.input,
    '| input preview:', JSON.stringify(parsed.input).slice(0, 120));

  const wantsStream = !!parsed.stream;

  // Build messages array
  const messages = [];

  if (parsed.instructions) {
    messages.push({ role: 'system', content: parsed.instructions });
  }

  // `input` can be a string, an array of message objects, or an array of content parts
  if (typeof parsed.input === 'string') {
    messages.push({ role: 'user', content: parsed.input });
  } else if (Array.isArray(parsed.input)) {
    for (const item of parsed.input) {
      if (!item) continue;
      // Responses API message object: { type:'message', role, content }
      if (item.type === 'message' || item.role) {
        messages.push({ role: item.role || 'user', content: flattenContent(item.content) });
      }
    }
  }

  const chatBody = {
    model: parsed.model,
    messages,
    stream: false,
  };
  if (parsed.max_output_tokens != null) chatBody.max_tokens = parsed.max_output_tokens;
  if (parsed.temperature != null) chatBody.temperature = parsed.temperature;
  if (parsed.top_p != null) chatBody.top_p = parsed.top_p;

  const bodyBuf = Buffer.from(JSON.stringify(chatBody));
  const headers = {
    'content-type': 'application/json',
    'content-length': bodyBuf.length,
    'authorization': authHeader || 'Bearer dummy',
  };

  forwardRaw('POST', '/v1/chat/completions', headers, bodyBuf, (err, status, _rh, respBuf) => {
    if (err) return callback({ status: 502, message: err.message });

    let data;
    try { data = JSON.parse(respBuf.toString()); }
    catch (e) { return callback({ status: 502, message: 'Upstream returned non-JSON: ' + respBuf.toString().slice(0, 200) }); }

    if (status !== 200) {
      return callback({ status, message: data.error?.message || respBuf.toString() });
    }

    const choice = (data.choices || [])[0] || {};
    const content = choice.message?.content || '';

    const response = {
      id: data.id || ('resp_' + Date.now()),
      object: 'response',
      created_at: data.created || Math.floor(Date.now() / 1000),
      model: data.model || parsed.model,
      status: 'completed',
      error: null,
      output: [
        {
          type: 'message',
          id: 'msg_' + Date.now(),
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: content }],
        },
      ],
      usage: data.usage || {},
    };

    callback(null, response, wantsStream);
    console.log('[shim] Response sent:', JSON.stringify(response).slice(0, 300));
  });
}

// ── HTTP server ───────────────────────────────────────────────────────────────

function sendStreamingResponse(res, data) {
  // Emit the OpenAI Responses API SSE event sequence n8n expects.
  const respId = data.id;
  const model = data.model;
  const text = ((data.output[0] || {}).content || [{}])[0].text || '';
  const now = data.created_at || Math.floor(Date.now() / 1000);

  const send = (evt, obj) => res.write(`event: ${evt}\ndata: ${JSON.stringify(obj)}\n\n`);

  // 1 – response.created
  send('response.created', {
    type: 'response.created',
    response: { id: respId, object: 'response', created_at: now, model, status: 'in_progress', output: [], usage: null },
  });

  // 2 – response.in_progress
  send('response.in_progress', {
    type: 'response.in_progress',
    response: { id: respId, object: 'response', created_at: now, model, status: 'in_progress', output: [], usage: null },
  });

  // 3 – output item added
  send('response.output_item.added', {
    type: 'response.output_item.added',
    output_index: 0,
    item: { type: 'message', id: data.output[0].id, role: 'assistant', status: 'in_progress', content: [] },
  });

  // 4 – content part added
  send('response.content_part.added', {
    type: 'response.content_part.added',
    item_id: data.output[0].id,
    output_index: 0,
    content_index: 0,
    part: { type: 'output_text', text: '' },
  });

  // 5 – stream the text as delta chunks (split into ~20-char pieces so n8n sees deltas)
  const chunkSize = 20;
  for (let i = 0; i < text.length; i += chunkSize) {
    send('response.output_text.delta', {
      type: 'response.output_text.delta',
      item_id: data.output[0].id,
      output_index: 0,
      content_index: 0,
      delta: text.slice(i, i + chunkSize),
    });
  }

  // 6 – done
  send('response.output_text.done', {
    type: 'response.output_text.done',
    item_id: data.output[0].id,
    output_index: 0,
    content_index: 0,
    text,
  });

  // 7 – content part done
  send('response.content_part.done', {
    type: 'response.content_part.done',
    item_id: data.output[0].id,
    output_index: 0,
    content_index: 0,
    part: { type: 'output_text', text },
  });

  // 8 – output item done
  send('response.output_item.done', {
    type: 'response.output_item.done',
    output_index: 0,
    item: { type: 'message', id: data.output[0].id, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text }] },
  });

  // 9 – completed
  send('response.completed', {
    type: 'response.completed',
    response: {
      id: respId, object: 'response', created_at: now, model,
      status: 'completed', output: data.output, usage: data.usage,
    },
  });

  res.end();
}

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);

    if (req.method === 'POST' && req.url === '/v1/responses') {
      handleResponsesRequest(body.toString(), req.headers['authorization'], (err, data, wantsStream) => {
        if (err) {
          res.writeHead(err.status || 500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: err.message, type: 'shim_error' } }));
          console.error(`[shim] /v1/responses error: ${err.message}`);
          return;
        }
        if (wantsStream) {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
          });
          sendStreamingResponse(res, data);
          console.log(`[shim] /v1/responses → /v1/chat/completions OK streaming (model: ${data.model})`);
        } else {
          const out = Buffer.from(JSON.stringify(data));
          res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': out.length });
          res.end(out);
          console.log(`[shim] /v1/responses → /v1/chat/completions OK (model: ${data.model})`);
        }
      });
    } else {
      // Pass-through for /v1/models, /v1/chat/completions, /v1/embeddings, etc.
      const fwdHeaders = Object.assign({}, req.headers, {
        host: `${UPSTREAM_HOST}:${UPSTREAM_PORT}`,
        'content-length': body.length,
      });
      forwardRaw(req.method, req.url, fwdHeaders, body, (err, status, respHeaders, respBuf) => {
        if (err) {
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
          return;
        }
        res.writeHead(status, respHeaders);
        res.end(respBuf);
      });
    }
  });
});

server.listen(LISTEN_PORT, () => {
  console.log(`[shim] Responses API shim listening on :${LISTEN_PORT}`);
  console.log(`[shim] Upstream copilot-api at ${UPSTREAM_HOST}:${UPSTREAM_PORT}`);
});
