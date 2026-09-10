require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { GoogleAuth, OAuth2Client } = require('google-auth-library');

// ── Auth mode: %%AUTH_MODE%% (service_account or oauth) ───────────────────
const path = require('path');
const fs = require('fs');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const GA4_PROPERTY = 'properties/375898158';
const GSC_SITE = 'sc-domain:eluktronics.com';
const WC_PROFILE = '';
const SHEET_ID = '';
const SHEET_TAB = 'dashboard_data';
const DASH_COOKIE = 'eluktronics-dashboard';
const REVIEW_COOKIE = 'pp_reviewer';

// Sheet columns — injected by generator
const SHEET_COLUMNS = [];
const QUALIFIED_LABEL = 'Qualified Leads';

// ── Supabase ───────────────────────────────────────────────────────────────

// ── Google auth (service account) ─────────────────────────────────────────
// ── Google Auth (supports both service account and OAuth) ─────────────────
const AUTH_MODE = 'oauth'; // injected by generator: 'service_account' or 'oauth'

let _oauthClient = null;
function getOAuthClient() {
  if (!_oauthClient) {
    _oauthClient = new OAuth2Client(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      process.env.REDIRECT_URI || 'https://your-dashboard.vercel.app/auth/callback'
    );
    _oauthClient.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
  }
  return _oauthClient;
}

const gauth = AUTH_MODE === 'oauth' ? null : new GoogleAuth({
  credentials: {
    client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    private_key: (() => {
      const envKey = process.env.GOOGLE_PRIVATE_KEY;
      if (envKey) return envKey.replace(/\\n/g, '\n');
      try { return require('fs').readFileSync(require('path').join(__dirname, 'private-key.pem'), 'utf8'); } catch(e) {}
      return '';
    })()
  },
  scopes: [
    'https://www.googleapis.com/auth/analytics.readonly',
    'https://www.googleapis.com/auth/webmasters.readonly',
    'https://www.googleapis.com/auth/spreadsheets.readonly'
  ]
});

async function getGAToken() {
  if (AUTH_MODE === 'oauth') {
    const client = getOAuthClient();
    const { token } = await client.getAccessToken();
    return token;
  }
  const client = await gauth.getClient();
  const token = await client.getAccessToken();
  return token.token;
}

// ── Session helpers ────────────────────────────────────────────────────────
const COOKIE_OPTS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax',
  maxAge: 7 * 24 * 60 * 60 * 1000
};

function signSession(data) {
  return jwt.sign(data, process.env.SESSION_SECRET || 'eluktronics-secret', { expiresIn: '7d' });
}

function readSession(req) {
  try {
    const token = req.cookies?.[REVIEW_COOKIE];
    if (!token) return null;
    return jwt.verify(token, process.env.SESSION_SECRET || 'eluktronics-secret');
  } catch { return null; }
}



// ── GA4 proxy ──────────────────────────────────────────────────────────────
app.post('/api/ga4', async (req, res) => {
  try {
    const token = await getGAToken();
    const response = await axios.post(
      `https://analyticsdata.googleapis.com/v1beta/${GA4_PROPERTY}:runReport`,
      req.body, { headers: { Authorization: `Bearer ${token}` } }
    );
    res.json(response.data);
  } catch (e) {
    res.status(e.response?.status || 500).json({ error: e.response?.data?.error?.message || e.message });
  }
});

// ── GA4 events proxy — auto-discovers all key events ──────────────────────
app.get('/api/ga4/events', async (req, res) => {
  try {
    const { start_date, end_date } = req.query;
    const token = await getGAToken();

    // Step 1: Fetch all events with counts for this period
    const totalsRes = await axios.post(
      `https://analyticsdata.googleapis.com/v1beta/${GA4_PROPERTY}:runReport`,
      {
        dateRanges: [{ startDate: start_date, endDate: end_date }],
        dimensions: [{ name: 'eventName' }],
        metrics: [{ name: 'eventCount' }],
        orderBys: [{ metric: { metricName: 'eventCount' }, desc: true }],
        limit: 50
      },
      { headers: { Authorization: `Bearer ${token}` } }
    );

    // Build event list — filter out GA4 system events + user-excluded events
    const systemEvents = new Set([
      'session_start','first_visit','page_view','user_engagement',
      'scroll','click','file_download','video_start','video_progress','video_complete',
      'view_search_results','exception','purchase','add_to_cart','begin_checkout'
    ]);

    // User-excluded events (configured in generator)
    const excludeParam = req.query.exclude || '';
    const excludeEvents = new Set(
      excludeParam ? excludeParam.split(',').map(e => e.trim()).filter(Boolean) : []
    );

    const allEvents = (totalsRes.data.rows || [])
      .map(r => ({ name: r.dimensionValues[0].value, count: parseInt(r.metricValues[0].value) || 0 }))
      .filter(e => e.count > 0 && !systemEvents.has(e.name) && !excludeEvents.has(e.name));

    if (allEvents.length === 0) {
      return res.json({ groups: [], evMap: {} });
    }

    // Step 2: Fetch time series for all discovered events
    const eventNames = allEvents.map(e => e.name);
    const tsRes = await axios.post(
      `https://analyticsdata.googleapis.com/v1beta/${GA4_PROPERTY}:runReport`,
      {
        dateRanges: [{ startDate: start_date, endDate: end_date }],
        dimensions: [{ name: 'date' }, { name: 'eventName' }],
        metrics: [{ name: 'eventCount' }],
        dimensionFilter: { filter: { fieldName: 'eventName', inListFilter: { values: eventNames } } },
        orderBys: [{ dimension: { dimensionName: 'date' } }],
        limit: 5000
      },
      { headers: { Authorization: `Bearer ${token}` } }
    );

    // Build time series map
    const tsMap = {};
    (tsRes.data.rows || []).forEach(r => {
      const date = r.dimensionValues[0].value;
      const event = r.dimensionValues[1].value;
      if (!tsMap[date]) tsMap[date] = {};
      tsMap[date][event] = parseInt(r.metricValues[0].value) || 0;
    });

    const dates = Object.keys(tsMap).sort();

    // Assign colors — cycle through palette
    const palette = ['#3a8fd4','#a78bfa','#f59e0b','#34d399','#f87171','#60a5fa','#fb923c','#a3e635','#e879f9','#2dd4bf'];

    // Build groups — each event is its own group
    const evMap = {};
    allEvents.forEach(e => { evMap[e.name] = e.count; });

    const groups = allEvents.map((ev, i) => ({
      key: ev.name.replace(/[^a-z0-9]/gi, '_'),
      label: formatEventLabel(ev.name),
      eventName: ev.name,
      color: palette[i % palette.length],
      total: ev.count,
      timeseries: dates.map(date => ({ date, value: tsMap[date]?.[ev.name] || 0 }))
    }));

    res.json({ groups, evMap });
  } catch (e) {
    res.status(e.response?.status || 500).json({ error: e.response?.data?.error?.message || e.message });
  }
});

function formatEventLabel(eventName) {
  // Convert snake_case event names to readable labels
  return eventName
    .replace(/_/g, ' ')
    .replace(/\w/g, l => l.toUpperCase())
    .replace(/^Ads Conversion/, 'Ads')
    .replace(/Unique$/, '(Unique)')
    .replace(/Repeat$/, '(Repeat)');
}

// ── GSC proxy ──────────────────────────────────────────────────────────────
app.post('/api/gsc', async (req, res) => {
  try {
    const token = await getGAToken();
    const response = await axios.post(
      `https://searchconsole.googleapis.com/webmasters/v3/sites/${encodeURIComponent(GSC_SITE)}/searchAnalytics/query`,
      req.body, { headers: { Authorization: `Bearer ${token}` } }
    );
    res.json(response.data);
  } catch (e) {
    res.status(e.response?.status || 500).json({ error: e.response?.data?.error?.message || e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`\n✅ Eluktronics Dashboard running at http://localhost:${PORT}\n`));
module.exports = app;
