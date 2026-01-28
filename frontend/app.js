// Ajuste para o seu backend Render
const API_BASE = "https://chamados-ti-rpfp.onrender.com"; // ex.: https://helpdesk-api.onrender.com

let TOKEN = null;
let ME = null;

function setToken(t){ TOKEN = t; localStorage.setItem('token', t || ''); }
function getToken(){ return TOKEN || localStorage.getItem('token') || null; }
function authHeaders(){ return { 'Content-Type':'application/json', 'Authorization': 'Bearer ' + getToken() }; }

function show(el){ el.classList.remove('hidden'); el.style.display=''; }
function hide(el){ el.classList.add('hidden'); el.style.display='none'; }

async function api(path, opts={}){
  const res = await fetch(API_BASE + path, opts);
  if(res.status===401){ doLogout(); throw new Error('401'); }
  const data = await res.json().catch(()=>({}));
  if(!res.ok) throw new Error(data.error||('Erro '+res.status));
  return data;
}

async function doLogin(email, password){
  const res = await fetch(API_BASE + '/api/login', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ email, password })
  });
  const data = await res.json();
  if(res.ok){ setToken(data.token); await loadMe(); await loadTickets(); switchToApp(); }
  else alert(data.error||'Falha no login');
}

async function doRegister(name, email, password){
  const res = await fetch(API_BASE + '/api/register', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ name, email, password })
  });
  const data = await res.json();
  if(res.ok){ alert('Conta criada! Faça login.'); toggleRegister(false); }
  else alert(data.error||'Falha no registro');
}

async function loadMe(){
  ME = await api('/api/me', { headers: authHeaders() });
  document.getElementById('meName').textContent = ME.name;
  document.getElementById('meRole').textContent = ME.role;
}

async function loadTickets(){
  const list = await api('/api/tickets', { headers: authHeaders() });
  const tbody = document.querySelector('#ticketsTable tbody');
  tbody.innerHTML = '';
  for(const t of list){
    const tr = document.createElement('tr');
    const due = t.due_at ? new Date(t.due_at) : null;
    const overdue = due && (new Date() > new Date(due));
    tr.innerHTML = `
      <td>${t.id}</td>
      <td>${t.title}</td>
      <td><span class="badge ${t.status==='open'?'':'"'}">${t.status}</span></td>
      <td>${t.priority}</td>
      <td>${t.requester||'-'}</td>
      <td>${t.assignee||'-'}</td>
      <td><span class="badge ${overdue?'danger':''}">${due? due.toLocaleString() : '-'}</span></td>
      <td><button data-id="${t.id}" class="viewBtn">Ver</button></td>
    `;
    tbody.appendChild(tr);
  }
  document.querySelectorAll('.viewBtn').forEach(btn => btn.addEventListener('click', () => openTicket(btn.dataset.id)));
}

async function openTicket(id){
  const t = await api('/api/tickets/' + id, { headers: authHeaders() });
  const card = document.getElementById('ticketDetail');
  const due = t.due_at ? new Date(t.due_at).toLocaleString() : '-';

  let controls = '';
  if (ME.role === 'agent' || ME.role === 'admin') {
    controls = `
      <div style="display:flex;gap:8px;align-items:center;margin-top:8px">
        <label>Status
          <select id="statusSel">
            <option ${t.status==='open'?'selected':''} value="open">open</option>
            <option ${t.status==='in_progress'?'selected':''} value="in_progress">in_progress</option>
            <option ${t.status==='resolved'?'selected':''} value="resolved">resolved</option>
            <option ${t.status==='closed'?'selected':''} value="closed">closed</option>
          </select>
        </label>
        <input id="assigneeId" type="number" placeholder="ID do responsável" value="${t.assignee_id||''}"/>
        <button id="saveTicketBtn">Salvar</button>
      </div>`;
  }

  card.innerHTML = `
    <h3>#${t.id} - ${t.title}</h3>
    <p><b>Prioridade:</b> ${t.priority} | <b>Status:</b> ${t.status} | <b>Vence em:</b> ${due}</p>
    <pre style="white-space:pre-wrap">${t.content}</pre>
    ${controls}

    <h4 style="margin-top:12px">Comentários</h4>
    <div id="comments"></div>
    <div style="display:flex;gap:8px;margin-top:8px">
      <input id="commentInput" placeholder="Adicionar comentário" />
      <button id="addCommentBtn">Enviar</button>
    </div>
  `;
  show(card);

  if (document.getElementById('saveTicketBtn')) {
    document.getElementById('saveTicketBtn').onclick = async () => {
      const status = document.getElementById('statusSel').value;
      const assignee_id = document.getElementById('assigneeId').value||null;
      await api('/api/tickets/' + id, { method:'PATCH', headers: authHeaders(), body: JSON.stringify({ status, assignee_id: assignee_id? Number(assignee_id): null }) });
      await openTicket(id);
      await loadTickets();
    };
  }

  document.getElementById('addCommentBtn').onclick = async () => {
    const content = document.getElementById('commentInput').value.trim();
    if(!content) return;
    await api('/api/tickets/' + id + '/comments', { method:'POST', headers: authHeaders(), body: JSON.stringify({ content }) });
    document.getElementById('commentInput').value = '';
    await loadComments(id);
  };
  await loadComments(id);
}

async function loadComments(id){
  const list = await api('/api/tickets/' + id + '/comments', { headers: authHeaders() });
  const box = document.getElementById('comments');
  box.innerHTML = '';
  for(const c of list){
    const div = document.createElement('div');
    div.className = 'card';
    const when = new Date(c.created_at).toLocaleString();
    div.innerHTML = `<b>${c.author||'Usuário'}</b> <span class="muted">${when}</span><br/>${c.content}`;
    box.appendChild(div);
  }
}

function switchToApp(){ hide(document.getElementById('auth')); show(document.getElementById('app')); }
function switchToAuth(){ show(document.getElementById('auth')); hide(document.getElementById('app')); }

function toggleRegister(showReg){
  const reg = document.getElementById('registerCard');
  if(showReg){ show(reg); } else { hide(reg); }
}

function doLogout(){ setToken(''); switchToAuth(); }

document.getElementById('showRegister').onclick = () => toggleRegister(true);

document.getElementById('showLogin').onclick = () => toggleRegister(false);

document.getElementById('loginForm').onsubmit = async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  await doLogin(fd.get('email'), fd.get('password'));
};

document.getElementById('registerForm').onsubmit = async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  await doRegister(fd.get('name'), fd.get('email'), fd.get('password'));
};

document.getElementById('newTicketForm').onsubmit = async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  await api('/api/tickets', { method:'POST', headers: authHeaders(), body: JSON.stringify({
    title: fd.get('title'), content: fd.get('content'), priority: fd.get('priority')
  }) });
  e.target.reset();
  await loadTickets();
};

document.getElementById('logoutBtn').onclick = () => doLogout();

// Auto-login se token existir
(async function init(){
  const t = getToken();
  if(t){ try { await loadMe(); await loadTickets(); switchToApp(); } catch { setToken(''); } }
})();
