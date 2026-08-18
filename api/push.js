import webpush from 'web-push';

const DEVICES = 'fbb287c5aa9b4e2881245347c38dab3c';
const SUBJECT = 'mailto:aidanavila63@gmail.com';

const txt = p => ((p && (p.title || p.rich_text)) || []).map(t => t.plain_text || '').join('');

async function notion(path, method = 'GET', body) {
  const res = await fetch('https://api.notion.com/v1/' + path, {
    method,
    headers: {
      Authorization: 'Bearer ' + process.env.NOTION_TOKEN,
      'Notion-Version': '2022-06-28',
      'Content-Type': 'application/json'
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const json = await res.json();
  if (!res.ok) throw new Error('Notion ' + res.status + ': ' + (json.message || ''));
  return json;
}

function safeParse(s) { try { return JSON.parse(s); } catch (e) { return null; } }

/*
 * Reads quiet_hours_start/end from the same Settings database notion.js
 * uses (hardcoded here rather than shared, since this file has no shared
 * config module with it) and checks whether right now falls inside that
 * window, handling the case where it wraps past midnight (e.g. 22:00 to
 * 07:00). Any failure here — malformed times, the query itself failing —
 * fails open (returns false, meaning notifications still send). A broken
 * quiet-hours check should never be the reason a real notification is
 * silently swallowed.
 */
const SETTINGS_DB = 'ccce8886191f44b2b85f5a4ebe6b33a3';

async function quietHoursActive() {
  try {
    const q = await notion(`databases/${SETTINGS_DB}/query`, 'POST', {
      filter: { or: [
        { property: 'Name', title: { equals: 'quiet_hours_start' } },
        { property: 'Name', title: { equals: 'quiet_hours_end' } }
      ]}, page_size: 2
    });
    const byName = {};
    q.results.forEach(p => { byName[txt(p.properties.Name)] = txt(p.properties.Value); });
    const start = byName.quiet_hours_start, end = byName.quiet_hours_end;
    if (!start || !end) return false;

    const tzNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Toronto' }));
    const mins = tzNow.getHours() * 60 + tzNow.getMinutes();
    const [sh, sm] = start.split(':').map(Number);
    const [eh, em] = end.split(':').map(Number);
    if ([sh, sm, eh, em].some(n => Number.isNaN(n))) return false;
    const startMins = sh * 60 + sm, endMins = eh * 60 + em;
    if (startMins === endMins) return false; // identical times = disabled

    return startMins < endMins
      ? (mins >= startMins && mins < endMins)
      : (mins >= startMins || mins < endMins); // wraps past midnight
  } catch (e) { return false; }
}

async function rows(kind) {
  const q = await notion(`databases/${DEVICES}/query`, 'POST', {
    filter: { property: 'Kind', select: { equals: kind } }, page_size: 50
  });
  return q.results.map(p => ({ id: p.id, data: safeParse(txt(p.properties.Data)) }))
                  .filter(r => r.data);
}

async function addRow(kind, name, data) {
  return notion('pages', 'POST', {
    parent: { database_id: DEVICES },
    properties: {
      Name: { title: [{ text: { content: String(name).slice(0, 90) } }] },
      Kind: { select: { name: kind } },
      Data: { rich_text: [{ text: { content: JSON.stringify(data).slice(0, 1900) } }] }
    }
  });
}

/*
 * The VAPID keys identify this app to Apple and Google's push services.
 * Generated once and kept in the Devices table, so they survive redeploys.
 */
async function vapid() {
  const found = await rows('vapid');
  if (found.length && found[0].data.publicKey) return found[0].data;
  const keys = webpush.generateVAPIDKeys();
  await addRow('vapid', 'signing keys', keys);
  return keys;
}

export default async function handler(req, res) {
  const action = req.query.action;

  if (!process.env.NOTION_TOKEN || !process.env.APP_PASSCODE) {
    return res.status(500).json({ error: 'server is missing NOTION_TOKEN or APP_PASSCODE' });
  }

  const supplied = String(req.headers['x-passcode'] || req.query.k || '').trim();
  if (supplied !== String(process.env.APP_PASSCODE).trim()) {
    return res.status(401).json({ error: 'wrong passcode' });
  }

  try {
    if (action === 'key') {
      const keys = await vapid();
      return res.status(200).json({ publicKey: keys.publicKey });
    }

    if (action === 'subscribe') {
      const sub = (req.body || {}).subscription;
      if (!sub || !sub.endpoint) return res.status(400).json({ error: 'no subscription' });

      const existing = await rows('device');
      const already = existing.find(r => r.data.endpoint === sub.endpoint);
      if (!already) await addRow('device', 'phone ' + new Date().toISOString().slice(0, 10), sub);
      return res.status(200).json({ ok: true, devices: existing.length + (already ? 0 : 1) });
    }

    if (action === 'send') {
      if (await quietHoursActive()) {
        return res.status(200).json({ sent: 0, dropped: 0, skipped: 'quiet hours' });
      }

      const body = req.body || {};
      const keys = await vapid();
      webpush.setVapidDetails(SUBJECT, keys.publicKey, keys.privateKey);

      const devices = await rows('device');
      const payload = JSON.stringify({
        title: body.title || 'The Brief',
        body: body.body || '',
        url: body.url || '/'
      });

      let sent = 0, dropped = 0;
      for (const d of devices) {
        try {
          await webpush.sendNotification(d.data, payload);
          sent++;
        } catch (e) {
          // a phone that has uninstalled the app returns 404 or 410 forever,
          // so retire it rather than retrying every time
          if (e.statusCode === 404 || e.statusCode === 410) {
            await notion('pages/' + d.id, 'PATCH', { archived: true });
            dropped++;
          } else {
            console.error('push failed', e.statusCode, e.body);
          }
        }
      }
      return res.status(200).json({ sent, dropped });
    }

    return res.status(400).json({ error: 'unknown action' });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: String(e.message || e) });
  }
}
