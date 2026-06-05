/**
 * /api/meta-oauth-iniciar
 *
 * GET — inicia o fluxo OAuth com o Meta.
 * Requer JWT Supabase no header Authorization.
 * Gera um state anti-CSRF, salva no Supabase e redireciona para o Meta.
 */

const { createClient } = require('@supabase/supabase-js');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://app.kelvn.com.br');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  // 1) Valida JWT
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const token = auth.slice(7);

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
  );

  const { data: { user }, error: authError } = await supabase.auth.getUser(token);
  if (authError || !user) {
    return res.status(401).json({ error: 'Token inválido ou expirado' });
  }

  // 2) Gera state anti-CSRF e salva no Supabase (tabela temporária via dados_usuario)
  const state = require('crypto').randomUUID();
  const expira = new Date(Date.now() + 10 * 60 * 1000).toISOString(); // 10 min

  const { error: stateErr } = await supabase
    .from('dados_usuario')
    .upsert({
      user_id: user.id,
      modulo: 'meta_oauth',
      chave: 'state',
      valor: { state, expira },
    }, { onConflict: 'user_id,modulo,chave' });

  if (stateErr) {
    console.error('meta-oauth-iniciar state error:', stateErr.message);
    return res.status(500).json({ error: 'Erro ao iniciar autenticação' });
  }

  // 3) Monta URL de autorização do Meta
  const params = new URLSearchParams({
    client_id:     process.env.META_APP_ID,
    redirect_uri:  process.env.META_REDIRECT_URI,
    scope:         'ads_read,business_management',
    response_type: 'code',
    state,
  });

  const authUrl = `https://www.facebook.com/v19.0/dialog/oauth?${params.toString()}`;
  return res.redirect(302, authUrl);
};
