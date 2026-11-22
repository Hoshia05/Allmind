// Test module: uses every part of ctx once.
export function register(ctx) {
  const seen = [];
  ctx.events.on('live-chat', (list) => seen.push(...list));
  ctx.route('GET', '/api/v1/m/hello/ping', () => ({ pong: true, greeting: ctx.config.greeting || 'hi', seen: seen.length }));
  ctx.route('POST', '/api/hello/echo', (body) => ({ echo: body }), { pinFree: true });
  ctx.sse('/api/hello/events', (req, res) => { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write('event: hello\ndata: {}\n\n'); });
  ctx.snapshot('hello', () => ({ seen: seen.length }));
  ctx.log('registered');
}
