-- Meta Ads — conexão OAuth do fotógrafo + cache de métricas.
--
-- Ambas as tabelas são acessadas SOMENTE pelas funções serverless
-- (api/meta-ads.js), que usam a service key e ignoram RLS. O client nunca
-- consulta essas tabelas direto — por isso RLS fica habilitada e sem nenhuma
-- policy: com a chave anon ninguém lê nada, nem o próprio dono. Isso importa
-- especialmente em meta_conexoes, que guarda o access_token do Facebook.

-- ── Conexão (uma por usuário) ────────────────────────────────────────────────

create table if not exists public.meta_conexoes (
  user_id         uuid primary key references auth.users(id) on delete cascade,
  access_token    text not null,
  token_expira_em timestamptz,
  ad_account_id   text not null,
  conta_nome      text,
  atualizado_em   timestamptz not null default now()
);

alter table public.meta_conexoes enable row level security;

-- ── Chave única de dados_usuario ─────────────────────────────────────────────

-- A tabela dados_usuario já existia, mas só com PRIMARY KEY (id). O OAuth guarda
-- o state ali com upsert onConflict user_id,modulo,chave — e o Postgres recusa
-- ON CONFLICT sem uma constraint única sobre exatamente essas colunas. Sem o
-- índice abaixo o state nunca era gravado e todo callback caía em erro de csrf.
create unique index if not exists dados_usuario_chave_unica
  on public.dados_usuario (user_id, modulo, chave);

-- ── Cache de métricas ────────────────────────────────────────────────────────

create table if not exists public.meta_metricas_cache (
  id              bigint generated always as identity primary key,
  user_id         uuid not null references auth.users(id) on delete cascade,
  periodo         text not null,          -- last_7d, last_30d, custom_<ini>_<fim>
  nivel           text not null,          -- conta | campanha
  referencia_id   text,                   -- campaign_id; null quando nivel = conta
  dados           jsonb not null,
  sincronizado_em timestamptz not null default now()
);

-- O upsert do backend usa onConflict user_id,periodo,nivel,referencia_id — e
-- referencia_id é NULL nas linhas de nível "conta". Sem NULLS NOT DISTINCT o
-- Postgres trata cada NULL como valor único e o upsert viraria insert infinito.
create unique index if not exists meta_metricas_cache_chave
  on public.meta_metricas_cache (user_id, periodo, nivel, referencia_id)
  nulls not distinct;

alter table public.meta_metricas_cache enable row level security;
