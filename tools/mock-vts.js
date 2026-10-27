// Fake VTube Studio public API for development (docs/plans/vts.md): ws://127.0.0.1:8001.
// Approves the plugin and the custom-image permission by itself, keeps a model + items, answers the
// requests Allmind uses and logs them. Not real VTS: no rendering, coordinates are taken as given.
//   GET  http://127.0.0.1:8002/stats         request counts, items in scene, last moves/injections
//   POST http://127.0.0.1:8002/drop {x,y}    pretend the owner dropped the (aim) item there
//   env MOCK_VTS_DENY=1  the owner presses "deny" on the plugin popup
import http from 'node:http';
import crypto from 'node:crypto';
import { WebSocketServer } from 'ws';

const PORT = Number(process.env.MOCK_VTS_PORT) || 8001;
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const tokens = new Set();
const stats = { counts: {}, items: new Map(), moves: [], injections: 0, lastInject: null, tints: [], modelMoves: [], expressions: {}, hotkeys: 0, approvedImages: new Set() };
const model = { modelLoaded: true, modelName: '호시아', modelID: 'mock-model', modelPosition: { positionX: 0.05, positionY: -0.35, rotation: 0, size: -40 } };
const EXPRESSIONS = [
  { name: '머리 단발', file: 'hair_short.exp3.json' }, { name: '머리 포니테일', file: 'hair_pony.exp3.json' },
  { name: '옷 교복', file: 'outfit_school.exp3.json' }, { name: '고양이 귀', file: 'cat_ears.exp3.json' },
];
const HOTKEYS = [{ hotkeyID: 'hk-ouch', name: '아야 (애니메이션)', type: 'TriggerAnimation', file: 'ouch.motion3.json' }, { hotkeyID: 'hk-cat', name: '고양이 귀', type: 'ToggleExpression', file: 'cat_ears.exp3.json' }];
const subs = new Map(); // ws → item instance ids subscribed

const wss = new WebSocketServer({ port: PORT });
wss.on('connection', (ws) => {
  let authed = false;
  let custom = false;
  log('plugin connected');
  const reply = (m, type, data) => ws.send(JSON.stringify({ apiName: 'VTubeStudioPublicAPI', apiVersion: '1.0', timestamp: Date.now(), requestID: m.requestID, messageType: type, data }));
  const err = (m, id, message) => reply(m, 'APIError', { errorID: id, message });
  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    const t = (m.messageType || '').replace(/Request$/, '');
    const d = m.data || {};
    stats.counts[t] = (stats.counts[t] || 0) + 1;
    if (t !== 'InjectParameterData' && t !== 'ItemMove') log(t, JSON.stringify(d).slice(0, 140));
    if (t === 'APIState') return reply(m, 'APIStateResponse', { active: true, vTubeStudioVersion: '1.28.15-mock', currentSessionAuthenticated: authed });
    if (t === 'AuthenticationToken') {
      log('  popup: allow "Allmind"?', d.pluginIcon ? `(icon ${Buffer.from(d.pluginIcon, 'base64').length} bytes)` : '(no icon)');
      return setTimeout(() => {
        if (process.env.MOCK_VTS_DENY) return err(m, 50, 'User has denied API access for your plugin.');
        const tok = crypto.randomBytes(16).toString('hex'); tokens.add(tok);
        reply(m, 'AuthenticationTokenResponse', { authenticationToken: tok });
      }, 400);
    }
    if (t === 'Authentication') { authed = tokens.has(d.authenticationToken) || process.env.MOCK_VTS_ANYTOKEN === '1'; return reply(m, 'AuthenticationResponse', { authenticated: authed, reason: authed ? 'ok' : 'Token invalid' }); }
    if (!authed) return err(m, 8, 'Request requires authentication');
    if (t === 'Permission') {
      if (d.requestedPermission === 'LoadCustomImagesAsItems') { custom = true; log('  popup: allow custom images? → yes'); return setTimeout(() => reply(m, 'PermissionResponse', { grantSuccess: true, requestedPermission: d.requestedPermission, permissions: [{ name: 'LoadCustomImagesAsItems', granted: true }] }), 300); }
      return reply(m, 'PermissionResponse', { grantSuccess: false, requestedPermission: null, permissions: [{ name: 'LoadCustomImagesAsItems', granted: custom }] });
    }
    if (t === 'CurrentModel') return reply(m, 'CurrentModelResponse', model);
    if (t === 'ItemList') {
      const used = new Set([...stats.items.values()].map((i) => i.order));
      const spots = []; for (let o = -30; o <= 30; o++) if (o !== 0 && !used.has(o)) spots.push(o);
      return reply(m, 'ItemListResponse', { itemsInSceneCount: stats.items.size, totalItemsAllowedCount: 60, canLoadItemsRightNow: true, availableSpots: d.includeAvailableSpots ? spots : [], itemInstancesInScene: [], availableItemFiles: [] });
    }
    if (t === 'ItemLoad') {
      if (d.customDataBase64 && !custom) return err(m, 758, 'Plugin does not have the LoadCustomImagesAsItems permission');
      const hash = d.customDataBase64 ? crypto.createHash('sha256').update(d.customDataBase64).digest('hex') : null;
      if (hash && !stats.approvedImages.has(hash)) { stats.approvedImages.add(hash); log('  popup: load this image? → yes'); }
      if (stats.items.size >= 60) return err(m, 754, 'scene full');
      const id = crypto.randomBytes(8).toString('hex');
      stats.items.set(id, { file: d.fileName, x: d.positionX, y: d.positionY, size: d.size, order: d.order ?? 1, rotation: d.rotation });
      return reply(m, 'ItemLoadResponse', { instanceID: id, fileName: d.fileName });
    }
    if (t === 'ItemMove') {
      const moved = (d.itemsToMove || []).map((x) => {
        const it = stats.items.get(x.itemInstanceID);
        if (!it) return { itemInstanceID: x.itemInstanceID, success: false, errorID: 900 };
        if (!['linear', 'easeIn', 'easeOut', 'easeBoth', 'overshoot', 'zip', undefined].includes(x.fadeMode)) return { itemInstanceID: x.itemInstanceID, success: false, errorID: 901 };
        if (x.rotation !== undefined && (x.rotation < -360 || x.rotation > 360)) return { itemInstanceID: x.itemInstanceID, success: false, errorID: 757 };
        Object.assign(it, { x: x.positionX ?? it.x, y: x.positionY ?? it.y, rotation: x.rotation ?? it.rotation });
        stats.moves.push({ id: x.itemInstanceID, x: x.positionX, y: x.positionY, t: x.timeInSeconds, fade: x.fadeMode }); if (stats.moves.length > 40) stats.moves.shift();
        return { itemInstanceID: x.itemInstanceID, success: true, errorID: -1 };
      });
      return reply(m, 'ItemMoveResponse', { movedItems: moved });
    }
    if (t === 'ItemUnload') {
      const out = [];
      for (const id of d.instanceIDs || []) if (stats.items.delete(id)) out.push({ instanceID: id, fileName: '' });
      return reply(m, 'ItemUnloadResponse', { unloadedItems: out });
    }
    if (t === 'InjectParameterData') {
      stats.injections++; stats.lastInject = d;
      for (const p of d.parameterValues || []) if (!Number.isFinite(p.value) || Math.abs(p.value) > 1e6) return err(m, 453, 'value out of range');
      return reply(m, 'InjectParameterDataResponse', {});
    }
    if (t === 'ColorTint') { stats.tints.push(d.colorTint); if (stats.tints.length > 20) stats.tints.shift(); return reply(m, 'ColorTintResponse', { matchedArtMeshes: 120 }); }
    if (t === 'MoveModel') { stats.modelMoves.push(d); if (stats.modelMoves.length > 20) stats.modelMoves.shift(); if (!d.valuesAreRelativeToModel) { if (d.positionX !== undefined) model.modelPosition.positionX = d.positionX; if (d.positionY !== undefined) model.modelPosition.positionY = d.positionY; } return reply(m, 'MoveModelResponse', {}); }
    if (t === 'ExpressionState') return reply(m, 'ExpressionStateResponse', { modelLoaded: true, modelName: model.modelName, modelID: model.modelID, expressions: EXPRESSIONS.map((e) => ({ ...e, active: !!stats.expressions[e.file], deactivateWhenKeyIsLetGo: false, autoDeactivateAfterSeconds: false, secondsRemaining: 0, usedInHotkeys: [], parameters: [] })) });
    if (t === 'ExpressionActivation') {
      if (!EXPRESSIONS.some((e) => e.file === d.expressionFile)) return err(m, 451, 'expression not found');
      stats.expressions[d.expressionFile] = !!d.active; return reply(m, 'ExpressionActivationResponse', {});
    }
    if (t === 'HotkeysInCurrentModel') return reply(m, 'HotkeysInCurrentModelResponse', { modelLoaded: true, modelName: model.modelName, modelID: model.modelID, availableHotkeys: HOTKEYS.map((h) => ({ ...h, description: '', keyCombination: [], onScreenButtonID: -1 })) });
    if (t === 'HotkeyTrigger') { stats.hotkeys++; return reply(m, 'HotkeyTriggerResponse', { hotkeyID: d.hotkeyID }); }
    if (t === 'EventSubscription') { if (d.eventName === 'ItemEvent') subs.set(ws, d.subscribe ? d.config?.itemInstanceIDs || [] : []); return reply(m, 'EventSubscriptionResponse', { subscribedEventCount: d.subscribe ? 1 : 0, subscribedEvents: d.subscribe ? [d.eventName] : [] }); }
    return err(m, 2, `mock: ${t} not implemented`);
  });
  ws.on('close', () => { log('plugin disconnected — unloading its items'); stats.items.clear(); subs.delete(ws); });
});

http.createServer((req, res) => {
  const send = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
  if (req.url === '/stats') return send({ ...stats, items: [...stats.items.entries()].map(([id, v]) => ({ id, ...v })), approvedImages: stats.approvedImages.size, model });
  if (req.url === '/drop' && req.method === 'POST') {
    let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => {
      const { x, y } = JSON.parse(b || '{}');
      let n = 0;
      for (const [ws, ids] of subs) for (const id of ids) if (stats.items.has(id)) {
        ws.send(JSON.stringify({ apiName: 'VTubeStudioPublicAPI', apiVersion: '1.0', timestamp: Date.now(), requestID: 'event', messageType: 'ItemEvent', data: { itemEventType: 'DroppedUnpinned', itemInstanceID: id, itemFileName: stats.items.get(id).file, itemPosition: { x, y } } })); n++;
      }
      send({ sent: n });
    });
    return;
  }
  res.writeHead(404).end();
}).listen(PORT + 1);
log(`mock VTS on ws://127.0.0.1:${PORT} (stats on :${PORT + 1})`);
