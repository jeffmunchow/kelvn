/**
 * /api/meta-dados
 *
 * GET ?periodo=last_7d|last_30d&nivel=conta|campanha
 *
 * Retorna dados cacheados do Meta para o fotógrafo autenticado.
 * Se o cache tiver mais de 2 horas, inclui desatualizado=true.
 */

const { createClient } = require('@supabase/supabase-js');

const CACHE_TTL_MS = 2 * 60 * 60 * 1000; // 2 horas

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

  const periodo = req.query.periodo || 'last_7d';
  const nivel   = req.query.nivel   || 'conta';

  // 2) Busca conexão do usuário
  const { data: conn } = await supabase
    .from('meta_conexoes')
    .select('ad_account_id, conta_nome, token_expira_em')
    .eq('user_id', user.id)
    .maybeSingle();

  if (!conn) {
    return res.status(200).json({ conectado: false });
  }

  // 3) Busca cache
  const { data: cache, error: cacheErr } = await supabase
    .from('meta_metricas_cache')
    .select('dados, sincronizado_em')
    .eq('user_id', user.id)
    .eq('periodo', periodo)
    .eq('nivel', nivel)
    .is('referencia_id', null)
    .maybeSingle();

  if (cacheErr) {
    console.error('meta-dados cache error:', cacheErr.message);
    return res.status(500).json({ error: 'Erro ao buscar dados' });
  }

  const desatualizado = cache
    ? (Date.now() - new Date(cache.sincronizado_em).getTime()) > CACHE_TTL_MS
    : true;

  return res.status(200).json({
    conectado:    true,
    conta_nome:   conn.conta_nome,
    periodo,
    desatualizado,
    dados:        cache?.dados || null,
    sincronizado_em: cache?.sincronizado_em || null,
  });
};
