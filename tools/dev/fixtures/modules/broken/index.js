export function register(ctx) {
  ctx.route('GET', '/api/broken/half', () => ({})); // must be rolled back when register fails
  throw new Error('boom');
}
