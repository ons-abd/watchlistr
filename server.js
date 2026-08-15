import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

// Helper to load .env variables manually in Node
function loadEnv() {
  const envPath = path.resolve(process.cwd(), '.env');
  const env = {};
  if (fs.existsSync(envPath)) {
    const lines = fs.readFileSync(envPath, 'utf-8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const idx = trimmed.indexOf('=');
      if (idx > 0) {
        env[trimmed.substring(0, idx).trim()] = trimmed.substring(idx + 1).trim();
      }
    }
  }
  return env;
}

const env = loadEnv();
let currentToken = process.env.TTVDB_TOKEN || env.TTVDB_TOKEN || '';
const apiKey = process.env.TTVDB_API_KEY || env.TTVDB_API_KEY || '';
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';

let refreshPromise = null;

function updateEnvFile(key, value) {
  try {
    const envPath = path.resolve(process.cwd(), '.env');
    if (fs.existsSync(envPath)) {
      let content = fs.readFileSync(envPath, 'utf-8');
      const reg = new RegExp(`^${key}=.*$`, 'm');
      if (reg.test(content)) {
        content = content.replace(reg, `${key}=${value}`);
      } else {
        content += `\n${key}=${value}`;
      }
      fs.writeFileSync(envPath, content, 'utf-8');
      console.log(`[TVDB Backend] Updated ${key} in .env file.`);
    }
  } catch (err) {
    console.error('[TVDB Backend] Failed to update .env:', err);
  }
}

async function refreshToken() {
  if (refreshPromise) {
    console.log('[TVDB Backend] Token refresh already in progress. Waiting...');
    return refreshPromise;
  }

  console.log('[TVDB Backend] 🔄 Refreshing TVDB token...');
  refreshPromise = (async () => {
    try {
      const res = await fetch('https://api4.thetvdb.com/v4/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apikey: apiKey })
      });

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Login endpoint returned status ${res.status}: ${text}`);
      }

      const data = await res.json();
      if (!data?.data?.token) {
        throw new Error(`Invalid response payload from TVDB login endpoint: ${JSON.stringify(data)}`);
      }

      currentToken = data.data.token;
      console.log('[TVDB Backend] ✅ Token successfully refreshed!');
      updateEnvFile('TTVDB_TOKEN', currentToken);
      return currentToken;
    } catch (err) {
      console.error('[TVDB Backend] 💥 CRITICAL ERROR: Failed to refresh TVDB token:', err);
      throw err;
    } finally {
      refreshPromise = null;
    }
  })();

  return refreshPromise;
}

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'content-encoding',
  'content-length',
  'host',
  'server',
  'date'
]);

const server = http.createServer(async (req, res) => {
  // Enable CORS headers for local dev flexibility
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    return res.end();
  }

  if (!req.url.startsWith('/api/tvdb')) {
    res.statusCode = 404;
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ error: 'Endpoint not found' }));
  }

  const relativeUrl = req.url.replace(/^\/api\/tvdb/, '');
  const targetUrl = `https://api4.thetvdb.com/v4${relativeUrl}`;

  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  const reqBody = Buffer.concat(chunks);

  const sendTvdbRequest = async (token) => {
    const headers = {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/json'
    };
    if (req.headers['content-type']) {
      headers['Content-Type'] = req.headers['content-type'];
    }

    return fetch(targetUrl, {
      method: req.method,
      headers,
      body: ['GET', 'HEAD'].includes(req.method.toUpperCase()) ? undefined : reqBody
    });
  };

  try {
    let tvdbRes = await sendTvdbRequest(currentToken);

    if (tvdbRes.status === 401) {
      console.log(`[TVDB Backend] Received 401 for ${req.method} ${relativeUrl}. Refreshing token...`);
      const newToken = await refreshToken();
      console.log(`[TVDB Backend] Retrying request ${req.method} ${relativeUrl} with new token...`);
      tvdbRes = await sendTvdbRequest(newToken);
    }

    res.statusCode = tvdbRes.status;
    tvdbRes.headers.forEach((val, key) => {
      if (!HOP_BY_HOP_HEADERS.has(key.toLowerCase())) {
        res.setHeader(key, val);
      }
    });

    const buffer = Buffer.from(await tvdbRes.arrayBuffer());
    res.setHeader('Content-Length', buffer.length);
    res.end(buffer);
  } catch (err) {
    console.error(`[TVDB Backend] Proxy error for ${req.method} ${relativeUrl}:`, err);
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'TVDB Proxy internal error' }));
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[TVDB Backend Server] Listening on http://${HOST}:${PORT}`);
});
