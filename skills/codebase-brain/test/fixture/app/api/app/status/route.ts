// "app" inside the URL: the routing root is the first app/, so this is /api/app/status
export function GET() {
  return new Response('ok');
}
