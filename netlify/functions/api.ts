import serverless from "serverless-http";
import app from "../../src/app";

const FUNCTION_PREFIX = "/.netlify/functions/api";
const expressHandler = serverless(app);

/**
 * Netlify Function entry point: every request is rewritten to this function
 * (see netlify.toml) and handed to the same Express app used locally.
 */
export const handler = async (event: { path?: string; rawUrl?: string }, context: object) => {
  // Direct calls arrive as /.netlify/functions/api/...; strip the prefix so Express routes match.
  if (event.path?.startsWith(FUNCTION_PREFIX)) {
    event.path = event.path.slice(FUNCTION_PREFIX.length) || "/";
  }
  return expressHandler(event, context);
};
