create table if not exists users (
  id serial primary key,
  email text unique not null,
  name text not null,
  password_hash text not null,
  role text not null default 'user' -- 'user' | 'agent' | 'admin'
);

create table if not exists tickets (
  id serial primary key,
  title text not null,
  content text not null,
  status text not null default 'open' check (status in ('open','in_progress','resolved','closed')),
  priority text not null default 'P3' check (priority in ('P1','P2','P3')),
  requester_id int references users(id),
  assignee_id int references users(id),
  created_at timestamptz not null default now(),
  due_at timestamptz,
  updated_at timestamptz not null default now()
);

create table if not exists ticket_comments (
  id serial primary key,
  ticket_id int references tickets(id) on delete cascade,
  author_id int references users(id),
  content text not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_tickets_status on tickets(status);
create index if not exists idx_tickets_due on tickets(due_at);
