import { NextRequest, NextResponse } from 'next/server';
import { requireInternalNetworkAccess } from '@/lib/internal-network';

export async function GET(request: NextRequest) {
  const accessError = requireInternalNetworkAccess(request);
  if (accessError) {
    return accessError;
  }

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Agent Studio API — API Docs</title>
  <!-- TODO: Add integrity="sha384-..." crossorigin="anonymous" or self-host swagger-ui assets -->
  <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5.18.2/swagger-ui.css" />
  <style>
    body { margin: 0; padding: 0; }
    #swagger-ui .topbar { display: none; }
  </style>
</head>
<body>
  <div id="swagger-ui"></div>
  <!-- TODO: Add integrity="sha384-..." crossorigin="anonymous" or self-host swagger-ui assets -->
  <script src="https://unpkg.com/swagger-ui-dist@5.18.2/swagger-ui-bundle.js"></script>
  <script>
    SwaggerUIBundle({
      url: './openapi/spec.json',
      dom_id: '#swagger-ui',
      presets: [
        SwaggerUIBundle.presets.apis,
        SwaggerUIBundle.SwaggerUIStandalonePreset,
      ],
      layout: 'BaseLayout',
      deepLinking: true,
    });
  </script>
</body>
</html>`;

  return new NextResponse(html, {
    headers: { 'Content-Type': 'text/html' },
  });
}
