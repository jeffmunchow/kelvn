/**
 * /api/meta-sync
 *
 * GET — sincroniza métricas de todos os fotógrafos com conexão ativa.
 * Protegido por CRON_SECRET no header X-Cron-Secret.
 * Chamado pelo cron do Vercel a cada hora.
 */

const { createClient } = require('@supabase/supabase-js');

const META_VERSION = 'v19.0';
const PERIODOS = ['last_7d', 'last_30d'];
const FIELDS = 'campaign_name,status,spend,reach,impressions,actions,ctr';

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  // 1) Valida CRON_SECRET
  const secret = req.headers['x-cron-secret'];
  if (!secret || secret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
  );

  // 2) Busca todas as conexões ativas
  const { data: conexoes, error: connErr } = await supabase
    .from('meta_conexoes')
    .select('user_id, access_token, token_expira_em, ad_account_id');

  if (connErr) {
    console.error('meta-sync conexoes error:', connErr.message);
    return res.status(500).json({ error: 'Erro ao buscar conexões' });
  }

  if (!conexoes?.length) {
    return res.status(200).json({ ok: true, sincronizados: 0 });
  }

  const agora = new Date();
  const seteDias = new Date(agora.getTime() + 7 * 24 * 60 * 60 * 1000);
  let sincronizados = 0;
  let erros = 0;

  for (const conn of conexoes) {
    try {
      let token = conn.access_token;

      // 3) Renova token se expira em menos de 7 dias
      if (conn.token_expira_em && new Date(conn.token_expira_em) < seteDias) {
        const renovado = await _renovarToken(token);
        if (renovado) {
          token = renovado.access_token;
          await supabase
            .from('meta_conexoes')
            .update({
              access_token:    token,
              token_expira_em: renovado.expiraEm,
              atualizado_em:   agora.toISOString(),
            })
            .eq('user_id', conn.user_id);
        }
      }

      // 4) Sincroniza cada período
      for (const periodo of PERIODOS) {
        const insights = await _buscarInsights(token, conn.ad_account_id, periodo);
        if (!insights) continue;

        // Salva/atualiza cache no nível 'conta' (resumo geral)
        await supabase
          .from('meta_metricas_cache')
          .upsert({
            user_id:        conn.user_id,
            periodo,
            nivel:          'conta',
            referencia_id:  null,
            dados:          insights,
            sincronizado_em: agora.toISOString(),
          }, { onConflict: 'user_id,periodo,nivel,referencia_id' });

        // Salva cache por campanha (nível 'campanha')
        for (const camp of (insights.campaigns || [])) {
          await supabase
            .from('meta_metricas_cache')
            .upsert({
              user_id:        conn.user_id,
              periodo,
              nivel:          'campanha',
              referencia_id:  camp.campaign_id,
              dados:          camp,
              sincronizado_em: agora.toISOString(),
            }, { onConflict: 'user_id,periodo,nivel,referencia_id' });
        }
      }

      sincronizados++;
    } catch (err) {
      console.error(`meta-sync user ${conn.user_id} error:`, err.message);
      erros++;
    }
  }

  return res.status(200).json({ ok: true, sincronizados, erros });
};

async function _buscarInsights(token, adAccountId, periodo) {
  try {
    // Resumo da conta
    const resumoResp = await fetch(
      `https://graph.facebook.com/${META_VERSION}/${adAccountId}/insights?` +
      new URLSearchParams({
        date_preset: periodo,
        fields:      'spend,reach,impressions,actions,ctr',
        access_token: token,
      })
    );
    const resumoData = await resumoResp.json();
    const resumo = resumoData.data?.[0] || {};

    // CPL = custo por lead (action type = lead)
    const leads = (resumo.actions || []).find(a => a.action_type === 'lead');
    const cpl = leads && resumo.spend
      ? (parseFloat(resumo.spend) / parseInt(leads.value, 10)).toFixed(2)
      : null;

    // Campanhas
    const campResp = await fetch(
      `https://graph.facebook.com/${META_VERSION}/${adAccountId}/campaigns?` +
      new URLSearchParams({
        fields:      'id,name,status,insights.date_preset(' + periodo + '){spend,reach,impressions,actions,ctr}',
        access_token: token,
      })
    );
    const campData = await campResp.json();
    const campaigns = (campData.data || []).map(c => {
      const ins = c.insights?.data?.[0] || {};
      const campLeads = (ins.actions || []).find(a => a.action_type === 'lead');
      const campCpl = campLeads && ins.spend
        ? (parseFloat(ins.spend) / parseInt(campLeads.value, 10)).toFixed(2)
        : null;
      return {
        campaign_id:   c.id,
        campaign_name: c.name,
        status:        c.status,
        spend:         ins.spend || '0',
        reach:         ins.reach || '0',
        impressions:   ins.impressions || '0',
        ctr:           ins.ctr || '0',
        cpl:           campCpl,
      };
    });

    const ativas = campaigns.filter(c => c.status === 'ACTIVE').length;

    return {
      spend:            resumo.spend || '0',
      reach:            resumo.reach || '0',
      impressions:      resumo.impressions || '0',
      cpl,
      campanhas_ativas: ativas,
      campaigns,
    };
  } catch (err) {
    console.error('_buscarInsights error:', err.message);
    return null;
  }
}

async function _renovarToken(token) {
  try {
    const resp = await fetch(
      `https://graph.facebook.com/${META_VERSION}/oauth/access_token?` +
      new URLSearchParams({
        grant_type:        'fb_exchange_token',
        client_id:         process.env.META_APP_ID,
        client_secret:     process.env.META_APP_SECRET,
        fb_exchange_token: token,
      })
    );
    const data = await resp.json();
    if (!data.access_token) return null;
    return {
      access_token: data.access_token,
      expiraEm: data.expires_in
        ? new Date(Date.now() + data.expires_in * 1000).toISOString()
        : null,
    };
  } catch {
    return null;
  }
}
