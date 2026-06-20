/**
 * Single source of truth for the server version.
 *
 * Imported by the MCP server (src/mcp.ts) and the HTTP /health endpoint
 * (src/http.ts) so both report the same version. Also mirrored in
 * package.json; tests/version.test.ts asserts the two stay in sync.
 */
export const VERSION = "0.1.0";
