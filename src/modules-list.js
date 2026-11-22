// The modules the exe bundles. From source this is null and src/server.js discovers modules/*/ at start;
// tools/build-exe.mjs replaces this file with a static list (import + module.json per module) so esbuild
// bundles them into the one exe (a SEA can't import files from disk). Keep it null here.
export default null;
