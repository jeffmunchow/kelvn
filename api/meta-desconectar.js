/**
 * /api/meta-desconectar
 *
 * POST — revoga o token do Meta e apaga todos os dados do fotógrafo.
 */

const { createClient } = require('@supabase/supabase-js');

const META_VERSION = 'v19.0';

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://app.kelvn.com.br');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

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

  // 2) Busca conexão
  const { data: conn } = await supabase
    .from('meta_conexoes')
    .select('access_token')
    .eq('user_id', user.id)
    .maybeSingle();

  if (!conn) return res.status(200).json({ ok: true }); // já desconectado

  // 3) Revoga token no Meta (best effort — não falha se der erro)
  try {
    await fetch(
      `https://graph.facebook.com/${META_VERSION}/me/permissions?` +
      new URLSearchParams({ access_token: conn.access_token }),
      { method: 'DELETE' }
    );
  } catch (err) {
    console.error('meta-desconectar revoke error (non-fatal):', err.message);
  }

  // 4) Remove dados do Supabase
  const [connDel, cacheDel] = await Promise.all([
    supabase.from('meta_conexoes').delete().eq('user_id', user.id),
    supabase.from('meta_metricas_cache').delete().eq('user_id', user.id),
  ]);

  if (connDel.error) {
    console.error('meta-desconectar conn delete error:', connDel.error.message);
    return res.status(500).json({ error: 'Erro ao desconectar' });
  }

  return res.status(200).json({ ok: true });
};
