-- Tabela contratos
CREATE TABLE contratos (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  cliente_id          TEXT NOT NULL,
  pacote_id           TEXT,
  html_gerado         TEXT NOT NULL,
  hash_sha256         TEXT,
  status              TEXT NOT NULL DEFAULT 'rascunho'
                        CHECK (status IN ('rascunho', 'enviado', 'assinado', 'expirado', 'cancelado')),
  token_assinatura    UUID DEFAULT gen_random_uuid(),
  token_expira_em     TIMESTAMPTZ,
  assinado_em         TIMESTAMPTZ,
  assinado_ip         TEXT,
  assinado_user_agent TEXT,
  assinado_canal      TEXT CHECK (assinado_canal IN ('email', 'whatsapp')),
  pdf_url             TEXT,
  criado_em           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  atualizado_em       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- RLS para o fotógrafo autenticado
ALTER TABLE contratos ENABLE ROW LEVEL SECURITY;

CREATE POLICY "select_own"  ON contratos FOR SELECT  USING (auth.uid() = user_id);
CREATE POLICY "insert_own"  ON contratos FOR INSERT  WITH CHECK (auth.uid() = user_id);
CREATE POLICY "update_own"  ON contratos FOR UPDATE  USING (auth.uid() = user_id);
CREATE POLICY "delete_own"  ON contratos FOR DELETE  USING (auth.uid() = user_id);

-- RLS para a página pública de assinatura (anon)
CREATE POLICY "select_by_token" ON contratos FOR SELECT TO anon
  USING (status IN ('enviado', 'assinado', 'expirado'));

CREATE POLICY "sign_by_token" ON contratos FOR UPDATE TO anon
  USING (status = 'enviado' AND (token_expira_em IS NULL OR token_expira_em > NOW()))
  WITH CHECK (status = 'assinado');

-- Trigger atualizado_em
CREATE OR REPLACE FUNCTION update_atualizado_em()
RETURNS TRIGGER AS $$
BEGIN NEW.atualizado_em = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER contratos_atualizado_em
BEFORE UPDATE ON contratos
FOR EACH ROW EXECUTE FUNCTION update_atualizado_em();
