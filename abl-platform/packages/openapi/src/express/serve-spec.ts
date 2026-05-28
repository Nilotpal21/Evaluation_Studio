import { Router } from 'express';
import type { RouteRegistry } from '../registry.js';
import type { SpecOptions } from '../types.js';

/**
 * Returns an Express Router that serves:
 *   GET /          → Swagger UI (loaded from CDN)
 *   GET /spec.json → OpenAPI 3.0 JSON spec
 */
export function serveOpenAPIDocs(registry: RouteRegistry, options: SpecOptions): Router {
  const router = Router();
  let cachedSpec: Record<string, unknown> | null = null;

  router.get('/spec.json', (_req, res) => {
    if (!cachedSpec) {
      cachedSpec = registry.generateSpec(options);
    }
    res.json(cachedSpec);
  });

  router.get('/', (req, res) => {
    res.setHeader('Content-Type', 'text/html');
    // Use absolute path based on the mounted base path
    const basePath = req.baseUrl || '';
    const specUrl = `${basePath}/spec.json`;
    res.send(swaggerHtml(options.title, specUrl));
  });

  return router;
}

function swaggerHtml(title: string, specUrl: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${title} — API Docs</title>
  <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css" />
  <style>
    body { margin: 0; padding: 0; }
    #swagger-ui .topbar { display: none; }
  </style>
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
  <script>
    SwaggerUIBundle({
      url: '${specUrl}',
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
}
