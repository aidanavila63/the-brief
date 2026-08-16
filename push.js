const DB = {
  tasks:    'e90568360c41485ca061af857a70d99b',
  habits:   '509ae70085b34dd59ed9f837ae81dfd5',
  log:      '65a7f29ecc53480eb8277fd935b755b0',
  briefs:   'fa3fdf50ea6948bc88acb69d4593fe37',
  certs:    '31d959751d9e446da35500e9b7e5c8a6',
  settings: 'ccce8886191f44b2b85f5a4ebe6b33a3',
  info:     '81dd4d3f7a9847a1bdddc6d0d5650f77',
  today:    'c82bdcc406554a0eb6e85c2b64e30817',
  ref:      '705df48ddb7a4b5d8b6a87f2c80ad86f'
};

const bare = s => String(s || '').replace(/-/g, '');
const txt = p => {
  if (!p) return '';
  return (p.title || p.rich_text || []).map(t => t.plain_text || '').join('');
};
const sel = p => ((p || {}).select || {}).name || '';
const dat = p => ((p || {}).date || {}).start || '';

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

const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Toronto' });

async function findOrCreateLogRow(date) {
  const q = await notion(`databases/${DB.log}/query`, 'POST', {
    filter: { property: 'Name', title: { equals: date } }, page_size: 1
  });
  if (q.results.length) return q.results[0];
  return notion('pages', 'POST', {
    parent: { database_id: DB.log },
    properties: {
      Name: { title: [{ text: { content: date } }] },
      Day:  { date: { start: date } }
    }
  });
}

/* expiry is the certified date plus the validity period */
function expiryOf(certified, months) {
  if (!certified) return '';
  const d = new Date(certified + 'T12:00:00');
  d.setMonth(d.getMonth() + (Number(months) || 24));
  return d.toISOString().slice(0, 10);
}

const ACTIONS = {

  async bootstrap({ date }) {
    const day = date || today();
    const [habits, logRow, open, review, briefs] = await Promise.all([
      notion(`databases/${DB.habits}/query`, 'POST', {
        filter: { property: 'Active', checkbox: { equals: true } }
      }),
      findOrCreateLogRow(day),
      notion(`databases/${DB.tasks}/query`, 'POST', {
        filter: { property: 'Status', select: { equals: 'Open' } },
        sorts: [{ timestamp: 'created_time', direction: 'ascending' }],
        page_size: 60
      }),
      notion(`databases/${DB.tasks}/query`, 'POST', {
        filter: { property: 'Status', select: { equals: 'Needs review' } },
        sorts: [{ timestamp: 'created_time', direction: 'descending' }],
        page_size: 30
      }),
      notion(`databases/${DB.briefs}/query`, 'POST', {
        sorts: [{ property: 'Day', direction: 'descending' }], page_size: 8
      })
    ]);

    const doneIds = ((logRow.properties['Habits done'] || {}).relation || []).map(r => bare(r.id));
    const task = p => ({
      id: p.id,
      name: txt(p.properties.Name),
      project: txt(p.properties.Project),
      source: sel(p.properties.Source),
      link: (p.properties.Link || {}).url || '',
      due: dat(p.properties.Due),
      age: Math.floor((Date.now() - new Date(p.created_time)) / 86400000)
    });

    return {
      date: day,
      habits: habits.results.map(p => ({
        id: p.id, name: txt(p.properties.Name), done: doneIds.includes(bare(p.id))
      })),
      note: txt(logRow.properties.Note),
      open: open.results.map(task),
      review: review.results.map(task),
      briefs: briefs.results.map(p => ({
        id: p.id, name: txt(p.properties.Name),
        headline: txt(p.properties.Headline), url: p.url, day: dat(p.properties.Day)
      }))
    };
  },

  /* ---------- the day's assessment, written by the engine ---------- */

  async today({ date }) {
    const day = date || today();
    let r = await notion(`databases/${DB.today}/query`, 'POST', {
      filter: { property: 'Name', title: { equals: day } }, page_size: 1
    });
    if (!r.results.length) {
      r = await notion(`databases/${DB.today}/query`, 'POST', {
        sorts: [{ property: 'Day', direction: 'descending' }], page_size: 1
      });
    }
    if (!r.results.length) return { day: day, stale: true, payload: null };
    const page = r.results[0];
    const recordDay = dat(page.properties.Day);
    let payload = null;
    try { payload = JSON.parse(txt(page.properties.Payload)); } catch (e) {}
    return {
      day: recordDay,
      stale: recordDay !== day,
      headline: txt(page.properties.Headline),
      writtenAt: dat(page.properties['Written at']),
      mode: sel(page.properties.Mode),
      payload: payload
    };
  },

  /* ---------- search across everything ---------- */

  /*
   * Notion's own search reaches inside page bodies, which the database query
   * API cannot, so a scanned PDF or a paragraph of notes is findable too.
   */
  async search({ q }) {
    const query = String(q || '').trim();
    if (query.length < 2) return { results: [] };
    const r = await notion('search', 'POST', {
      query: query,
      filter: { value: 'page', property: 'object' },
      page_size: 40
    });
    const owned = {};
    Object.keys(DB).forEach(k => owned[DB[k].replace(/-/g, '')] = k);
    const label = {
      ref: 'Reference', info: 'Info', certs: 'Certification', tasks: 'Task',
      log: 'Daily log', briefs: 'Brief', today: 'Day', habits: 'Habit'
    };
    const out = [];
    r.results.forEach(p => {
      const parent = (p.parent || {}).database_id || '';
      const kind = owned[String(parent).replace(/-/g, '')];
      if (!kind) return;
      const props = p.properties || {};
      const titleKey = Object.keys(props).find(k => props[k].type === 'title');
      const name = titleKey ? txt(props[titleKey]) : '(untitled)';
      const extra = txt(props.Summary) || txt(props.Value) || txt(props.Headline)
                 || txt(props.Note) || txt(props.Notes) || '';
      out.push({
        id: p.id, kind: label[kind] || kind, name: name,
        line: extra.slice(0, 160),
        topic: sel(props.Topic) || sel(props.Category) || sel(props.Body) || '',
        url: p.url || '', edited: p.last_edited_time || ''
      });
    });
    out.sort((a, b) => {
      const rank = x => x.kind === 'Reference' ? 0 : (x.kind === 'Info' ? 1 : 2);
      return rank(a) - rank(b) || String(b.edited).localeCompare(String(a.edited));
    });
    return { results: out.slice(0, 30) };
  },

  async addRef({ name, topic, summary, source }) {
    if (!name) throw new Error('needs a name');
    const props = { Name: { title: [{ text: { content: String(name).slice(0, 120) } }] } };
    if (topic) props.Topic = { select: { name: topic } };
    if (summary) props.Summary = { rich_text: [{ text: { content: String(summary).slice(0, 1900) } }] };
    if (source) props.Source = { url: String(source).slice(0, 400) };
    const p = await notion('pages', 'POST', { parent: { database_id: DB.ref }, properties: props });
    return { id: p.id, url: p.url };
  },

  /* ---------- habit history, for the streaks grid ---------- */

  async history({ days }) {
    const n = Math.min(Number(days) || 120, 200);
    const from = new Date();
    from.setDate(from.getDate() - n);
    const fromIso = from.toISOString().slice(0, 10);
    const [log, habits] = await Promise.all([
      notion(`databases/${DB.log}/query`, 'POST', {
        filter: { property: 'Day', date: { on_or_after: fromIso } },
        sorts: [{ property: 'Day', direction: 'descending' }],
        page_size: 100
      }),
      notion(`databases/${DB.habits}/query`, 'POST', {
        filter: { property: 'Active', checkbox: { equals: true } }
      })
    ]);
    const active = habits.results.map(p => ({ id: bare(p.id), name: txt(p.properties.Name) }));
    const byDay = {};
    log.results.forEach(p => {
      const day = dat(p.properties.Day) || txt(p.properties.Name);
      if (!day) return;
      const done = ((p.properties['Habits done'] || {}).relation || []).map(r => bare(r.id));
      byDay[day] = { done: done, note: !!txt(p.properties.Note) };
    });
    return { habits: active, days: byDay, total: active.length };
  },

  /* ---------- Info tab: certifications and records ---------- */

  async info() {
    const [certs, records] = await Promise.all([
      notion(`databases/${DB.certs}/query`, 'POST', { page_size: 60 }),
      notion(`databases/${DB.info}/query`, 'POST', { page_size: 80 })
    ]);
    const now = new Date();
    const c = certs.results.map(p => {
      const certified = dat(p.properties['Certified on']);
      const months = (p.properties['Valid months'] || {}).number;
      const expires = dat(p.properties.Expires) || expiryOf(certified, months);
      const days = expires ? Math.round((new Date(expires + 'T12:00:00') - now) / 86400000) : null;
      return {
        id: p.id, name: txt(p.properties.Name), body: sel(p.properties.Body),
        certified: certified, months: months || 24, expires: expires, days: days,
        status: sel(p.properties.Status),
        required: !!(p.properties['Required for work'] || {}).checkbox,
        notes: txt(p.properties.Notes)
      };
    }).filter(x => x.status !== 'Retired')
      .sort((a, b) => {
        if (a.days === null) return 1;
        if (b.days === null) return -1;
        return a.days - b.days;
      });
    const r = records.results.map(p => ({
      id: p.id, name: txt(p.properties.Name), category: sel(p.properties.Category),
      value: txt(p.properties.Value), notes: txt(p.properties.Notes),
      pinned: !!(p.properties.Pinned || {}).checkbox
    })).sort((a, b) => (b.pinned - a.pinned) || a.name.localeCompare(b.name));
    return { certs: c, records: r };
  },

  async addCert({ name, body, certified, months }) {
    if (!name) throw new Error('needs a name');
    const m = Number(months) || 24;
    const props = {
      Name: { title: [{ text: { content: String(name).slice(0, 120) } }] },
      'Valid months': { number: m },
      Status: { select: { name: 'Current' } }
    };
    if (body) props.Body = { select: { name: body } };
    if (certified) {
      props['Certified on'] = { date: { start: certified } };
      props.Expires = { date: { start: expiryOf(certified, m) } };
    }
    const p = await notion('pages', 'POST', { parent: { database_id: DB.certs }, properties: props });
    return { id: p.id };
  },

  async setCertRequired({ id, required }) {
    await notion('pages/' + id, 'PATCH', {
      properties: { 'Required for work': { checkbox: !!required } }
    });
    return { ok: true };
  },

  async dropCert({ id }) {
    await notion('pages/' + id, 'PATCH', { archived: true });
    return { ok: true };
  },

  async addInfo({ name, category, value, notes }) {
    if (!name) throw new Error('needs a name');
    const props = { Name: { title: [{ text: { content: String(name).slice(0, 120) } }] } };
    if (category) props.Category = { select: { name: category } };
    if (value) props.Value = { rich_text: [{ text: { content: String(value).slice(0, 1900) } }] };
    if (notes) props.Notes = { rich_text: [{ text: { content: String(notes).slice(0, 1900) } }] };
    const p = await notion('pages', 'POST', { parent: { database_id: DB.info }, properties: props });
    return { id: p.id };
  },

  async pinInfo({ id, pinned }) {
    await notion('pages/' + id, 'PATCH', { properties: { Pinned: { checkbox: !!pinned } } });
    return { ok: true };
  },

  async dropInfo({ id }) {
    await notion('pages/' + id, 'PATCH', { archived: true });
    return { ok: true };
  },

  /* ---------- Settings ---------- */

  async config() {
    const r = await notion(`databases/${DB.settings}/query`, 'POST', { page_size: 40 });
    return {
      settings: r.results.map(p => ({
        id: p.id, name: txt(p.properties.Name), value: txt(p.properties.Value),
        date: dat(p.properties['Date value']),
        number: (p.properties['Number value'] || {}).number,
        about: txt(p.properties.About)
      })).sort((a, b) => a.name.localeCompare(b.name))
    };
  },

  async setSetting({ id, value, date, number }) {
    const props = {};
    if (value !== undefined) {
      props.Value = { rich_text: [{ text: { content: String(value).slice(0, 400) } }] };
    }
    if (date !== undefined) {
      props['Date value'] = date ? { date: { start: date } } : { date: null };
    }
    if (number !== undefined && number !== '' && number !== null) {
      props['Number value'] = { number: Number(number) };
    }
    if (!Object.keys(props).length) throw new Error('nothing to change');
    await notion('pages/' + id, 'PATCH', { properties: props });
    return { ok: true };
  },

  /* ---------- tasks, habits, the daily note ---------- */

  async toggleHabit({ habitId, date }) {
    const row = await findOrCreateLogRow(date || today());
    const rel = (row.properties['Habits done'] || {}).relation || [];
    const on = rel.some(r => bare(r.id) === bare(habitId));
    const next = on ? rel.filter(r => bare(r.id) !== bare(habitId)) : rel.concat([{ id: habitId }]);
    await notion('pages/' + row.id, 'PATCH', {
      properties: { 'Habits done': { relation: next } }
    });
    return { on: !on };
  },

  async addTask({ name, project }) {
    const props = {
      Name:   { title: [{ text: { content: String(name).slice(0, 190) } }] },
      Status: { select: { name: 'Open' } },
      Source: { select: { name: 'Manual' } }
    };
    if (project) props.Project = { rich_text: [{ text: { content: String(project).slice(0, 90) } }] };
    const p = await notion('pages', 'POST', { parent: { database_id: DB.tasks }, properties: props });
    return { id: p.id };
  },

  async setStatus({ id, status }) {
    if (!['Open', 'Done', 'Needs review'].includes(status)) throw new Error('bad status');
    const props = { Status: { select: { name: status } } };
    if (status === 'Done') props['Done at'] = { date: { start: new Date().toISOString() } };
    await notion('pages/' + id, 'PATCH', { properties: props });
    return { ok: true };
  },

  async dropTask({ id }) {
    await notion('pages/' + id, 'PATCH', { archived: true });
    return { ok: true };
  },

  async setNote({ date, note }) {
    const row = await findOrCreateLogRow(date || today());
    await notion('pages/' + row.id, 'PATCH', {
      properties: { Note: { rich_text: [{ text: { content: String(note).slice(0, 1900) } }] } }
    });
    return { ok: true };
  },

  async addHabit({ name }) {
    const p = await notion('pages', 'POST', {
      parent: { database_id: DB.habits },
      properties: {
        Name: { title: [{ text: { content: String(name).slice(0, 90) } }] },
        Active: { checkbox: true }
      }
    });
    return { id: p.id };
  }
};

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (!process.env.NOTION_TOKEN) {
    return res.status(500).json({ error: 'NOTION_TOKEN is not set on the server' });
  }
  if (String(req.headers['x-passcode'] || '').trim() !== String(process.env.APP_PASSCODE || '').trim()) {
    return res.status(401).json({ error: 'wrong passcode' });
  }
  const { action, ...args } = req.body || {};
  const fn = ACTIONS[action];
  if (!fn) return res.status(400).json({ error: 'unknown action: ' + action });
  try {
    res.status(200).json(await fn(args));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: String(e.message || e) });
  }
}
