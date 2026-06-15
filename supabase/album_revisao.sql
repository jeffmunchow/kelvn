-- ── Album Revisão — migration completa ───────────────────────────────────────
-- Rodar no Supabase → SQL Editor

-- 1. Colunas de revisão na tabela albuns
alter table albuns
  add column if not exists revisao_token       uuid,
  add column if not exists revisao_ativa        boolean  default false,
  add column if not exists revisao_rodada       integer  default 0,
  add column if not exists revisao_expira_em    timestamptz,
  add column if not exists revisao_vista_em     timestamptz,  -- última vez que o fotógrafo viu os comentários
  add column if not exists aprovado             boolean  default false,
  add column if not exists aprovado_em          timestamptz,
  add column if not exists aprovado_por_nome    text,
  add column if not exists aprovado_por_email   text;

-- 2. Tabela de comentários do casal
create table if not exists album_comentarios (
  id          uuid primary key default gen_random_uuid(),
  album_id    uuid not null references albuns(id) on delete cascade,
  spread_id   uuid references album_spreads(id) on delete set null,
  nome        text not null,
  email       text,
  conteudo    text not null,
  spread_num  integer,
  criado_em   timestamptz default now()
);

-- 3. Tabela de rate-limit para comentários
create table if not exists album_comentario_attempts (
  id           uuid primary key default gen_random_uuid(),
  ip_hash      text not null,
  tentativa_em timestamptz default now()
);
create index if not exists idx_comentario_attempts_ip
  on album_comentario_attempts(ip_hash, tentativa_em);

-- 4. RPC: obtém álbum + spreads via token (anônimo, sem auth)
create or replace function album_revisao_obter(p_token uuid)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_album  albuns%rowtype;
  v_result json;
begin
  select * into v_album
  from   albuns
  where  revisao_token = p_token
    and  revisao_ativa = true
    and  (revisao_expira_em is null or revisao_expira_em > now());

  if not found then
    return null;
  end if;

  select json_build_object(
    'album', json_build_object(
      'id',              v_album.id,
      'nome',            v_album.nome,
      'formato',         v_album.formato,
      'revisao_rodada',  v_album.revisao_rodada,
      'aprovado',        v_album.aprovado
    ),
    'spreads', (
      select coalesce(json_agg(
        json_build_object(
          'id',          s.id,
          'posicao',     s.posicao,
          'tipo',        s.tipo,
          'template_id', s.template_id,
          'margem_px',   s.margem_px,
          'gutter_px',   s.gutter_px,
          'preview_key', s.preview_key,
          'slots', (
            select coalesce(json_agg(
              json_build_object(
                'id',          sl.id,
                'posicao',     sl.posicao,
                'foto_key',    sl.foto_key,
                'foto_x',      sl.foto_x,
                'foto_y',      sl.foto_y,
                'foto_escala', sl.foto_escala,
                'geom',        sl.geom
              ) order by sl.posicao
            ), '[]'::json)
            from album_slots sl
            where sl.spread_id = s.id
          )
        ) order by s.posicao
      ), '[]'::json)
      from album_spreads s
      where s.album_id = v_album.id
    )
  ) into v_result;

  return v_result;
end;
$$;

-- Permite chamada anônima (casal sem login)
grant execute on function album_revisao_obter(uuid) to anon;

-- 5. RPC: registrar comentário (anônimo, SECURITY DEFINER)
create or replace function album_comentario_registrar(
  p_album_id   uuid,
  p_spread_id  uuid,
  p_nome       text,
  p_email      text,
  p_conteudo   text,
  p_spread_num integer
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Valida que o álbum tem revisão ativa
  if not exists (
    select 1 from albuns
    where id = p_album_id and revisao_ativa = true
      and (revisao_expira_em is null or revisao_expira_em > now())
  ) then
    raise exception 'Revisão não encontrada ou expirada';
  end if;

  insert into album_comentarios(album_id, spread_id, autor_nome, autor_email, conteudo, spread_num)
  values (p_album_id, p_spread_id, p_nome, p_email, p_conteudo, p_spread_num);
end;
$$;

grant execute on function album_comentario_registrar(uuid, uuid, text, text, text, integer) to anon;

-- 6. RPC: registrar aprovação (anônimo, SECURITY DEFINER)
create or replace function album_aprovacao_registrar(
  p_album_id uuid,
  p_nome     text,
  p_email    text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (
    select 1 from albuns
    where id = p_album_id and revisao_ativa = true
      and (revisao_expira_em is null or revisao_expira_em > now())
  ) then
    raise exception 'Revisão não encontrada ou expirada';
  end if;

  update albuns set
    aprovado            = true,
    aprovado_em         = now(),
    aprovado_por_nome   = p_nome,
    aprovado_por_email  = p_email,
    atualizado_em       = now()
  where id = p_album_id;
end;
$$;

grant execute on function album_aprovacao_registrar(uuid, text, text) to anon;
