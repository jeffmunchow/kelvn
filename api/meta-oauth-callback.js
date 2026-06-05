/**
 * /api/meta-oauth-callback
 *
 * GET — recebe o callback do Meta após autorização OAuth.
 * Valida state anti-CSRF, troca code por token de longa duração,
 * busca contas de anúncio e salva no Supabase.
 */

const { createClient } = require('@supabase/supabase-js');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const { code, state, error: metaError } = req.query;

  // 1) Meta recusou ou erro no OAuth
  if (metaError) {
    console.error('meta-oauth-callback meta error:', metaError);
    return res.redirect(302, 'https://app.kelvn.com.br/?meta=erro&motivo=negado');
  }

  if (!code || !state) {
    return res.redirect(302, 'https://app.kelvn.com.br/?meta=erro&motivo=parametros');
  }

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
  );

  // 2) Busca o state salvo — identifica o usuário pelo state
  const { data: stateRows, error: stateErr } = await supabase
    .from('dados_usuario')
    .select('user_id, valor')
    .eq('modulo', 'meta_oauth')
    .eq('chave', 'state');

  if (stateErr || !stateRows?.length) {
    return res.redirect(302, 'https://app.kelvn.com.br/?meta=erro&motivo=state');
  }

  // Encontra a linha onde o state bate
  const stateRow = stateRows.find(r => r.valor?.state === state);
  if (!stateRow) {
    return res.redirect(302, 'https://app.kelvn.com.br/?meta=erro&motivo=csrf');
  }

  // Verifica expiração
  if (new Date(stateRow.valor.expira) < new Date()) {
    return res.redirect(302, 'https://app.kelvn.com.br/?meta=erro&motivo=expirado');
  }

  const userId = stateRow.user_id;

  // Limpa o state usado
  await supabase
    .from('dados_usuario')
    .delete()
    .eq('user_id', userId)
    .eq('modulo', 'meta_oauth')
    .eq('chave', 'state');

  try {
    // 3) Troca code por token de curta duração
    const tokenResp = await fetch(
      `https://graph.facebook.com/v19.0/oauth/access_token?` +
      new URLSearchParams({
        client_id:     process.env.META_APP_ID,
        client_secret: process.env.META_APP_SECRET,
        redirect_uri:  process.env.META_REDIRECT_URI,
        code,
      })
    );
    const tokenData = await tokenResp.json();
    if (!tokenData.access_token) {
      console.error('meta-oauth-callback token error:', JSON.stringify(tokenData));
      return res.redirect(302, 'https://app.kelvn.com.br/?meta=erro&motivo=token');
    }

    // 4) Troca por token de longa duração (~60 dias)
    const longResp = await fetch(
      `https://graph.facebook.com/v19.0/oauth/access_token?` +
      new URLSearchParams({
        grant_type:        'fb_exchange_token',
        client_id:         process.env.META_APP_ID,
        client_secret:     process.env.META_APP_SECRET,
        fb_exchange_token: tokenData.access_token,
      })
    );
    const longData = await longResp.json();
    if (!longData.access_token) {
      console.error('meta-oauth-callback long token error:', JSON.stringify(longData));
      return res.redirect(302, 'https://app.kelvn.com.br/?meta=erro&motivo=token_long');
    }

    const accessToken = longData.access_token;
    const expiraEm = longData.expires_in
      ? new Date(Date.now() + longData.expires_in * 1000).toISOString()
      : null;

    // 5) Busca contas de anúncio vinculadas
    const actsResp = await fetch(
      `https://graph.facebook.com/v19.0/me/adaccounts?fields=id,name,account_status&access_token=${accessToken}`
    );
    const actsData = await actsResp.json();
    const contas = (actsData.data || []).filter(a => a.account_status === 1); // 1 = ativo

    if (!contas.length) {
      return res.redirect(302, 'https://app.kelvn.com.br/?meta=erro&motivo=sem_conta');
    }

    // 6) Se mais de uma conta, redireciona para seleção
    if (contas.length > 1) {
      // Salva token temporariamente para o usuário escolher a conta
      await supabase.from('dados_usuario').upsert({
        user_id: userId,
        modulo:  'meta_oauth',
        chave:   'token_pendente',
        valor:   { accessToken, expiraEm, contas },
      }, { onConflict: 'user_id,modulo,chave' });

      const contasParam = encodeURIComponent(JSON.stringify(contas.map(c => ({ id: c.id, name: c.name }))));
      return res.redirect(302, `https://app.kelvn.com.br/?meta=escolher_conta&contas=${contasParam}`);
    }

    // 7) Conta única — salva direto
    const conta = contas[0];
    await _salvarConexao(supabase, userId, accessToken, expiraEm, conta.id, conta.name);

    return res.redirect(302, 'https://app.kelvn.com.br/?meta=conectado');

  } catch (err) {
    console.error('meta-oauth-callback fatal:', err.message);
    return res.redirect(302, 'https://app.kelvn.com.br/?meta=erro&motivo=interno');
  }
};

async function _salvarConexao(supabase, userId, accessToken, expiraEm, adAccountId, contaNome) {
  const { error } = await supabase
    .from('meta_conexoes')
    .upsert({
      user_id:        userId,
      access_token:   accessToken,
      token_expira_em: expiraEm,
      ad_account_id:  adAccountId,
      conta_nome:     contaNome || null,
      atualizado_em:  new Date().toISOString(),
    }, { onConflict: 'user_id' });

  if (error) throw new Error('Supabase upsert error: ' + error.message);
}
