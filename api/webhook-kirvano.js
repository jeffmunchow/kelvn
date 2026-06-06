'use strict';

const crypto = require('crypto');

// Compara dois segredos sem vazar tempo (e sem vazar tamanho).
function segredosBatem(a, b) {
  if (!a || !b) return false;
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// A Kirvano permite configurar um Token no webhook. Ele costuma chegar em
// um header; deixamos a verificação resiliente a onde ele aparece (alguns
// headers comuns + um campo `token` no corpo). Qualquer um que bata serve.
// Depois de ver onde a Kirvano realmente manda (nos logs da Vercel), dá pra
// enxugar para só aquele lugar.
function origemVerificada(req) {
  const esperado = process.env.KIRVANO_WEBHOOK_TOKEN;
  if (!esperado) {
    console.error('[webhook] KIRVANO_WEBHOOK_TOKEN não configurada — rejeitando por segurança');
    return false;
  }

  const h = req.headers || {};
  const limpa = (v) => (typeof v === 'string' ? v.replace(/^Bearer\s+/i, '').trim() : v);

  const candidatos = [
    h['security-token'],
    h['x-kirvano-token'],
    h['kirvano-token'],
    h['x-webhook-token'],
    h['token'],
    h['authorization'],
    req.body && req.body.token,
  ].map(limpa);

  return candidatos.some((c) => segredosBatem(c, esperado));
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // 1) Porteiro: sem token válido, nem olha o resto.
  if (!origemVerificada(req)) {
    return res.status(401).json({ error: 'Origem não autorizada' });
  }

  try {
    const body = req.body;

    const status = body?.status || body?.data?.status;
    const email = body?.customer?.email || body?.data?.customer?.email;

    if (!email) {
      return res.status(400).json({ error: 'Email não encontrado no payload' });
    }

    const aprovado = ['approved', 'APPROVED', 'paid', 'PAID'].includes(status);
    if (!aprovado) {
      return res.status(200).json({ message: 'Evento ignorado — status não é aprovado' });
    }

    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;

    // Cria o usuário via Admin API da Supabase
    const response = await fetch(`${supabaseUrl}/auth/v1/admin/users`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': supabaseServiceKey,
        'Authorization': `Bearer ${supabaseServiceKey}`,
      },
      body: JSON.stringify({
        email: email,
        email_confirm: true,
        password: generateTempPassword(),
        user_metadata: {
          nome: body?.customer?.name || body?.data?.customer?.name || '',
          plano: body?.product?.name || body?.data?.product?.name || 'mensal',
          origem: 'kirvano',
        },
      }),
    });

    const userData = await response.json();

    if (response.ok) {
      // Dispara o e-mail para o usuário definir a própria senha
      await fetch(`${supabaseUrl}/auth/v1/recover`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': supabaseServiceKey,
          'Authorization': `Bearer ${supabaseServiceKey}`,
        },
        body: JSON.stringify({ email: email, gotrue_meta_security: {} }),
      });

      return res.status(200).json({ success: true, message: 'Usuário criado', email });
    }

    // Idempotência: entrega repetida de alguém que já existe não é erro.
    if (userData?.msg?.includes('already') || userData?.code === 'email_exists') {
      return res.status(200).json({ success: true, message: 'Usuário já existe', email });
    }

    // Erro real: loga internamente, mas não devolve detalhes no corpo.
    console.error('[webhook] erro ao criar usuário:', JSON.stringify(userData));
    return res.status(500).json({ error: 'Erro ao criar usuário' });

  } catch (error) {
    console.error('[webhook] erro interno:', error?.message);
    return res.status(500).json({ error: 'Erro interno' });
  }
};

function generateTempPassword() {
  return 'Kelvn_' + crypto.randomBytes(12).toString('base64url');
}
