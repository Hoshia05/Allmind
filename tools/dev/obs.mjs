// Send one obs-websocket request to the mock OBS (as a second client), e.g.
//   node tools/dev/obs.mjs StartRecord
//   node tools/dev/obs.mjs SetCurrentProgramScene '{"sceneName":"BRB"}'
import crypto from 'node:crypto';
import WebSocket from 'ws';
const [type, data = '{}'] = process.argv.slice(2);
const pw = process.env.OBS_PASSWORD || 'hunter2';
const h = (x) => crypto.createHash('sha256').update(x).digest('base64');
const ws = new WebSocket('ws://127.0.0.1:4455');
ws.on('message', (raw) => {
  const { op, d } = JSON.parse(raw);
  if (op === 0) ws.send(JSON.stringify({ op: 1, d: { rpcVersion: 1, eventSubscriptions: 0, ...(d.authentication && { authentication: h(h(pw + d.authentication.salt) + d.authentication.challenge) }) } }));
  if (op === 2) ws.send(JSON.stringify({ op: 6, d: { requestType: type, requestId: '1', requestData: JSON.parse(data) } }));
  if (op === 7) { console.log(type, d.requestStatus.result ? 'ok' : `failed: ${d.requestStatus.comment}`, JSON.stringify(d.responseData || {})); ws.close(); }
});
