// index.js
// Roblox bio + connections fetcher (no Selenium) for Render.com
// - Resolves username -> userId (if needed)
// - Gets bio from public Users API
// - Gets "Connections" from private AccountInformation API using your .ROBLOSECURITY cookie
// - Parses bio for social handles + raw URLs
// - Posts results to a Discord webhook
// - Exposes /health and /check endpoints
//
// Env vars required on Render:
//   WEBHOOK_URL     - Discord webhook URL
//   ROBLOX_COOKIE   - Your .ROBLOSECURITY cookie (13+ account recommended)
//
// Render logs: console.log / console.error appear in the dashboard logs.

const express = require('express');
const axios = require('axios');

const WEBHOOK_URL = process.env.WEBHOOK_URL || '';
const ROBLOX_COOKIE = process.env.ROBLOX_COOKIE || '';

if (!WEBHOOK_URL) console.warn('[WARN] WEBHOOK_URL is not set.');
if (!ROBLOX_COOKIE) console.warn('[WARN] ROBLOX_COOKIE is not set. Connections will not be fetched.');

const app = express();
app.use(express.json());

// ===== Social parsing =====
const SOCIAL_PATTERNS = [
  { name: 'Instagram', re: /\b(?:ig|insta|instagram)\s*[:\-]?\s*@?([a-z0-9._]{2,30})\b/i },
  { name: 'Twitter',   re: /\b(?:x|twitter|tweet)\s*[:\-]?\s*@?([a-z0-9._]{2,30})\b/i },
  { name: 'Discord',   re: /\b(?:discord|dc)\s*[:\-]?\s*([a-z0-9._#]{2,37})\b/i },
  { name: 'YouTube',   re: /\b(?:yt|youtube)\s*[:\-]?\s*@?([a-z0-9._-]{2,60})\b/i },
  { name: 'TikTok',    re: /\b(?:tt|tiktok)\s*[:\-]?\s*@?([a-z0-9._]{2,30})\b/i },
  { name: 'Facebook',  re: /\b(?:fb|facebook)\s*[:\-]?\s*@?([a-z0-9._]{2,50})\b/i },
  { name: 'Telegram',  re: /\b(?:tg|telegram)\s*[:\-]?\s*@?([a-z0-9._]{2,50})\b/i }
];

const URL_RE = /\bhttps?:\/\/[^\s)]+/gi;

function extractConnectionsFromBio(text) {
  const found = [];
  for (const { name, re } of SOCIAL_PATTERNS) {
    const m = text.match(re);
    if (m) found.push({ type: name, handle: m[1] });
  }
  const urls = [...(text.matchAll(URL_RE) || [])].map(m => m[0]);
  // de-dupe (case-insensitive)
  const seen = new Set();
  const dedup = urls.filter(u => {
    const k = u.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return { found, urls: dedup };
}

// ===== Helpers =====
async function usernameToId(username) {
  console.log(`[INFO] Resolving username -> id: ${username}`);
  const { data } = await axios.post(
    'https://users.roblox.com/v1/usernames/users',
    { usernames: [username], excludeBannedUsers: false },
    { headers: { 'Content-Type': 'application/json' } }
  );
  const id = data?.data?.[0]?.id;
  if (!id) throw new Error(`Username not found: ${username}`);
  console.log(`[INFO] Resolved userId: ${id}`);
  return id;
}

async function getUserInfo(userId) {
  console.log(`[INFO] Fetching user info for id: ${userId}`);
  const { data } = await axios.get(`https://users.roblox.com/v1/users/${userId}`, {
    headers: { 'User-Agent': 'Mozilla/5.0' }
  });
  return data; // includes { id, name, description, ... }
}

async function getConnections(userId) {
  if (!ROBLOX_COOKIE) {
    console.log('[INFO] ROBLOX_COOKIE missing — skipping connections.');
    return [];
  }
  console.log(`[INFO] Fetching connections for id: ${userId}`);
  try {
    const { data } = await axios.get(
      `https://accountinformation.roblox.com/v1/users/${userId}/social-links`,
      {
        headers: {
          'Cookie': `.ROBLOSECURITY=${ROBLOX_COOKIE}`,
          'User-Agent': 'Mozilla/5.0',
          'Accept': 'application/json'
        },
        // WithCredentials not needed in Node, but keeping timeout for network stability
        timeout: 15000
      }
    );
    // Expecting array like: [{ id, type, url }, ...]
    if (!Array.isArray(data)) {
      console.log('[INFO] Connections response not an array; returning empty.');
      return [];
    }
    console.log(`[INFO] Connections found: ${data.length}`);
    return data;
  } catch (err) {
    const status = err?.response?.status;
    const body = err?.response?.data;
    console.error(`[ERROR] Connections fetch failed (${status || 'no-status'}):`, body || err.message);
    // Common causes: 401 (invalid/expired cookie), 403 (age < 13 or privacy), 429 (rate limit)
    return [];
  }
}

// Support both numeric ID and name in Rolimons URLs
function parseRolimonsTarget(s) {
  const idMatch = s.match(/\/player\/(\d+)(?:\/|$)/i);
  if (idMatch) return { userId: idMatch[1] };
  const nameMatch = s.match(/\/player\/([A-Za-z0-9_]+)(?:\/|$)/i);
  if (nameMatch) return { username: nameMatch[1] };
  return {};
}

// ===== Discord =====
async function sendDiscordEmbed({ username, userId, bio, parsedBio, connections }) {
  if (!WEBHOOK_URL) return;

  const fields = [
    { name: 'User', value: `${username} (${userId})`, inline: true },
    { name: 'Bio length', value: String(bio?.length || 0), inline: true }
  ];

  if (parsedBio.found.length) {
    fields.push({
      name: 'Parsed Handles (Bio)',
      value: parsedBio.found.map(f => `• **${f.type}**: ${f.handle}`).join('\n').slice(0, 1024)
    });
  }

  if (parsedBio.urls.length) {
    fields.push({
      name: 'URLs in Bio',
      value: parsedBio.urls.slice(0, 10).join('\n').slice(0, 1024)
    });
  }

  if (Array.isArray(connections) && connections.length) {
    const pretty = connections
      .map(c => `• **${c.type || c.platform || 'Unknown'}** → ${c.url || 'N/A'}`)
      .join('\n');
    fields.push({
      name: 'Roblox Connections (API)',
      value: pretty.slice(0, 1024)
    });
  } else {
    fields.push({
      name: 'Roblox Connections (API)',
      value: 'None or not visible to this account.'
    });
  }

  const embed = {
    title: 'Roblox Profile Scan',
    color: 0x00AE86,
    fields,
    timestamp: new Date().toISOString()
  };

  try {
    await axios.post(WEBHOOK_URL, { embeds: [embed] });
    console.log('[INFO] Sent results to Discord webhook.');
  } catch (e) {
    console.error('[ERROR] Discord webhook failed:', e?.response?.status, e?.response?.data || e.message);
  }
}

// ===== Routes =====
app.get('/health', (_, res) => res.send('ok'));

app.get('/check', async (req, res) => {
  const startedAt = Date.now();
  try {
    let { username, userId, rolimonsUrl } = req.query;

    if (rolimonsUrl) {
      const parsed = parseRolimonsTarget(String(rolimonsUrl));
      if (parsed.userId) userId = parsed.userId;
      if (parsed.username && !username) username = parsed.username;
    }

    if (!userId) {
      if (!username) {
        return res.status(400).json({ error: 'Provide ?username=NAME or ?userId=ID or ?rolimonsUrl=' });
      }
      userId = await usernameToId(String(username));
    }

    const info = await getUserInfo(String(userId));
    const bio = info?.description || '';
    const resolvedName = info?.name || username || 'Unknown';

    const parsedBio = extractConnectionsFromBio(bio);
    const connections = await getConnections(String(userId));

    await sendDiscordEmbed({
      username: resolvedName,
      userId,
      bio,
      parsedBio,
      connections
    });

    console.log(`[INFO] Done in ${Date.now() - startedAt}ms for userId=${userId}`);
    res.json({
      userId,
      username: resolvedName,
      bio,
      parsed: parsedBio,
      connections
    });
  } catch (e) {
    console.error('[ERROR] /check failed:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/check', async (req, res) => {
  const startedAt = Date.now();
  try {
    let { username, userId, rolimonsUrl } = req.body || {};

    if (rolimonsUrl) {
      const parsed = parseRolimonsTarget(String(rolimonsUrl));
      if (parsed.userId) userId = parsed.userId;
      if (parsed.username && !username) username = parsed.username;
    }

    if (!userId) {
      if (!username) {
        return res.status(400).json({ error: 'Provide username, userId, or rolimonsUrl' });
      }
      userId = await usernameToId(String(username));
    }

    const info = await getUserInfo(String(userId));
    const bio = info?.description || '';
    const resolvedName = info?.name || username || 'Unknown';

    const parsedBio = extractConnectionsFromBio(bio);
    const connections = await getConnections(String(userId));

    await sendDiscordEmbed({
      username: resolvedName,
      userId,
      bio,
      parsedBio,
      connections
    });

    console.log(`[INFO] Done in ${Date.now() - startedAt}ms for userId=${userId}`);
    res.json({
      userId,
      username: resolvedName,
      bio,
      parsed: parsedBio,
      connections
    });
  } catch (e) {
    console.error('[ERROR] /check failed:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ===== Start server =====
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`[START] Server listening on :${PORT}`));
