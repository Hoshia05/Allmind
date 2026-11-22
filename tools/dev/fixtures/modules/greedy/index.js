// Tries to take a platform command path: must be refused, the whole module skipped.
export function register(ctx) {
  ctx.route('POST', '/api/v1/scene', () => ({}));
}
