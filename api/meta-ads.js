/**
 * /api/meta-ads — hub de todas as ações do módulo Meta Ads
 *
 * Actions via GET:
 *   ?action=iniciar          → inicia OAuth (redireciona para o Meta)
 *   ?action=callback         → recebe callback OAuth do Meta
 *   ?action=dados            → retorna cache de métricas
 *   ?action=sync             → sincroniza métricas (protegido por CRON_SECRET)
 *   ?action=campanha         → detalhes de uma campanha (?campanha_id=xxx)
 *   ?action=criativo         → thumbnail de um anúncio (?ad_id=xxx)
 *
 * Actions via POST:
 *   ?action=desconectar      → revoga token e apaga dados
 *
 * OAuth redirect URI: https://app.kelvn.com.br/api/meta-ads?action=callback
 */

const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

const META_VERSION = 'v19.0';
const CACHE_TTL_MS = 2 * 60 * 60 * 1000; // 2h

// ── Helpers ───────────────────────────────────────────────────────────────────

function sbService() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
}

async function validarJWT(req) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) return null;
  const supabase = sbService();
  const { data: { user }, error } = await supabase.auth.getUser(auth.slice(7));
  if (error || !user) return null;
  return user;
}

function bytes(n) {
  return n ? parseFloat(n).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '0,00';
}

// ── Handler principal ─────────────────────────────────────────────────────────

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://app.kelvn.com.br');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const action = req.query.action;

  switch (action) {
    case 'iniciar':    return acOAuthIniciar(req, res);
    case 'callback':   return acOAuthCallback(req, res);
    case 'dados':      return acDados(req, res);
    case 'sync':       return acSync(req, res);
    case 'campanha':   return acCampanha(req, res);
    case 'criativo':   return acCriativo(req, res);
    case 'desconectar': return acDesconectar(req, res);
    default:           return res.status(400).json({ error: 'action inválida' });
  }
};

// ── OAuth: iniciar ────────────────────────────────────────────────────────────

async function acOAuthIniciar(req, res) {
  if (req.method !== 'GET') return res.status(405).end();

  // Esta action é acessada via navegação de página inteira (window.location.href),
  // não via fetch — não dá para mandar um header Authorization customizado num
  // redirect de navegador. Por isso, só aqui (e só aqui), aceitamos o JWT também
  // via query string. Ele nunca é repassado ao Facebook, só usado para identificar
  // o usuário antes de montar a URL de autorização do Meta.
  const tokenQuery = typeof req.query.token === 'string' ? req.query.token : null;
  const authHeader = req.headers.authorization;
  const token = tokenQuery || (authHeader && authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null);
  if (!token) return res.status(401).json({ error: 'Unauthorized' });

  const supabase = sbService();
  const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
  if (authErr || !user) return res.status(401).json({ error: 'Unauthorized' });

  // 'popup': o front abriu esta URL numa janela popup (window.open) e espera o
  // resultado via postMessage. 'redirect' (padrão): navegação de página inteira,
  // resultado via query string (?meta=...) — usado pelo app nativo e como fallback
  // caso o navegador bloqueie o popup. O modo viaja dentro do state (Facebook o
  // devolve inalterado no callback), não como query solta — assim não dá pra falsificar.
  const modo    = req.query.modo === 'popup' ? 'popup' : 'redirect';
  const state   = crypto.randomUUID();
  const expira  = new Date(Date.now() + 10 * 60 * 1000).toISOString();

  await supabase.from('dados_usuario').upsert({
    user_id: user.id, modulo: 'meta_oauth', chave: 'state',
    valor: { state, expira, modo },
  }, { onConflict: 'user_id,modulo,chave' });

  const redirectUri = process.env.META_REDIRECT_URI ||
    'https://app.kelvn.com.br/api/meta-ads?action=callback';

  const params = new URLSearchParams({
    client_id:     process.env.META_APP_ID,
    redirect_uri:  redirectUri,
    scope:         'ads_read,business_management',
    response_type: 'code',
    state,
  });

  return res.redirect(302, `https://www.facebook.com/${META_VERSION}/dialog/oauth?${params}`);
}

// Responde ao fim do fluxo OAuth de acordo com o modo salvo no state:
// - popup: uma página HTML mínima que avisa a janela que abriu (via postMessage)
//   e se fecha sozinha.
// - redirect: o comportamento clássico, volta pra Kelvn com ?meta=... na URL.
function _oauthResponder(res, modo, result) {
  if (modo === 'popup') {
    const payload = JSON.stringify({ tipo: 'meta-ads-oauth', ...result })
      .replace(/</g, '\\u003c'); // evita que um valor vindo do Facebook feche a tag <script> antes da hora
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(200).send(
      '<!DOCTYPE html><html><head><meta charset="utf-8"><title>Kelvn</title></head><body>' +
      '<script>try{if(window.opener){window.opener.postMessage(' + payload + ',\'https://app.kelvn.com.br\');}}catch(e){}window.close();</script>' +
      'Pode fechar esta janela.</body></html>'
    );
  }
  if (result.status === 'conectado') return res.redirect(302, 'https://app.kelvn.com.br/?meta=conectado');
  if (result.status === 'escolher_conta') {
    const cp = encodeURIComponent(JSON.stringify(result.contas || []));
    return res.redirect(302, `https://app.kelvn.com.br/?meta=escolher_conta&contas=${cp}`);
  }
  return res.redirect(302, `https://app.kelvn.com.br/?meta=erro&motivo=${result.motivo || 'interno'}`);
}

// ── OAuth: callback ───────────────────────────────────────────────────────────

async function acOAuthCallback(req, res) {
  if (req.method !== 'GET') return res.status(405).end();

  const { code, state, error: metaError } = req.query;

  // Sem state não dá pra saber se veio de popup ou de redirect — cai no
  // comportamento clássico (mais compatível) por segurança.
  if (!state) return _oauthResponder(res, 'redirect', { status: 'erro', motivo: 'parametros' });

  const supabase = sbService();
  const { data: rows } = await supabase.from('dados_usuario')
    .select('user_id, valor').eq('modulo', 'meta_oauth').eq('chave', 'state');

  const row  = (rows || []).find(r => r.valor?.state === state);
  const modo = row?.valor?.modo === 'popup' ? 'popup' : 'redirect';

  if (metaError) return _oauthResponder(res, modo, { status: 'erro', motivo: 'negado' });
  if (!code) return _oauthResponder(res, modo, { status: 'erro', motivo: 'parametros' });
  if (!row) return _oauthResponder(res, modo, { status: 'erro', motivo: 'csrf' });
  if (new Date(row.valor.expira) < new Date())
    return _oauthResponder(res, modo, { status: 'erro', motivo: 'expirado' });

  const userId = row.user_id;
  await supabase.from('dados_usuario').delete()
    .eq('user_id', userId).eq('modulo', 'meta_oauth').eq('chave', 'state');

  const redirectUri = process.env.META_REDIRECT_URI ||
    'https://app.kelvn.com.br/api/meta-ads?action=callback';

  try {
    // Token de curta duração
    const tResp = await fetch(`https://graph.facebook.com/${META_VERSION}/oauth/access_token?` +
      new URLSearchParams({ client_id: process.env.META_APP_ID,
        client_secret: process.env.META_APP_SECRET, redirect_uri: redirectUri, code }));
    const tData = await tResp.json();
    if (!tData.access_token)
      return _oauthResponder(res, modo, { status: 'erro', motivo: 'token' });

    // Token de longa duração
    const lResp = await fetch(`https://graph.facebook.com/${META_VERSION}/oauth/access_token?` +
      new URLSearchParams({ grant_type: 'fb_exchange_token',
        client_id: process.env.META_APP_ID, client_secret: process.env.META_APP_SECRET,
        fb_exchange_token: tData.access_token }));
    const lData = await lResp.json();
    if (!lData.access_token)
      return _oauthResponder(res, modo, { status: 'erro', motivo: 'token_long' });

    const accessToken = lData.access_token;
    const expiraEm    = lData.expires_in
      ? new Date(Date.now() + lData.expires_in * 1000).toISOString() : null;

    // Contas de anúncio
    const actsResp = await fetch(
      `https://graph.facebook.com/${META_VERSION}/me/adaccounts?fields=id,name,account_status&access_token=${accessToken}`);
    const actsData = await actsResp.json();
    const contas   = (actsData.data || []).filter(a => a.account_status === 1);
    if (!contas.length)
      return _oauthResponder(res, modo, { status: 'erro', motivo: 'sem_conta' });

    if (contas.length > 1) {
      await supabase.from('dados_usuario').upsert({
        user_id: userId, modulo: 'meta_oauth', chave: 'token_pendente',
        valor: { accessToken, expiraEm, contas },
      }, { onConflict: 'user_id,modulo,chave' });
      return _oauthResponder(res, modo, {
        status: 'escolher_conta',
        contas: contas.map(c => ({ id: c.id, name: c.name })),
      });
    }

    await _salvarConexao(supabase, userId, accessToken, expiraEm, contas[0].id, contas[0].name);
    return _oauthResponder(res, modo, { status: 'conectado' });

  } catch (err) {
    console.error('meta callback error:', err.message);
    return _oauthResponder(res, modo, { status: 'erro', motivo: 'interno' });
  }
}

async function _salvarConexao(supabase, userId, accessToken, expiraEm, adAccountId, contaNome) {
  const { error } = await supabase.from('meta_conexoes').upsert({
    user_id: userId, access_token: accessToken, token_expira_em: expiraEm,
    ad_account_id: adAccountId, conta_nome: contaNome || null,
    atualizado_em: new Date().toISOString(),
  }, { onConflict: 'user_id' });
  if (error) throw new Error(error.message);
}

// ── Dados (cache) ─────────────────────────────────────────────────────────────

async function acDados(req, res) {
  if (req.method !== 'GET') return res.status(405).end();
  const user = await validarJWT(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  const periodo = req.query.periodo || 'last_7d';
  const supabase = sbService();

  const { data: conn } = await supabase.from('meta_conexoes')
    .select('ad_account_id, conta_nome, token_expira_em')
    .eq('user_id', user.id).maybeSingle();
  if (!conn) return res.status(200).json({ conectado: false });

  const { data: cache } = await supabase.from('meta_metricas_cache')
    .select('dados, sincronizado_em')
    .eq('user_id', user.id).eq('periodo', periodo).eq('nivel', 'conta')
    .is('referencia_id', null).maybeSingle();

  const desatualizado = cache
    ? (Date.now() - new Date(cache.sincronizado_em).getTime()) > CACHE_TTL_MS
    : true;

  return res.status(200).json({
    conectado: true, conta_nome: conn.conta_nome, periodo,
    desatualizado, dados: cache?.dados || null,
    sincronizado_em: cache?.sincronizado_em || null,
  });
}

// ── Sync (cron) ───────────────────────────────────────────────────────────────

async function acSync(req, res) {
  if (req.method !== 'GET') return res.status(405).end();
  const secret = req.headers['x-cron-secret'];
  if (!secret || secret !== process.env.CRON_SECRET)
    return res.status(401).json({ error: 'Unauthorized' });

  const supabase = sbService();
  const { data: conexoes } = await supabase.from('meta_conexoes')
    .select('user_id, access_token, token_expira_em, ad_account_id');
  if (!conexoes?.length) return res.status(200).json({ ok: true, sincronizados: 0 });

  const agora    = new Date();
  const seteDias = new Date(agora.getTime() + 7 * 24 * 60 * 60 * 1000);
  let sincronizados = 0, erros = 0;

  for (const conn of conexoes) {
    try {
      let token = conn.access_token;
      if (conn.token_expira_em && new Date(conn.token_expira_em) < seteDias) {
        const renovado = await _renovarToken(token);
        if (renovado) {
          token = renovado.access_token;
          await supabase.from('meta_conexoes').update({
            access_token: token, token_expira_em: renovado.expiraEm,
            atualizado_em: agora.toISOString(),
          }).eq('user_id', conn.user_id);
        }
      }
      for (const periodo of ['last_7d', 'last_30d']) {
        const insights = await _buscarInsights(token, conn.ad_account_id, periodo);
        if (!insights) continue;
        await supabase.from('meta_metricas_cache').upsert({
          user_id: conn.user_id, periodo, nivel: 'conta', referencia_id: null,
          dados: insights, sincronizado_em: agora.toISOString(),
        }, { onConflict: 'user_id,periodo,nivel,referencia_id' });
        for (const camp of (insights.campaigns || [])) {
          await supabase.from('meta_metricas_cache').upsert({
            user_id: conn.user_id, periodo, nivel: 'campanha',
            referencia_id: camp.campaign_id, dados: camp,
            sincronizado_em: agora.toISOString(),
          }, { onConflict: 'user_id,periodo,nivel,referencia_id' });
        }
      }
      sincronizados++;
    } catch (err) {
      console.error(`meta sync user ${conn.user_id}:`, err.message);
      erros++;
    }
  }
  return res.status(200).json({ ok: true, sincronizados, erros });
}

async function _buscarInsights(token, adAccountId, periodo) {
  try {
    const rResp = await fetch(`https://graph.facebook.com/${META_VERSION}/${adAccountId}/insights?` +
      new URLSearchParams({ date_preset: periodo,
        fields: 'spend,reach,impressions,actions,ctr', access_token: token }));
    const rData = await rResp.json();
    const r     = rData.data?.[0] || {};
    const leads = (r.actions || []).find(a => a.action_type === 'lead');
    const cpl   = leads && r.spend
      ? (parseFloat(r.spend) / parseInt(leads.value, 10)).toFixed(2) : null;

    const cResp = await fetch(`https://graph.facebook.com/${META_VERSION}/${adAccountId}/campaigns?` +
      new URLSearchParams({ fields: `id,name,status,insights.date_preset(${periodo}){spend,reach,impressions,actions,ctr}`,
        access_token: token }));
    const cData = await cResp.json();
    const campaigns = (cData.data || []).map(c => {
      const ins      = c.insights?.data?.[0] || {};
      const cLeads   = (ins.actions || []).find(a => a.action_type === 'lead');
      const campCpl  = cLeads && ins.spend
        ? (parseFloat(ins.spend) / parseInt(cLeads.value, 10)).toFixed(2) : null;
      return { campaign_id: c.id, campaign_name: c.name, status: c.status,
        spend: ins.spend || '0', reach: ins.reach || '0',
        impressions: ins.impressions || '0', ctr: ins.ctr || '0', cpl: campCpl };
    });

    return { spend: r.spend || '0', reach: r.reach || '0',
      impressions: r.impressions || '0', cpl,
      campanhas_ativas: campaigns.filter(c => c.status === 'ACTIVE').length, campaigns };
  } catch { return null; }
}

async function _renovarToken(token) {
  try {
    const resp = await fetch(`https://graph.facebook.com/${META_VERSION}/oauth/access_token?` +
      new URLSearchParams({ grant_type: 'fb_exchange_token',
        client_id: process.env.META_APP_ID, client_secret: process.env.META_APP_SECRET,
        fb_exchange_token: token }));
    const data = await resp.json();
    if (!data.access_token) return null;
    return { access_token: data.access_token,
      expiraEm: data.expires_in ? new Date(Date.now() + data.expires_in * 1000).toISOString() : null };
  } catch { return null; }
}

// ── Campanha detalhes ─────────────────────────────────────────────────────────

async function acCampanha(req, res) {
  if (req.method !== 'GET') return res.status(405).end();
  const user = await validarJWT(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  const { campanha_id, periodo = 'last_7d', data_inicio, data_fim } = req.query;
  if (!campanha_id) return res.status(400).json({ error: 'campanha_id obrigatório' });

  const supabase = sbService();
  const { data: conn } = await supabase.from('meta_conexoes')
    .select('access_token, ad_account_id').eq('user_id', user.id).maybeSingle();
  if (!conn) return res.status(403).json({ error: 'Conta Meta não conectada' });

  try {
    const vResp = await fetch(`https://graph.facebook.com/${META_VERSION}/${campanha_id}?` +
      new URLSearchParams({ fields: 'id,account_id', access_token: conn.access_token }));
    const vData = await vResp.json();
    const campAccountId = vData.account_id ? `act_${vData.account_id}` : null;
    if (!campAccountId || campAccountId !== conn.ad_account_id)
      return res.status(403).json({ error: 'Acesso negado a esta campanha' });

    const asResp = await fetch(`https://graph.facebook.com/${META_VERSION}/${campanha_id}/adsets?` +
      new URLSearchParams({ fields: `id,name,status,insights.date_preset(${periodo === 'custom' ? 'last_7d' : periodo}){spend,reach,impressions,actions,ctr}`,
        access_token: conn.access_token }));
    const asData = await asResp.json();
    const adsets = (asData.data || []).map(as => {
      const ins = as.insights?.data?.[0] || {};
      return { adset_id: as.id, adset_name: as.name, status: as.status,
        spend: ins.spend || '0', reach: ins.reach || '0',
        impressions: ins.impressions || '0', ctr: ins.ctr || '0' };
    });

    await supabase.from('meta_metricas_cache').upsert({
      user_id: user.id,
      periodo: periodo === 'custom' ? `custom_${data_inicio}_${data_fim}` : periodo,
      nivel: 'campanha', referencia_id: campanha_id,
      dados: { adsets }, sincronizado_em: new Date().toISOString(),
    }, { onConflict: 'user_id,periodo,nivel,referencia_id' });

    return res.status(200).json({ campanha_id, adsets });
  } catch (err) {
    console.error('meta campanha error:', err.message);
    return res.status(500).json({ error: 'Erro ao buscar detalhes' });
  }
}

// ── Criativo ──────────────────────────────────────────────────────────────────

async function acCriativo(req, res) {
  if (req.method !== 'GET') return res.status(405).end();
  const user = await validarJWT(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  const { ad_id } = req.query;
  if (!ad_id) return res.status(400).json({ error: 'ad_id obrigatório' });

  const supabase = sbService();
  const { data: conn } = await supabase.from('meta_conexoes')
    .select('access_token, ad_account_id').eq('user_id', user.id).maybeSingle();
  if (!conn) return res.status(403).json({ error: 'Conta Meta não conectada' });

  try {
    const adResp = await fetch(`https://graph.facebook.com/${META_VERSION}/${ad_id}?` +
      new URLSearchParams({ fields: 'id,account_id,creative{thumbnail_url,image_url}',
        access_token: conn.access_token }));
    const adData = await adResp.json();
    const adAccountId = adData.account_id ? `act_${adData.account_id}` : null;
    if (!adAccountId || adAccountId !== conn.ad_account_id)
      return res.status(403).json({ error: 'Acesso negado a este anúncio' });

    return res.status(200).json({
      ad_id,
      thumbnail_url: adData.creative?.thumbnail_url || adData.creative?.image_url || null,
    });
  } catch (err) {
    console.error('meta criativo error:', err.message);
    return res.status(500).json({ error: 'Erro ao buscar criativo' });
  }
}

// ── Desconectar ───────────────────────────────────────────────────────────────

async function acDesconectar(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  const user = await validarJWT(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  const supabase = sbService();
  const { data: conn } = await supabase.from('meta_conexoes')
    .select('access_token').eq('user_id', user.id).maybeSingle();
  if (!conn) return res.status(200).json({ ok: true });

  try {
    await fetch(`https://graph.facebook.com/${META_VERSION}/me/permissions?` +
      new URLSearchParams({ access_token: conn.access_token }), { method: 'DELETE' });
  } catch {}

  await Promise.all([
    supabase.from('meta_conexoes').delete().eq('user_id', user.id),
    supabase.from('meta_metricas_cache').delete().eq('user_id', user.id),
  ]);

  return res.status(200).json({ ok: true });
}
