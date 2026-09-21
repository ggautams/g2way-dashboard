import { proxyToGateway } from '@/lib/g2/proxy';

// The BFF proxy onto the gateway admin API: `/api/g2/<path>` → `<gateway>/g2/<path>`.
// Runs server-side only; the admin secret is attached here and never leaves the server.

type Context = RouteContext<'/api/g2/[...path]'>;

async function handle(request: Request, context: Context): Promise<Response> {
  const { path } = await context.params;
  return proxyToGateway(request, path);
}

export const GET = handle;
export const POST = handle;
export const PUT = handle;
export const DELETE = handle;
