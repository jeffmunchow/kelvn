-- Ideias e roadmap — lista pública de features com votação.
-- Rodar no Supabase → SQL Editor.
--
-- Regras do desenho:
--  • Os fotógrafos só veem as features que o Jeff publicou (nada de ideia bruta).
--  • O número de votos é público; QUEM votou não é. A tabela de votos só deixa cada
--    pessoa ler os próprios votos, e a contagem total sai por função (security
--    definer) que devolve apenas números.
--  • Um voto por pessoa por feature, garantido pela chave primária — não só pela tela.
--  • Publicar, editar e despublicar features é só do admin, e isso é validado no
--    banco (tabela roadmap_admins), não por esconder botão no app.
--  • As ideias que chegam dos fotógrafos continuam caindo em `feedbacks` (tipo "ideia")
--    e no e-mail do admin. Daqui para a lista pública, quem decide é o Jeff.

-- ── Quem administra o roadmap ───────────────────────────────────────────────

create table if not exists public.roadmap_admins (
  user_id uuid primary key references auth.users(id) on delete cascade
);
alter table public.roadmap_admins enable row level security;
-- Sem policies de propósito: ninguém lê nem escreve por aqui pelo app.

create or replace function public.is_roadmap_admin()
returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.roadmap_admins where user_id = auth.uid());
$$;

-- Torna o Jeff admin.
insert into public.roadmap_admins (user_id)
select id from auth.users where email = 'jeffmunchowweddings@gmail.com'
on conflict do nothing;

-- ── Features publicadas ─────────────────────────────────────────────────────

create table if not exists public.features (
  id         uuid primary key default gen_random_uuid(),
  titulo     text not null check (char_length(titulo) between 3 and 120),
  descricao  text check (descricao is null or char_length(descricao) <= 600),
  status     text not null default 'planejada'
             check (status in ('planejada', 'desenvolvimento', 'lancada')),
  criada_em  timestamptz not null default now(),
  lancada_em timestamptz
);
alter table public.features enable row level security;

drop policy if exists features_select on public.features;
create policy features_select on public.features
  for select to authenticated using (true);

drop policy if exists features_insert_admin on public.features;
create policy features_insert_admin on public.features
  for insert to authenticated with check (public.is_roadmap_admin());

drop policy if exists features_update_admin on public.features;
create policy features_update_admin on public.features
  for update to authenticated
  using (public.is_roadmap_admin()) with check (public.is_roadmap_admin());

drop policy if exists features_delete_admin on public.features;
create policy features_delete_admin on public.features
  for delete to authenticated using (public.is_roadmap_admin());

-- ── Votos (privados) ────────────────────────────────────────────────────────

create table if not exists public.feature_votos (
  feature_id uuid not null references public.features(id) on delete cascade,
  user_id    uuid not null references auth.users(id) on delete cascade,
  criado_em  timestamptz not null default now(),
  primary key (feature_id, user_id)
);
alter table public.feature_votos enable row level security;

-- Cada pessoa enxerga só o que ela mesma votou. Nem o admin lê os votos dos outros
-- pelo app; para auditar, só pelo painel do Supabase.
drop policy if exists votos_select_own on public.feature_votos;
create policy votos_select_own on public.feature_votos
  for select to authenticated using (auth.uid() = user_id);

drop policy if exists votos_insert_own on public.feature_votos;
create policy votos_insert_own on public.feature_votos
  for insert to authenticated with check (auth.uid() = user_id);

drop policy if exists votos_delete_own on public.feature_votos;
create policy votos_delete_own on public.feature_votos
  for delete to authenticated using (auth.uid() = user_id);

-- ── Lista pública com a contagem ────────────────────────────────────────────
-- security definer: conta TODOS os votos mesmo que a RLS só deixe ler os próprios,
-- e devolve só números e um "eu votei?" — nunca quem votou.

create or replace function public.roadmap_listar()
returns table (
  id uuid, titulo text, descricao text, status text,
  votos bigint, votei boolean, lancada_em timestamptz
)
language sql stable security definer set search_path = public as $$
  select f.id, f.titulo, f.descricao, f.status,
         coalesce(v.total, 0)  as votos,
         coalesce(v.meu, false) as votei,
         f.lancada_em
  from public.features f
  left join lateral (
    select count(*) as total, bool_or(fv.user_id = auth.uid()) as meu
    from public.feature_votos fv
    where fv.feature_id = f.id
  ) v on true
  where auth.uid() is not null
  order by (f.status = 'lancada'), coalesce(v.total, 0) desc, f.criada_em asc;
$$;

-- ── Votar / tirar o voto (alterna) ──────────────────────────────────────────

create or replace function public.roadmap_votar(p_feature uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_uid   uuid := auth.uid();
  v_total bigint;
  v_votei boolean;
begin
  if v_uid is null then
    raise exception 'não autenticado';
  end if;

  -- Feature lançada não recebe mais voto (já foi entregue).
  if not exists (select 1 from public.features where id = p_feature and status <> 'lancada') then
    raise exception 'feature indisponível para voto';
  end if;

  if exists (select 1 from public.feature_votos where feature_id = p_feature and user_id = v_uid) then
    delete from public.feature_votos where feature_id = p_feature and user_id = v_uid;
    v_votei := false;
  else
    insert into public.feature_votos (feature_id, user_id) values (p_feature, v_uid)
    on conflict do nothing;
    v_votei := true;
  end if;

  select count(*) into v_total from public.feature_votos where feature_id = p_feature;
  return jsonb_build_object('votos', v_total, 'votei', v_votei);
end;
$$;

-- Só quem está logado executa. (Por padrão o Postgres libera funções para todos.)
revoke all on function public.is_roadmap_admin()        from public, anon;
revoke all on function public.roadmap_listar()          from public, anon;
revoke all on function public.roadmap_votar(uuid)       from public, anon;
grant execute on function public.is_roadmap_admin()     to authenticated;
grant execute on function public.roadmap_listar()       to authenticated;
grant execute on function public.roadmap_votar(uuid)    to authenticated;

-- ── Exemplo para publicar uma feature (rodar quando quiser) ─────────────────
-- insert into public.features (titulo, descricao) values
--   ('Assistente que cria e conclui coisas por você',
--    'Em vez de só responder, a assistente cria clientes, tarefas e mais, com a sua confirmação.');
--
-- Para mudar o status:
--   update public.features set status = 'desenvolvimento' where titulo like 'Assistente%';
--   update public.features set status = 'lancada', lancada_em = now() where titulo like 'Assistente%';
