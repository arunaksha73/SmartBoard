/**
 * Vercel Serverless Config Endpoint
 * Route: GET /api/config
 * 
 * Provides client-safe runtime configuration (such as the persistent backend/Socket.IO URL)
 * dynamically configured via Vercel environment variables (BACKEND_URL or NEXT_PUBLIC_SOCKET_URL).
 */

module.exports = (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  try {
    const backendUrl = (
      process.env.BACKEND_URL ||
      process.env.NEXT_PUBLIC_SOCKET_URL ||
      process.env.SOCKET_URL ||
      ''
    ).trim();

    return res.status(200).json({
      ok: true,
      backendUrl: backendUrl,
      env: process.env.NODE_ENV || 'production'
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: 'Config resolution failed'
    });
  }
};
