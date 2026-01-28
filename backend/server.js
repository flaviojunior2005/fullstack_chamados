require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const fs = require('fs');
const path = require('path');
const cron = require('node-cron');
let fetch;
try { fetch = require('node-fetch'); } catch (e) { fetch = global.fetch; }

const app = express();
app.use(express.json());
app.use(helmet());

const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || '*';
app.use(cors({ origin: FRONTEND_ORIGIN, methods: ['GET','POST','PATCH','OPTIONS'], allowedHeaders: ['Content-Type','Authorization'] }));

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';

async function applySchema() {
  const schemaPath = path.join(__dirname, 'schema.sql');
  const sql = fs.readFileSync(schemaPath, 'utf8');
  await pool.query(sql);
}

function computeDueAt(priority) {
  const now = Date.now();
  const ms = priority === 'P1' ? 30*60*1000 : priority === 'P2' ? 60*60*1000 : 8*60*60*1000;
  return new Date(now + ms);
}

function auth(requiredRole) {
  return (req, res, next) => {
    const hdr = req.headers.authorization || '';
    const token = hdr.startsWith('Bearer ') ? hdr.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'Unauthenticated' });
    try {
      const payload = jwt.verify(token, JWT_SECRET);
      req.user = payload; // { id, email, role }
      if (requiredRole && payload.role !== requiredRole && payload.role !== 'admin') {
        return res.status(403).json({ error: 'Forbidden' });
      }
      next();
    } catch (e) {
      return res.status(401).json({ error: 'Invalid token' });
    }
  }
}

// Health
app.get('/health', (_, res) => res.send('ok'));

// Auth
app.post('/api/register', async (req, res) => {
  try {
    const { email, name, password } = req.body;
    if (!email || !name || !password || password.length < 6) {
      return res.status(400).json({ error: 'Dados inválidos' });
    }
    const hash = await bcrypt.hash(password, 10);
    const q = await pool.query(
      'insert into users(email, name, password_hash) values($1,$2,$3) returning id,email,name,role',
      [email, name, hash]
    );
    res.json(q.rows[0]);
  } catch (e) {
    if (String(e.message).includes('unique')) return res.status(400).json({ error: 'E-mail já cadastrado' });
    res.status(500).json({ error: 'Erro ao registrar' });
  }
});

app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  const q = await pool.query('select * from users where email=$1', [email]);
  const u = q.rows[0];
  if (!u) return res.status(401).json({ error: 'Credenciais inválidas' });
  const ok = await bcrypt.compare(password, u.password_hash);
  if (!ok) return res.status(401).json({ error: 'Credenciais inválidas' });
  const token = jwt.sign({ id: u.id, email: u.email, role: u.role }, JWT_SECRET, { expiresIn: '8h' });
  res.json({ token, user: { id: u.id, email: u.email, name: u.name, role: u.role } });
});

app.get('/api/me', auth(), async (req, res) => {
  const q = await pool.query('select id, email, name, role from users where id=$1', [req.user.id]);
  res.json(q.rows[0]);
});

// Tickets
app.post('/api/tickets', auth(), async (req, res) => {
  try {
    const { title, content, priority = 'P3' } = req.body;
    if (!title || !content) return res.status(400).json({ error: 'Título e descrição são obrigatórios' });
    if (!['P1','P2','P3'].includes(priority)) return res.status(400).json({ error: 'Prioridade inválida' });
    const dueAt = computeDueAt(priority);
    const q = await pool.query(
      `insert into tickets(title, content, priority, requester_id, due_at)
       values ($1,$2,$3,$4,$5) returning *`,
      [title, content, priority, req.user.id, dueAt]
    );
    const t = q.rows[0];

    if (process.env.TEAMS_WEBHOOK_URL) {
      try {
        await fetch(process.env.TEAMS_WEBHOOK_URL, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            '@type': 'MessageCard', '@context': 'http://schema.org/extensions',
            summary: 'Novo chamado', themeColor: '0076D7',
            title: `Novo chamado ${t.priority}: ${t.title}`,
            text: `${t.content}\n\nSLA até: ${new Date(t.due_at).toLocaleString()}`
          })
        });
      } catch {}
    }

    res.json(t);
  } catch (e) {
    res.status(500).json({ error: 'Erro ao criar chamado' });
  }
});

app.get('/api/tickets', auth(), async (req, res) => {
  const isAgent = ['agent','admin'].includes(req.user.role);
  const params = [];
  let sql = `select t.*, u.name as requester, a.name as assignee
             from tickets t
             left join users u on u.id=t.requester_id
             left join users a on a.id=t.assignee_id`;
  if (!isAgent) {
    sql += ' where t.requester_id=$1';
    params.push(req.user.id);
  }
  sql += ' order by t.created_at desc limit 100';
  const q = await pool.query(sql, params);
  res.json(q.rows);
});

async function canViewTicket(user, ticket) {
  if (!ticket) return false;
  if (['agent','admin'].includes(user.role)) return true;
  if (ticket.requester_id === user.id) return true;
  if (ticket.assignee_id && ticket.assignee_id === user.id) return true;
  return false;
}

app.get('/api/tickets/:id', auth(), async (req, res) => {
  const q = await pool.query('select * from tickets where id=$1', [req.params.id]);
  const t = q.rows[0];
  if (!t) return res.status(404).json({ error: 'Não encontrado' });
  if (!(await canViewTicket(req.user, t))) return res.status(403).json({ error: 'Forbidden' });
  res.json(t);
});

app.patch('/api/tickets/:id', auth('agent'), async (req, res) => {
  const { status, assignee_id } = req.body;
  const allowedStatus = ['open','in_progress','resolved','closed'];
  if (status && !allowedStatus.includes(status)) return res.status(400).json({ error: 'Status inválido' });
  const q = await pool.query(
    `update tickets set
       status = coalesce($1, status),
       assignee_id = coalesce($2, assignee_id),
       updated_at = now()
     where id=$3 returning *`,
    [status || null, assignee_id || null, req.params.id]
  );
  if (!q.rows[0]) return res.status(404).json({ error: 'Não encontrado' });
  res.json(q.rows[0]);
});

// Comments
app.get('/api/tickets/:id/comments', auth(), async (req, res) => {
  const tq = await pool.query('select * from tickets where id=$1', [req.params.id]);
  const t = tq.rows[0];
  if (!t) return res.status(404).json({ error: 'Não encontrado' });
  if (!(await canViewTicket(req.user, t))) return res.status(403).json({ error: 'Forbidden' });
  const q = await pool.query(
    `select c.*, u.name as author
     from ticket_comments c left join users u on u.id=c.author_id
     where c.ticket_id=$1 order by c.created_at asc`,
     [req.params.id]
  );
  res.json(q.rows);
});

app.post('/api/tickets/:id/comments', auth(), async (req, res) => {
  const { content } = req.body;
  if (!content) return res.status(400).json({ error: 'Comentário vazio' });
  const tq = await pool.query('select * from tickets where id=$1', [req.params.id]);
  const t = tq.rows[0];
  if (!t) return res.status(404).json({ error: 'Não encontrado' });
  if (!(await canViewTicket(req.user, t))) return res.status(403).json({ error: 'Forbidden' });
  const q = await pool.query(
    `insert into ticket_comments(ticket_id, author_id, content)
     values ($1,$2,$3) returning *`,
    [req.params.id, req.user.id, content]
  );
  res.json(q.rows[0]);
});

// SLA watchdog (a cada 5 minutos)
cron.schedule('*/5 * * * *', async () => {
  try {
    const q = await pool.query(
      `select id, title, priority, due_at from tickets
       where status in ('open','in_progress') and due_at < now()`
    );
    if (q.rows.length && process.env.TEAMS_WEBHOOK_URL) {
      const lines = q.rows.map(r => `#${r.id} ${r.title} (${r.priority}) vencido às ${new Date(r.due_at).toLocaleString()}`);
      await fetch(process.env.TEAMS_WEBHOOK_URL, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          '@type':'MessageCard','@context':'http://schema.org/extensions',
          summary:'SLA vencido', themeColor:'FF0000',
          title:'Chamados com SLA vencido', text: lines.join('\n')
        })
      });
    }
  } catch (e) {
    // silencioso
  }
});

const PORT = process.env.PORT || 3000;
applySchema()
  .then(() => app.listen(PORT, () => console.log(`API online na porta ${PORT}`)))
  .catch(err => { console.error('Falha ao aplicar schema', err); process.exit(1); });
