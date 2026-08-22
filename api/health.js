/**
 * Vercel Serverless Health Check Endpoint
 * Route: GET /api/health
 * 
 * Provides an instantaneous, zero-dependency health check for platform uptime
 * monitoring and CI/CD verification without relying on LibreOffice or local disk.
 */

module.exports = (req, res) => {
  // Set CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  try {
    return res.status(200).json({
      status: 'ok',
      ok: true,
      service: 'smartboard-remote',
      runtime: 'vercel-serverless',
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    return res.status(500).json({
      status: 'error',
      ok: false,
      error: 'Health check failed'
    });
  }
};
