-- ── Fix 1: coluna rodada + RPC corrigida ──────────────────────────────────────
-- Rodar no Supabase → SQL Editor se você já rodou album_revisao.sql antes

-- Adiciona coluna rodada (se não existir)
alter table album_comentarios
  add column if not exists rodada integer default 1;

-- Recria a RPC com nomes de coluna corretos
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
  if not exists (
    select 1 from albuns
    where id = p_album_id and revisao_ativa = true
      and (revisao_expira_em is null or revisao_expira_em > now())
  ) then
    raise exception 'Revisão não encontrada ou expirada';
  end if;

  insert into album_comentarios(album_id, spread_id, nome, email, conteudo, spread_num, rodada)
  select p_album_id, p_spread_id, p_nome, p_email, p_conteudo, p_spread_num, coalesce(a.revisao_rodada, 1)
  from albuns a where a.id = p_album_id;
end;
$$;

grant execute on function album_comentario_registrar(uuid, uuid, text, text, text, integer) to anon;
