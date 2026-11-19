/**
 * Fallback static files for a deploy that cannot attach a Workers assets
 * binding. The checked-in module is empty; a direct upload replaces it at
 * build time with the files from public/. Wrangler deploys keep using ASSETS.
 */
export const EMBEDDED_ASSETS = {
  async fetch(): Promise<Response> {
    return new Response('Not found', { status: 404 });
  },
} as unknown as Fetcher;
