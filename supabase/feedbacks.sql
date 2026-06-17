-- ── Feedbacks dos fotógrafos ──────────────────────────────────────────────────
-- Rodar no Supabase → SQL Editor

create table if not exists feedbacks (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid references auth.users(id) on delete set null,
  email       text,
  tipo        text not null default 'sugestao',  -- sugestao | problema | elogio | outro
  mensagem    text not null,
  contexto    text,                              -- seção atual + versão do app
  status      text not null default 'novo',      -- novo | lido | resolvido
  criado_em   timestamptz not null default now()
);

create index if not exists feedbacks_user_idx   on feedbacks(user_id);
create index if not exists feedbacks_criado_idx on feedbacks(criado_em desc);

alter table feedbacks enable row level security;

-- Cada fotógrafo insere os próprios feedbacks
create policy "feedbacks_insert_own" on feedbacks
  for insert with check (auth.uid() = user_id);

-- Cada fotógrafo lê os próprios feedbacks
create policy "feedbacks_select_own" on feedbacks
  for select using (auth.uid() = user_id);

-- (Admin lê tudo via service key, que ignora RLS)
