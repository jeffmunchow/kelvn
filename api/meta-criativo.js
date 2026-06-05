/**
 * /api/meta-criativo  (Nível 2)
 *
 * GET ?ad_id=xxx
 *
 * Retorna URL do thumbnail do criativo de um anúncio.
 * Valida posse do anúncio antes de qualquer busca.
 */

const { createClient } = require('@supabase/supabase-js');

const META_VERSION = 'v19.0';

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

  const { ad_id } = req.query;
  if (!ad_id) return res.status(400).json({ error: 'ad_id obrigatório' });

  // 2) Busca conexão
  const { data: conn } = await supabase
    .from('meta_conexoes')
    .select('access_token, ad_account_id')
    .eq('user_id', user.id)
    .maybeSingle();

  if (!conn) return res.status(403).json({ error: 'Conta Meta não conectada' });

  try {
    // 3) Valida posse do anúncio
    const adResp = await fetch(
      `https://graph.facebook.com/${META_VERSION}/${ad_id}?` +
      new URLSearchParams({
        fields:       'id,account_id,creative{thumbnail_url,image_url}',
        access_token: conn.access_token,
      })
    );
    const adData = await adResp.json();

    const adAccountId = adData.account_id ? `act_${adData.account_id}` : null;
    if (!adAccountId || adAccountId !== conn.ad_account_id) {
      return res.status(403).json({ error: 'Acesso negado a este anúncio' });
    }

    const thumbnailUrl = adData.creative?.thumbnail_url || adData.creative?.image_url || null;

    return res.status(200).json({ ad_id, thumbnail_url: thumbnailUrl });

  } catch (err) {
    console.error('meta-criativo error:', err.message);
    return res.status(500).json({ error: 'Erro ao buscar criativo' });
  }
};
