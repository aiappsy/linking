const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const LINKS_FILE = path.join(__dirname, 'links.json');
const SETTINGS_FILE = path.join(__dirname, 'settings.json');

let firestoreDb = null;
let isFirestoreReady = false;
let linksMemoryCache = null;
let settingsMemoryCache = null;

try {
  const { Firestore } = require('@google-cloud/firestore');
  // Initialize Firestore client with ignoreUndefinedProperties
  firestoreDb = new Firestore({ ignoreUndefinedProperties: true });
  console.log('[Firestore] Klient initialisert. Kobler til Google Cloud Firestore...');
} catch (err) {
  console.log('[Firestore] Kunne ikke laste Firestore-bibliotek, kjører i lokal filmodus:', err.message);
}

function parseDomainEntry(domainStr, label = '', isDefault = false) {
  const clean = domainStr.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/+$/, '');
  const parts = clean.split('.');
  const isSubdomain = parts.length >= 3;
  const subdomain = isSubdomain ? parts[0] : '@';
  const parentDomain = isSubdomain ? parts.slice(1).join('.') : clean;
  const defaultLabel = isSubdomain ? `${clean} (Subdomene – ${clean.length} tegn)` : `${clean} (Toppdomene / Apex – ${clean.length} tegn)`;
  const recordType = isSubdomain ? 'CNAME' : 'A (4 poster)';
  const target = isSubdomain 
    ? 'ghs.googlehosted.com.' 
    : '216.239.32.21 (samt .34, .36, .38)';
  return {
    domain: clean,
    label: label ? label.trim() : defaultLabel,
    isDefault,
    isSubdomain,
    subdomain,
    parentDomain,
    recordType,
    target,
    aRecords: isSubdomain ? [] : ['216.239.32.21', '216.239.34.21', '216.239.36.21', '216.239.38.21'],
    gcloudCommand: `gcloud beta run domain-mappings create --service aiappsy-link-engine --domain ${clean} --region us-west1`
  };
}

const DEFAULT_SETTINGS = {
  activeDomain: process.env.CUSTOM_DOMAIN || process.env.SHORT_DOMAIN || 'aiappsy.com',
  domains: [
    parseDomainEntry('aiappsy.com', 'aiappsy.com (Hoveddomene – 11 tegn)', true),
    parseDomainEntry('go.aiappsy.no', 'go.aiappsy.no (Anbefalt subdomene – 13 tegn)', false),
    parseDomainEntry('link.aiappsy.no', 'link.aiappsy.no (Subdomene – 15 tegn)', false),
    parseDomainEntry('aiappsy.link', 'aiappsy.link (Toppdomene – 12 tegn)', false)
  ]
};

function loadSettingsFromFile() {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      const data = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf-8'));
      if (!data.domains || !Array.isArray(data.domains) || data.domains.length === 0) {
        data.domains = DEFAULT_SETTINGS.domains;
      }
      if (!data.activeDomain) {
        data.activeDomain = data.domains[0].domain;
      }
      return data;
    }
  } catch (err) {
    console.error('Kunne ikke laste settings.json:', err.message);
  }
  return DEFAULT_SETTINGS;
}

function saveSettingsToFile(settings) {
  try {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2), 'utf-8');
    return true;
  } catch (err) {
    console.error('Feil ved lagring av settings.json:', err.message);
    return false;
  }
}

function loadLinksFromFile() {
  try {
    if (fs.existsSync(LINKS_FILE)) {
      const content = fs.readFileSync(LINKS_FILE, 'utf-8');
      return content ? JSON.parse(content) : {};
    }
  } catch (err) {
    console.error('Kunne ikke laste links.json:', err.message);
  }
  return {};
}

function saveLinksToFile(links) {
  try {
    fs.writeFileSync(LINKS_FILE, JSON.stringify(links, null, 2), 'utf-8');
    return true;
  } catch (err) {
    console.error('Feil ved lagring av links.json:', err.message);
    return false;
  }
}

// Initial synkronisering mot Firestore ved oppstart
async function syncFromFirestore() {
  linksMemoryCache = loadLinksFromFile();
  settingsMemoryCache = loadSettingsFromFile();

  if (!firestoreDb) return;

  try {
    const snapshot = await firestoreDb.collection('links').get();
    const remoteLinks = {};
    snapshot.forEach(doc => {
      remoteLinks[doc.id] = doc.data();
    });

    if (Object.keys(remoteLinks).length > 0) {
      linksMemoryCache = remoteLinks;
      saveLinksToFile(remoteLinks);
      console.log(`[Firestore] Synkroniserte ${Object.keys(remoteLinks).length} lenker fra Firestore.`);
    } else if (Object.keys(linksMemoryCache).length > 0) {
      // Last opp eksisterende lokale lenker til Firestore
      const batch = firestoreDb.batch();
      for (const [slug, item] of Object.entries(linksMemoryCache)) {
        batch.set(firestoreDb.collection('links').doc(slug), item);
      }
      await batch.commit();
      console.log(`[Firestore] Lastet opp ${Object.keys(linksMemoryCache).length} lokale lenker til Firestore.`);
    }

    try {
      const setDoc = await firestoreDb.collection('settings').doc('global').get();
      if (setDoc.exists) {
        settingsMemoryCache = setDoc.data();
        saveSettingsToFile(settingsMemoryCache);
        console.log('[Firestore] Innstillinger synkronisert fra Firestore.');
      }
    } catch (e) {}

    isFirestoreReady = true;
    console.log('[Firestore] Persistent database er tilkoblet og klar!');
  } catch (err) {
    console.warn('[Firestore] Info: Firestore ikke tilgjengelig eller ikke aktivert ennå. Bruker lokal fillagring:', err.message);
  }
}
syncFromFirestore();

function loadSettings() {
  if (!settingsMemoryCache) {
    settingsMemoryCache = loadSettingsFromFile();
  }
  return settingsMemoryCache;
}

function saveSettings(settings) {
  settingsMemoryCache = settings;
  saveSettingsToFile(settings);
  if (isFirestoreReady && firestoreDb) {
    firestoreDb.collection('settings').doc('global').set(settings, { merge: true })
      .catch(err => console.error('[Firestore] Feil ved lagring av innstillinger:', err.message));
  }
  return true;
}

function loadLinks() {
  if (!linksMemoryCache) {
    linksMemoryCache = loadLinksFromFile();
  }
  return linksMemoryCache;
}

function saveLinks(links, modifiedSlug = null) {
  linksMemoryCache = links;
  saveLinksToFile(links);

  if (isFirestoreReady && firestoreDb) {
    if (modifiedSlug) {
      if (links[modifiedSlug]) {
        firestoreDb.collection('links').doc(modifiedSlug).set(links[modifiedSlug], { merge: true })
          .catch(err => console.error(`[Firestore] Feil ved lagring av /${modifiedSlug}:`, err.message));
      } else {
        firestoreDb.collection('links').doc(modifiedSlug).delete()
          .catch(err => console.error(`[Firestore] Feil ved sletting av /${modifiedSlug}:`, err.message));
      }
    } else {
      const batch = firestoreDb.batch();
      for (const [slug, item] of Object.entries(links)) {
        batch.set(firestoreDb.collection('links').doc(slug), item);
      }
      batch.commit().catch(err => console.error('[Firestore] Batch-lagringsfeil:', err.message));
    }
  }
  return true;
}

// Serve static assets from public folder and current directory
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(__dirname));

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

// API Cache-Control & headers middleware
app.use('/api', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  next();
});

// API: Hent alle lenker
app.get('/api/links', (req, res) => {
  const links = loadLinks();
  const settings = loadSettings();
  res.json({
    success: true,
    links,
    activeDomain: settings.activeDomain,
    domains: settings.domains,
    count: Object.keys(links).length
  });
});

// API: Opprett eller oppdater lenke
app.post('/api/links', (req, res) => {
  const { slug, url, domain } = req.body;
  if (!slug || !url) {
    return res.status(400).json({ success: false, error: 'Både kort-URL (slug) og måladresse (url) kreves.' });
  }

  const cleanSlug = slug.trim().toLowerCase().replace(/^\/+/, '');
  let cleanUrl = url.trim();
  if (!/^https?:\/\//i.test(cleanUrl)) {
    cleanUrl = 'https://' + cleanUrl;
  }

  const reserved = ['api', 'health', 'public', 'assets', 'favicon.ico', 'settings', 'admin', 'domains'];
  if (reserved.includes(cleanSlug)) {
    return res.status(400).json({ success: false, error: `Slug "${cleanSlug}" er en reservert systemsti.` });
  }

  const links = loadLinks();
  const settings = loadSettings();
  const selectedDomain = domain || settings.activeDomain || 'aiappsy.com';

  const isNew = !links[cleanSlug];
  links[cleanSlug] = {
    url: cleanUrl,
    domain: selectedDomain,
    clicks: links[cleanSlug] ? links[cleanSlug].clicks : 0,
    createdAt: links[cleanSlug] ? links[cleanSlug].createdAt : new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  saveLinks(links, cleanSlug);
  res.json({
    success: true,
    message: isNew ? `Kortlenke /${cleanSlug} opprettet!` : `Kortlenke /${cleanSlug} oppdatert!`,
    slug: cleanSlug,
    item: links[cleanSlug]
  });
});

// API: Oppdater spesifikk lenke
app.put('/api/links/:slug', (req, res) => {
  const targetSlug = (req.params.slug || '').trim().toLowerCase().replace(/^\/+/, '');
  const { url, domain } = req.body;
  if (!url) {
    return res.status(400).json({ success: false, error: 'Måladresse (url) kreves.' });
  }

  let cleanUrl = url.trim();
  if (!/^https?:\/\//i.test(cleanUrl)) {
    cleanUrl = 'https://' + cleanUrl;
  }

  const links = loadLinks();
  const settings = loadSettings();
  const existing = links[targetSlug] || {};

  links[targetSlug] = {
    url: cleanUrl,
    domain: domain || existing.domain || settings.activeDomain || 'aiappsy.com',
    clicks: existing.clicks || 0,
    createdAt: existing.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  saveLinks(links, targetSlug);
  res.json({
    success: true,
    message: `Kortlenke /${targetSlug} ble oppdatert!`,
    slug: targetSlug,
    item: links[targetSlug]
  });
});

// API: Slett en lenke
app.delete('/api/links/:slug', (req, res) => {
  const slug = req.params.slug.trim().toLowerCase();
  const links = loadLinks();
  if (!links[slug]) {
    return res.status(404).json({ success: false, error: `Kortlenke /${slug} finnes ikke.` });
  }

  delete links[slug];
  saveLinks(links, slug);
  res.json({ success: true, message: `Kortlenke /${slug} ble slettet.` });
});

// API: Hent domener
app.get('/api/domains', (req, res) => {
  const settings = loadSettings();
  const proto = req.headers['x-forwarded-proto'] || req.protocol;
  const host = req.headers['x-forwarded-host'] || req.get('host');
  const cloudRunUrl = `${proto}://${host}`;

  res.json({
    success: true,
    activeDomain: settings.activeDomain,
    domains: settings.domains,
    cloudRunUrl,
    serviceName: process.env.CLOUD_RUN_SERVICE || 'aiappsy-link-engine',
    region: process.env.CLOUD_RUN_REGION || 'us-west1'
  });
});

// API: Legg til domene
app.post('/api/domains', (req, res) => {
  const { domain, label, setAsDefault } = req.body;
  if (!domain || typeof domain !== 'string') {
    return res.status(400).json({ success: false, error: 'Vennligst oppgi et gyldig domenenavn.' });
  }

  const cleanDomain = domain.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/+$/, '');
  if (!cleanDomain || cleanDomain.length < 3 || !cleanDomain.includes('.')) {
    return res.status(400).json({ success: false, error: 'Ugyldig domeneformat. Eksempel: go.aiappsy.no eller mittdomene.no' });
  }

  const settings = loadSettings();
  const existing = settings.domains.find(d => d.domain === cleanDomain);
  const entry = parseDomainEntry(cleanDomain, label, !!setAsDefault);

  if (existing) {
    existing.label = entry.label;
    if (setAsDefault) {
      settings.domains.forEach(d => d.isDefault = false);
      existing.isDefault = true;
      settings.activeDomain = cleanDomain;
    }
  } else {
    if (setAsDefault) {
      settings.domains.forEach(d => d.isDefault = false);
      settings.activeDomain = cleanDomain;
    }
    settings.domains.push(entry);
  }

  saveSettings(settings);
  res.json({
    success: true,
    message: `Domenet ${cleanDomain} er lagret og klart til bruk!`,
    domain: entry,
    activeDomain: settings.activeDomain,
    domains: settings.domains
  });
});

// API: Sett standard domene
app.put('/api/domains/default', (req, res) => {
  const { defaultDomain } = req.body;
  if (!defaultDomain) {
    return res.status(400).json({ success: false, error: 'Ingen domene oppgitt.' });
  }

  const clean = defaultDomain.trim().toLowerCase();
  const settings = loadSettings();
  const match = settings.domains.find(d => d.domain === clean);
  if (!match) {
    return res.status(404).json({ success: false, error: `Domenet ${clean} finnes ikke i listen.` });
  }

  settings.domains.forEach(d => d.isDefault = (d.domain === clean));
  settings.activeDomain = clean;
  saveSettings(settings);

  res.json({
    success: true,
    message: `Standard domene er nå satt til ${clean}`,
    activeDomain: clean,
    domains: settings.domains
  });
});

// API: Slett domene
app.delete('/api/domains/:domain', (req, res) => {
  const targetDomain = req.params.domain.trim().toLowerCase();
  const settings = loadSettings();

  if (settings.domains.length <= 1) {
    return res.status(400).json({ success: false, error: 'Kan ikke slette det eneste gjenværende domenet.' });
  }

  const idx = settings.domains.findIndex(d => d.domain === targetDomain);
  if (idx === -1) {
    return res.status(404).json({ success: false, error: `Domenet ${targetDomain} ble ikke funnet.` });
  }

  settings.domains.splice(idx, 1);
  if (settings.activeDomain === targetDomain) {
    settings.activeDomain = settings.domains[0].domain;
    settings.domains[0].isDefault = true;
  }

  saveSettings(settings);
  res.json({
    success: true,
    message: `Domenet ${targetDomain} ble fjernet`,
    activeDomain: settings.activeDomain,
    domains: settings.domains
  });
});

// API: Hent innstillinger og miljøverdier
app.get('/api/settings', (req, res) => {
  const settings = loadSettings();
  res.json({
    success: true,
    settings
  });
});

// API: Oppdater innstillinger og miljøverdier
app.post('/api/settings', (req, res) => {
  const { serviceName, region, cloudRunUrl, customer, dns, activeDomain } = req.body;
  const settings = loadSettings();

  if (serviceName) settings.serviceName = serviceName.trim();
  if (region) settings.region = region.trim();
  if (cloudRunUrl) settings.cloudRunUrl = cloudRunUrl.trim();
  if (activeDomain) settings.activeDomain = activeDomain.trim();
  if (customer && typeof customer === 'object') {
    settings.customer = { ...settings.customer, ...customer };
  }
  if (dns && typeof dns === 'object') {
    settings.dns = { ...settings.dns, ...dns };
  }

  saveSettings(settings);
  res.json({
    success: true,
    message: 'Systeminnstillinger og verdier er oppdatert og lagret!',
    settings
  });
});

// API: System info
app.get('/api/info', (req, res) => {
  const settings = loadSettings();
  const links = loadLinks();
  res.json({
    service: 'AIAppsy Link Engine',
    version: '1.0.0',
    platform: 'Google Cloud Run',
    region: process.env.CLOUD_RUN_REGION || 'us-west1',
    activeDomain: settings.activeDomain,
    totalLinks: Object.keys(links).length,
    uptimeSeconds: Math.floor(process.uptime())
  });
});

// API: Diagnose domene og SSL status
app.get('/api/diagnose-domain', async (req, res) => {
  const dns = require('dns').promises;
  const https = require('https');
  const domain = (req.query.domain || 'aiappsy.com').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  
  try {
    const aRecords = await dns.resolve4(domain).catch(() => []);
    const cnameRecords = await dns.resolveCname(domain).catch(() => []);

    const httpsStatus = await new Promise((resolve) => {
      const request = https.request(`https://${domain}/`, {
        method: 'HEAD',
        timeout: 2500,
        rejectUnauthorized: false
      }, (resp) => {
        resolve({ connected: true, statusCode: resp.statusCode });
      });
      request.on('error', (err) => {
        resolve({ connected: false, error: err.message, code: err.code });
      });
      request.on('timeout', () => {
        request.destroy();
        resolve({ connected: false, error: 'Tilkobling tidsavbrutt', code: 'ETIMEDOUT' });
      });
      request.end();
    });

    res.json({
      success: true,
      domain,
      aRecords,
      cnameRecords,
      httpsStatus,
      isWorking: httpsStatus.connected,
      help: httpsStatus.connected 
        ? 'Domenet svarer på HTTPS og er operativt!' 
        : `Domenet ${domain} avslutter tilkoblingen (${httpsStatus.error || httpsStatus.code}). Dette forårsaker ERR_CONNECTION_CLOSED i nettleseren inntil Google Cloud Run domain mapping og SSL-sertifikat er ferdig utstedt i Google Cloud Console.`
    });
  } catch (err) {
    res.json({ success: false, domain, error: err.message });
  }
});


// API: Test/Inspiser en kortlenke uten ekstern nettleser-omdirigering
app.get('/api/test-link/:slug', (req, res) => {
  let rawSlug = (req.params.slug || '').trim().replace(/^\/+|\/+$/g, '');
  try { rawSlug = decodeURIComponent(rawSlug); } catch (e) {}
  const slug = rawSlug.toLowerCase();

  const links = loadLinks();
  const item = links[slug];

  if (item && item.url) {
    // Inkrementer klikk
    item.clicks = (item.clicks || 0) + 1;
    item.lastClickedAt = new Date().toISOString();
    saveLinks(links, slug);

    return res.json({
      success: true,
      found: true,
      slug,
      targetUrl: item.url,
      domain: item.domain,
      clicks: item.clicks,
      httpStatus: 302,
      timestamp: new Date().toISOString()
    });
  }

  return res.status(404).json({
    success: false,
    found: false,
    slug,
    error: `Kortlenken /${slug} ble ikke funnet i systemet.`
  });
});

// 302 Redirection Engine for short links
app.get('/:slug', (req, res, next) => {
  let rawSlug = (req.params.slug || '').trim().replace(/^\/+|\/+$/g, '');
  try {
    rawSlug = decodeURIComponent(rawSlug);
  } catch (e) {}

  if (!rawSlug) {
    return next();
  }

  const slug = rawSlug.toLowerCase();

  // Ignorer kun faktiske statiske ressurs-filendelser og systemruter
  const staticExtensions = ['.ico', '.png', '.jpg', '.jpeg', '.svg', '.gif', '.webp', '.css', '.js', '.map', '.json', '.txt', '.xml'];
  const isStaticFile = staticExtensions.some(ext => slug.endsWith(ext));
  if (isStaticFile || ['api', 'health', 'public', 'assets', 'favicon.ico'].includes(slug)) {
    return next();
  }

  const links = loadLinks();
  const item = links[slug];

  if (item && item.url) {
    // Inkrementer klikkteller
    item.clicks = (item.clicks || 0) + 1;
    item.lastClickedAt = new Date().toISOString();
    saveLinks(links, slug);

    // Videresend query parameters dersom de finnes i forespørselen (f.eks. ?ref=e-post)
    let targetUrl = item.url;
    const qIndex = req.originalUrl.indexOf('?');
    if (qIndex !== -1) {
      const qs = req.originalUrl.substring(qIndex + 1);
      if (qs) {
        targetUrl += (targetUrl.includes('?') ? '&' : '?') + qs;
      }
    }

    console.log(`[302 Redirect Engine] /${slug} -> ${targetUrl} (Total klikk: ${item.clicks})`);

    // Dual redirection: Både HTTP 302 Location-header og HTML Meta-Refresh / JS location.replace
    res.status(302);
    res.set('Location', targetUrl);
    res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');

    return res.send(`<!DOCTYPE html>
<html lang="no">
<head>
  <meta charset="utf-8">
  <title>Omdirigerer...</title>
  <meta http-equiv="refresh" content="0; url=${encodeURI(targetUrl)}">
  <script>window.location.replace(${JSON.stringify(targetUrl)});</script>
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0b0f19; color: #f8fafc; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; padding: 20px;">
  <div style="background: #131b2e; border: 1px solid #1e293b; border-radius: 12px; padding: 32px; max-width: 480px; width: 100%; text-align: center;">
    <div style="font-size: 20px; font-weight: 800; color: #38bdf8; margin-bottom: 12px;">⚡ AIAppsy Link Engine</div>
    <div style="font-size: 15px; color: #94a3b8; margin-bottom: 16px;">Omdirigerer deg automatisk til:</div>
    <div style="font-family: monospace; background: #0f172a; border: 1px solid #334155; padding: 10px 14px; border-radius: 6px; color: #38bdf8; word-break: break-all; margin-bottom: 20px; font-size: 13px;">${encodeURI(targetUrl)}</div>
    <a href="${encodeURI(targetUrl)}" style="display: inline-block; background: #0284c7; color: #ffffff; text-decoration: none; font-weight: 600; padding: 10px 20px; border-radius: 6px; font-size: 14px;">Klikk her om du ikke sendes videre</a>
  </div>
</body>
</html>`);
  }

  // 404 Not Found layout hvis slug ikke finnes
  res.status(404).send(`
    <!DOCTYPE html>
    <html lang="no">
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <title>404 - Kortlenke ikke funnet | AIAppsy</title>
      <style>
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0b0f19; color: #f8fafc; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; padding: 20px; }
        .card { background: #131b2e; border: 1px solid #1e293b; border-radius: 12px; padding: 40px; max-width: 480px; width: 100%; text-align: center; box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.5); }
        .logo { font-size: 24px; font-weight: 800; color: #38bdf8; margin-bottom: 20px; }
        h1 { font-size: 22px; font-weight: 700; margin: 0 0 10px 0; color: #ffffff; }
        p { color: #94a3b8; font-size: 14px; line-height: 1.6; margin: 0 0 24px 0; }
        .slug-box { font-family: monospace; background: #0f172a; border: 1px solid #334155; padding: 8px 14px; border-radius: 6px; color: #f43f5e; font-size: 15px; display: inline-block; margin-bottom: 24px; }
        .btn { display: inline-flex; align-items: center; justify-content: center; background: #0284c7; color: #ffffff; text-decoration: none; font-weight: 600; padding: 10px 20px; border-radius: 6px; font-size: 14px; }
        .btn:hover { background: #0369a1; }
      </style>
    </head>
    <body>
      <div class="card">
        <div class="logo">⚡ AIAppsy Link Engine</div>
        <div class="slug-box">/${slug}</div>
        <h1>Kortlenken finnes ikke</h1>
        <p>Denne omdirigeringen er enten utløpt, slettet eller ikke opprettet ennå.</p>
        <a href="/" class="btn">Gå til Kontrollpanelet</a>
      </div>
    </body>
    </html>
  `);
});

// Serve root index.html
app.get('*', (req, res) => {
  const publicIndex = path.join(__dirname, 'public', 'index.html');
  if (fs.existsSync(publicIndex)) {
    return res.sendFile(publicIndex);
  }
  const rootIndex = path.join(__dirname, 'index.html');
  if (fs.existsSync(rootIndex)) {
    return res.sendFile(rootIndex);
  }
  res.send('AIAppsy Link Engine is active.');
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[AIAppsy Link Engine] Kjører på port ${PORT}`);
});
