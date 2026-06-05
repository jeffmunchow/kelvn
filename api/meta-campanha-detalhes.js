/**
 * /api/meta-campanha-detalhes  (Nível 2)
 *
 * GET ?campanha_id=xxx&periodo=last_7d|last_30d|custom&data_inicio=YYYY-MM-DD&data_fim=YYYY-MM-DD
 *
 * Retorna métricas detalhadas de uma campanha (ad sets + ads).
 * Valida que a campanha pertence ao ad_account do usuário autenticado.
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

  const { campanha_id, periodo = 'last_7d', data_inicio, data_fim } = req.query;
  if (!campanha_id) return res.status(400).json({ error: 'campanha_id obrigatório' });

  // 2) Busca conexão do usuário (necessário para validar posse)
  const { data: conn } = await supabase
    .from('meta_conexoes')
    .select('access_token, ad_account_id')
    .eq('user_id', user.id)
    .maybeSingle();

  if (!conn) return res.status(403).json({ error: 'Conta Meta não conectada' });

  try {
    // 3) Valida que a campanha pertence ao ad_account do usuário
    const validParams = new URLSearchParams({
      fields:       'id,account_id',
      access_token: conn.access_token,
    });
    const validResp = await fetch(
      `https://graph.facebook.com/${META_VERSION}/${campanha_id}?${validParams}`
    );
    const validData = await validResp.json();

    // account_id da campanha vem como número — comparar sem "act_"
    const campAccountId = validData.account_id ? `act_${validData.account_id}` : null;
    if (!campAccountId || campAccountId !== conn.ad_account_id) {
      return res.status(403).json({ error: 'Acesso negado a esta campanha' });
    }

    // 4) Monta parâmetros de período
    const insightParams = { fields: 'adset_id,adset_name,spend,reach,impressions,actions,ctr', access_token: conn.access_token };
    if (periodo === 'custom' && data_inicio && data_fim) {
      insightParams.time_range = JSON.stringify({ since: data_inicio, until: data_fim });
    } else {
      insightParams.date_preset = periodo;
    }

    // 5) Busca ad sets da campanha
    const adsetsResp = await fetch(
      `https://graph.facebook.com/${META_VERSION}/${campanha_id}/adsets?` +
      new URLSearchParams({
        fields: `id,name,status,insights.date_preset(${periodo === 'custom' ? 'last_7d' : periodo}){spend,reach,impressions,actions,ctr}`,
        access_token: conn.access_token,
      })
    );
    const adsetsData = await adsetsResp.json();

    const adsets = (adsetsData.data || []).map(as => {
      const ins = as.insights?.data?.[0] || {};
      return {
        adset_id:   as.id,
        adset_name: as.name,
        status:     as.status,
        spend:      ins.spend || '0',
        reach:      ins.reach || '0',
        impressions: ins.impressions || '0',
        ctr:        ins.ctr || '0',
      };
    });

    // 6) Salva no cache
    await supabase
      .from('meta_metricas_cache')
      .upsert({
        user_id:        user.id,
        periodo:        periodo === 'custom' ? `custom_${data_inicio}_${data_fim}` : periodo,
        nivel:          'campanha',
        referencia_id:  campanha_id,
        dados:          { adsets },
        sincronizado_em: new Date().toISOString(),
      }, { onConflict: 'user_id,periodo,nivel,referencia_id' });

    return res.status(200).json({ campanha_id, adsets });

  } catch (err) {
    console.error('meta-campanha-detalhes error:', err.message);
    return res.status(500).json({ error: 'Erro ao buscar detalhes da campanha' });
  }
};
