/**
 * responses-shim.js
 * Translates OpenAI Responses API (/v1/responses) to Chat Completions API (/v1/chat/completions)
 * and passes all other requests through to copilot-api.
 * Handles tool calls (function calling) in both directions.
 * Listens on :4142, upstream is copilot-api:4141.
 * Zero npm dependencies — pure Node.js built-ins only.
 */

'use strict';

const http = require('http');
const zlib = require('zlib');

const UPSTREAM_HOST = process.env.UPSTREAM_HOST || 'copilot-api';
const UPSTREAM_PORT = parseInt(process.env.UPSTREAM_PORT || '4141', 10);
const LISTEN_PORT = parseInt(process.env.LISTEN_PORT || '4142', 10);
const LOGIN_REDIRECT_LOCATION = process.env.LOGIN_REDIRECT_LOCATION || '/';

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

// Convert Responses API tools → Chat Completions tools format
// Responses: { type:'function', name, description, parameters }
// Chat:      { type:'function', function: { name, description, parameters } }
function convertToolsToChat(tools) {
  if (!tools || !Array.isArray(tools)) return undefined;
  return tools.map(t => {
    if (t.type === 'function') {
      return {
        type: 'function',
        function: {
          name: t.name,
          description: t.description || '',
          parameters: t.parameters || t.input_schema || { type: 'object', properties: {} },
        },
      };
    }
    return t;
  });
}

// Convert Responses API tool_choice → Chat Completions tool_choice
function convertToolChoice(tc) {
  if (!tc || typeof tc === 'string') return tc;
  // { type:'function', name:'foo' } → { type:'function', function:{ name:'foo' } }
  if (tc.type === 'function' && tc.name) {
    return { type: 'function', function: { name: tc.name } };
  }
  return tc;
}

// Build Chat Completions messages array from Responses API input
function buildMessages(parsed) {
  const messages = [];

  if (parsed.instructions) {
    messages.push({ role: 'system', content: parsed.instructions });
  }

  if (typeof parsed.input === 'string') {
    messages.push({ role: 'user', content: parsed.input });
    return messages;
  }

  if (!Array.isArray(parsed.input)) return messages;

  // Track consecutive function_call items to group as one assistant message
  let pendingToolCalls = null;

  const flushToolCalls = () => {
    if (pendingToolCalls) {
      messages.push({ role: 'assistant', content: null, tool_calls: pendingToolCalls });
      pendingToolCalls = null;
    }
  };

  for (const item of parsed.input) {
    if (!item) continue;

    if (item.type === 'function_call') {
      // AI's tool call — accumulate until flushed
      if (!pendingToolCalls) pendingToolCalls = [];
      pendingToolCalls.push({
        id: item.call_id || item.id || ('call_' + Date.now()),
        type: 'function',
        function: { name: item.name, arguments: item.arguments || '{}' },
      });

    } else if (item.type === 'function_call_output') {
      // Tool result — flush pending tool calls first, then add tool message
      flushToolCalls();
      messages.push({
        role: 'tool',
        tool_call_id: item.call_id || item.id,
        content: typeof item.output === 'string' ? item.output : JSON.stringify(item.output),
      });

    } else if (item.type === 'message' || item.role) {
      flushToolCalls();
      const role = item.role || 'user';
      if (Array.isArray(item.content)) {
        // Some n8n versions embed tool_result blocks inside a user message content array
        const toolResults = item.content.filter(c => c.type === 'tool_result');
        const textParts = item.content.filter(c => c.type !== 'tool_result');
        for (const tr of toolResults) {
          messages.push({ role: 'tool', tool_call_id: tr.tool_use_id, content: flattenContent(tr.content) });
        }
        if (textParts.length > 0) {
          messages.push({ role, content: flattenContent(textParts) });
        }
      } else {
        messages.push({ role, content: flattenContent(item.content) });
      }
    }
  }

  flushToolCalls();
  return messages;
}

// Translate Chat Completions response → Responses API response object
function buildResponseObject(data, parsedModel) {
  const choice = (data.choices || [])[0] || {};
  const message = choice.message || {};
  const output = [];
  const now = data.created || Math.floor(Date.now() / 1000);
  const id = data.id || ('resp_' + Date.now());

  if (message.tool_calls && message.tool_calls.length > 0) {
    for (const tc of message.tool_calls) {
      const callId = tc.id || ('call_' + Date.now());
      output.push({
        type: 'function_call',
        id: callId,
        call_id: callId,
        name: tc.function?.name || '',
        arguments: tc.function?.arguments || '{}',
        status: 'completed',
      });
    }
  } else {
    output.push({
      type: 'message',
      id: 'msg_' + Date.now(),
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: message.content || '' }],
    });
  }

  return { id, object: 'response', created_at: now, model: data.model || parsedModel, status: 'completed', error: null, output, usage: data.usage || {} };
}

// ── /v1/responses handler ─────────────────────────────────────────────────────

function handleResponsesRequest(reqBody, authHeader, callback) {
  let parsed;
  try { parsed = JSON.parse(reqBody); }
  catch (e) {
    const isBinary = reqBody.length > 0 && reqBody.charCodeAt(0) < 32;
    const preview = isBinary
      ? Buffer.from(reqBody, 'binary').slice(0, 80).toString('hex')
      : reqBody.slice(0, 300);
    console.error(`[shim] JSON parse fail: body-len=${reqBody.length} binary=${isBinary} preview=${preview}`);
    return callback({ status: 400, message: 'Invalid JSON in request body' });
  }

  const hasTools = parsed.tools && parsed.tools.length > 0;
  console.log(`[shim] Request model: ${parsed.model} | stream: ${parsed.stream} | tools: ${(parsed.tools || []).length} | input preview: ${JSON.stringify((parsed.input || [])[0]).slice(0, 120)}`);

  const wantsStream = !!parsed.stream;
  const messages = buildMessages(parsed);

  const chatBody = { model: parsed.model, messages, stream: false };
  if (parsed.max_output_tokens != null) chatBody.max_tokens = parsed.max_output_tokens;
  if (parsed.temperature != null) chatBody.temperature = parsed.temperature;
  if (parsed.top_p != null) chatBody.top_p = parsed.top_p;

  // Pass tools to upstream so model can return tool_calls
  if (hasTools) {
    chatBody.tools = convertToolsToChat(parsed.tools);
    if (parsed.tool_choice != null) chatBody.tool_choice = convertToolChoice(parsed.tool_choice);
  }

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

    const response = buildResponseObject(data, parsed.model);
    const hasToolCalls = response.output.some(o => o.type === 'function_call');
    console.log('[shim] Response:', hasToolCalls ? `tool_calls(${response.output.length})` : 'text',
      '| model:', response.model);
    callback(null, response, wantsStream);
  });
}

// ── SSE streaming response ─────────────────────────────────────────────────────

function sendStreamingResponse(res, data) {
  const respId = data.id;
  const model = data.model;
  const now = data.created_at || Math.floor(Date.now() / 1000);
  const send = (evt, obj) => res.write(`event: ${evt}\ndata: ${JSON.stringify(obj)}\n\n`);

  send('response.created', {
    type: 'response.created',
    response: { id: respId, object: 'response', created_at: now, model, status: 'in_progress', output: [], usage: null },
  });
  send('response.in_progress', {
    type: 'response.in_progress',
    response: { id: respId, object: 'response', created_at: now, model, status: 'in_progress', output: [], usage: null },
  });

  for (let i = 0; i < data.output.length; i++) {
    const item = data.output[i];

    if (item.type === 'function_call') {
      // ── tool call streaming ──
      send('response.output_item.added', {
        type: 'response.output_item.added',
        output_index: i,
        item: { type: 'function_call', id: item.id, call_id: item.call_id, name: item.name, arguments: '', status: 'in_progress' },
      });

      const args = item.arguments || '{}';
      const chunkSize = 20;
      for (let j = 0; j < args.length; j += chunkSize) {
        send('response.function_call_arguments.delta', {
          type: 'response.function_call_arguments.delta',
          item_id: item.id, output_index: i,
          delta: args.slice(j, j + chunkSize),
        });
      }
      send('response.function_call_arguments.done', {
        type: 'response.function_call_arguments.done',
        item_id: item.id, output_index: i, arguments: args,
      });
      send('response.output_item.done', {
        type: 'response.output_item.done',
        output_index: i,
        item: { type: 'function_call', id: item.id, call_id: item.call_id, name: item.name, arguments: args, status: 'completed' },
      });

    } else if (item.type === 'message') {
      // ── text message streaming ──
      const text = ((item.content || [{}])[0] || {}).text || '';
      const msgId = item.id;

      send('response.output_item.added', {
        type: 'response.output_item.added', output_index: i,
        item: { type: 'message', id: msgId, role: 'assistant', status: 'in_progress', content: [] },
      });
      send('response.content_part.added', {
        type: 'response.content_part.added',
        item_id: msgId, output_index: i, content_index: 0,
        part: { type: 'output_text', text: '' },
      });

      const chunkSize = 20;
      for (let j = 0; j < text.length; j += chunkSize) {
        send('response.output_text.delta', {
          type: 'response.output_text.delta',
          item_id: msgId, output_index: i, content_index: 0,
          delta: text.slice(j, j + chunkSize),
        });
      }
      send('response.output_text.done', {
        type: 'response.output_text.done',
        item_id: msgId, output_index: i, content_index: 0, text,
      });
      send('response.content_part.done', {
        type: 'response.content_part.done',
        item_id: msgId, output_index: i, content_index: 0,
        part: { type: 'output_text', text },
      });
      send('response.output_item.done', {
        type: 'response.output_item.done', output_index: i,
        item: { type: 'message', id: msgId, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text }] },
      });
    }
  }

  send('response.completed', {
    type: 'response.completed',
    response: { id: respId, object: 'response', created_at: now, model, status: 'completed', output: data.output, usage: data.usage },
  });

  res.end();
}

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    if (req.method === 'GET' && req.url === '/login') {
      res.writeHead(302, { Location: LOGIN_REDIRECT_LOCATION });
      res.end();
      return;
    }

    const rawBody = Buffer.concat(chunks);
    const encoding = (req.headers['content-encoding'] || '').toLowerCase().trim();

    const dispatch = (body) => {
      if (req.method === 'POST' && req.url === '/v1/responses') {
        handleResponsesRequest(body.toString('utf8'), req.headers['authorization'], (err, data, wantsStream) => {
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
            try {
              sendStreamingResponse(res, data);
            } catch (streamErr) {
              console.error('[shim] sendStreamingResponse threw:', streamErr.message, streamErr.stack);
              // Connection may already be partially written; try to close cleanly
              try { res.end(); } catch (_) { }
            }
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
    }; // end dispatch

    if (encoding === 'gzip') {
      zlib.gunzip(rawBody, (err, buf) => {
        if (err) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'gzip decompress failed' })); return; }
        dispatch(buf);
      });
    } else if (encoding === 'deflate') {
      zlib.inflate(rawBody, (err, buf) => {
        if (err) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'deflate decompress failed' })); return; }
        dispatch(buf);
      });
    } else if (encoding === 'br') {
      zlib.brotliDecompress(rawBody, (err, buf) => {
        if (err) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'brotli decompress failed' })); return; }
        dispatch(buf);
      });
    } else {
      dispatch(rawBody);
    }
  });
});

if (require.main === module) {
  server.listen(LISTEN_PORT, () => {
    console.log(`[shim] Responses API shim listening on :${LISTEN_PORT}`);
    console.log(`[shim] Upstream copilot-api at ${UPSTREAM_HOST}:${UPSTREAM_PORT}`);
  });
}

module.exports = { server };
