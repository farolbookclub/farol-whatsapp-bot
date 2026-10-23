-- Schema do Faroleiro no WhatsApp. Mesmo projeto Supabase do biofarol/Telegram,
-- mas tabelas próprias (isoladas) pra não misturar com as do Telegram.
-- RLS ligado e sem policies: só service_role (o bot) acessa.

create table if not exists public.whatsapp_grupos (
  group_jid text primary key,
  nome text not null,
  topico text check (topico in ('bate_papo', 'leitura', 'avisos', 'presencial')),
  ativo boolean not null default true,
  criado_em timestamptz not null default now()
);
alter table public.whatsapp_grupos enable row level security;

-- Vincula o número de WhatsApp (jid) a uma inscrição (signups, do biofarol).
create table if not exists public.whatsapp_membros (
  jid text primary key,
  signup_id uuid references public.signups(id),
  entrou_em date,
  removido_em date,
  criado_em timestamptz not null default now()
);
alter table public.whatsapp_membros enable row level security;

-- Mensagens guardadas pro /resumo (mesma lógica do Telegram).
create table if not exists public.whatsapp_mensagens (
  id bigint generated always as identity primary key,
  group_jid text not null,
  topico text not null check (topico in ('bate_papo', 'leitura', 'avisos', 'presencial')),
  msg_id text not null,
  jid_autor text not null,
  apelido text,
  texto text,
  tem_spoiler boolean not null default false,
  criado_em timestamptz not null default now()
);
create index if not exists whatsapp_mensagens_topico_idx on public.whatsapp_mensagens (topico, criado_em);
create unique index if not exists whatsapp_mensagens_msg_idx on public.whatsapp_mensagens (group_jid, msg_id);
alter table public.whatsapp_mensagens enable row level security;

create table if not exists public.whatsapp_resumo_ultimo_acesso (
  jid text not null,
  topico text not null check (topico in ('bate_papo', 'leitura', 'avisos', 'presencial')),
  ultimo_em timestamptz not null default now(),
  primary key (jid, topico)
);
alter table public.whatsapp_resumo_ultimo_acesso enable row level security;

create table if not exists public.whatsapp_resumo_contexto (
  jid text primary key,
  topico text not null,
  mensagens text not null,
  criado_em timestamptz not null default now()
);
alter table public.whatsapp_resumo_contexto enable row level security;
