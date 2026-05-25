-- Tabela galerias
CREATE TABLE galerias (
  user_id       UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE PRIMARY KEY,
  data          JSONB NOT NULL DEFAULT '[]'::jsonb,
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- RLS
ALTER TABLE galerias ENABLE ROW LEVEL SECURITY;

CREATE POLICY "select_own" ON galerias FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "insert_own" ON galerias FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "update_own" ON galerias FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "delete_own" ON galerias FOR DELETE USING (auth.uid() = user_id);

-- Trigger atualizado_em
CREATE TRIGGER galerias_atualizado_em
BEFORE UPDATE ON galerias
FOR EACH ROW EXECUTE FUNCTION update_atualizado_em();
