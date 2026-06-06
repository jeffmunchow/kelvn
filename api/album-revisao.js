/**
 * /api/album-revisao
 *
 * GET  ?action=unsub&uid=<uid>     → cancela newsletter (compat. links antigos)
 * GET  (sem action, cron header)   → envia newsletter semanal
 * POST ?action=gerar               → gera/regenera token de revisão (autenticado)
 * POST ?action=notificar           → notifica fotógrafo após comentário/aprovação (anon, rate-limited)
 */

const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');
const { acUnsub, acEnviar, pagina } = require('./_newsletter');

const RATE_IP_MAX  = 10;  // máx comentários por IP
const RATE_IP_MIN  = 30;  // janela em minutos
const TOKEN_DIAS   = 30;  // validade do link em dias

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { action, cron } = req.query;

  // ── Newsletter (compat. links já enviados) ────────────────────────────────
  if (action === 'unsub') return acUnsub(req, res);
  if (cron === 'newsletter') return acEnviar(req, res);

  // ── Album review ──────────────────────────────────────────────────────────
  if (action === 'gerar')     return acGerar(req, res);
  if (action === 'notificar') return acNotificar(req, res);

  return res.status(404).json({ error: 'Not found' });
};

// ── Gerar / regenerar token de revisão ───────────────────────────────────────

async function acGerar(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Autenticação via JWT
  const authHeader = req.headers['authorization'];
  if (!authHeader?.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
  const jwt = authHeader.slice(7);

  const sbAnon = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
  const { data: { user }, error: authErr } = await sbAnon.auth.getUser(jwt);
  if (authErr || !user) return res.status(401).json({ error: 'Unauthorized' });
  const userId = user.id;

  const { album_id } = req.body || {};
  if (!album_id) return res.status(400).json({ error: 'album_id obrigatório' });

  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  // Verificar propriedade do álbum
  const { data: album, error: aErr } = await sb
    .from('albuns').select('id, nome, revisao_rodada')
    .eq('id', album_id).eq('user_id', userId).maybeSingle();
  if (aErr || !album) return res.status(404).json({ error: 'Álbum não encontrado' });

  // Gerar token
  const token = crypto.randomBytes(32).toString('hex');
  const expira = new Date(Date.now() + TOKEN_DIAS * 24 * 60 * 60 * 1000).toISOString();
  const rodada = (album.revisao_rodada || 0) + 1;

  const { error: uErr } = await sb.from('albuns').update({
    revisao_token: token,
    revisao_ativa: true,
    revisao_rodada: rodada,
    revisao_expira_em: expira,
    aprovado: false,
    aprovado_em: null,
    aprovado_por_nome: null,
    aprovado_por_email: null,
    atualizado_em: new Date().toISOString(),
  }).eq('id', album_id).eq('user_id', userId);

  if (uErr) {
    console.error('acGerar update error:', uErr);
    return res.status(500).json({ error: 'Erro ao salvar token' });
  }

  const link = `https://app.kelvn.com.br/album-revisao?t=${token}`;
  return res.status(200).json({ link, rodada, expira });
}

// ── Notificar fotógrafo (comentário ou aprovação) ─────────────────────────────

async function acNotificar(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { album_id, tipo, nome_casal, email_casal, spread_num } = req.body || {};
  if (!album_id || !tipo) return res.status(400).json({ error: 'Campos obrigatórios: album_id, tipo' });

  // Rate limit por IP
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || 'unknown';
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  const since = new Date(Date.now() - RATE_IP_MIN * 60 * 1000).toISOString();
  const ipHash = crypto.createHash('sha256').update(ip).digest('hex').substring(0, 16);

  const { count } = await sb.from('album_comentario_attempts')
    .select('*', { count: 'exact', head: true })
    .eq('ip_hash', ipHash)
    .gte('tentativa_em', since);

  if (count >= RATE_IP_MAX) {
    return res.status(429).json({ error: 'Muitas tentativas. Aguarde alguns minutos.' });
  }

  // Registrar tentativa
  await sb.from('album_comentario_attempts').insert({ ip_hash: ipHash });

  // Buscar email do fotógrafo via álbum
  const { data: album, error: aErr } = await sb
    .from('albuns').select('id, nome, user_id').eq('id', album_id).maybeSingle();
  if (aErr || !album) return res.status(404).json({ error: 'Álbum não encontrado' });

  const { data: profile, error: pErr } = await sb
    .from('profiles').select('email, nome').eq('id', album.user_id).maybeSingle();
  if (pErr || !profile?.email) {
    console.error('acNotificar: fotógrafo não encontrado', pErr);
    return res.status(200).json({ ok: true }); // silencioso
  }

  const fotograNome = profile.nome ? profile.nome.split(' ')[0] : 'fotógrafo';

  let subject, html;
  if (tipo === 'aprovado') {
    subject = `Álbum aprovado — ${album.nome}`;
    html = emailAprovado({ fotograNome, albumNome: album.nome, nomeCasal: nome_casal, emailCasal: email_casal });
  } else {
    subject = `Novo comentário no álbum — ${album.nome}`;
    html = emailComentario({ fotograNome, albumNome: album.nome, nomeCasal: nome_casal, spreadNum: spread_num });
  }

  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: 'Kelvn <oi@kelvn.com.br>',
      to: [profile.email],
      subject,
      html,
    }),
  });

  if (!r.ok) {
    const err = await r.text().catch(() => '');
    console.error('acNotificar resend error:', err);
  }

  return res.status(200).json({ ok: true });
}

// ── Templates de e-mail ───────────────────────────────────────────────────────

function emailComentario({ fotograNome, albumNome, nomeCasal, spreadNum }) {
  const appUrl = 'https://app.kelvn.com.br/album.html';
  const bg='#F7F4EF', surface='#FFFFFF', text='#1A1814', muted='#6B6660', hint='#B0ABA6';
  const amber='#C4780A', border='rgba(0,0,0,0.08)';
  const quem = nomeCasal ? `<strong style="color:${text};">${esc(nomeCasal)}</strong>` : 'O casal';
  const onde = spreadNum ? ` no spread ${spreadNum}` : '';

  return `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"><title>Novo comentário — Kelvn</title></head>
<body style="margin:0;padding:0;background:${bg};font-family:'Helvetica Neue',Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:${bg};"><tr><td align="center" style="padding:40px 16px;">
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;">
<tr><td style="padding-bottom:28px;"><span style="font-size:26px;color:${amber};font-weight:700;">Kelvn</span></td></tr>
<tr><td style="background:${surface};border-radius:12px;padding:28px 32px;border:.5px solid ${border};">
<p style="margin:0 0 8px;font-size:20px;font-weight:600;color:${text};font-family:Georgia,serif;">Oi, ${esc(fotograNome)}.</p>
<p style="margin:0 0 20px;font-size:14px;color:${muted};">${quem} deixou um comentário${onde} no álbum <strong style="color:${text};">${esc(albumNome)}</strong>.</p>
<p style="margin:0 0 24px;font-size:13px;color:${muted};">Acesse o editor para ver e resolver o comentário.</p>
<a href="${appUrl}" style="display:inline-block;background:${text};color:${bg};text-decoration:none;padding:10px 24px;border-radius:8px;font-size:14px;font-weight:500;">Ver no editor</a>
</td></tr>
<tr><td style="padding-top:20px;text-align:center;"><p style="margin:0;font-size:11px;color:${hint};">Kelvn — para fotógrafos de casamento</p></td></tr>
</table></td></tr></table></body></html>`;
}

function emailAprovado({ fotograNome, albumNome, nomeCasal, emailCasal }) {
  const appUrl = 'https://app.kelvn.com.br/album.html';
  const bg='#F7F4EF', surface='#FFFFFF', text='#1A1814', muted='#6B6660', hint='#B0ABA6';
  const amber='#C4780A', teal='#0A7864', border='rgba(0,0,0,0.08)';
  const quem = nomeCasal ? esc(nomeCasal) : 'O casal';
  const contato = emailCasal ? ` (${esc(emailCasal)})` : '';

  return `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"><title>Álbum aprovado — Kelvn</title></head>
<body style="margin:0;padding:0;background:${bg};font-family:'Helvetica Neue',Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:${bg};"><tr><td align="center" style="padding:40px 16px;">
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;">
<tr><td style="padding-bottom:28px;"><span style="font-size:26px;color:${amber};font-weight:700;">Kelvn</span></td></tr>
<tr><td style="background:${surface};border-radius:12px;padding:28px 32px;border:.5px solid ${border};">
<p style="margin:0 0 8px;font-size:20px;font-weight:600;color:${text};font-family:Georgia,serif;">Álbum aprovado! ✓</p>
<p style="margin:0 0 16px;font-size:14px;color:${muted};">Oi, ${esc(fotograNome)}. <strong style="color:${teal};">${quem}${contato}</strong> aprovou o álbum <strong style="color:${text};">${esc(albumNome)}</strong>.</p>
<p style="margin:0 0 24px;font-size:13px;color:${muted};">O álbum está pronto para enviar para impressão.</p>
<a href="${appUrl}" style="display:inline-block;background:${text};color:${bg};text-decoration:none;padding:10px 24px;border-radius:8px;font-size:14px;font-weight:500;">Ver álbum</a>
</td></tr>
<tr><td style="padding-top:20px;text-align:center;"><p style="margin:0;font-size:11px;color:${hint};">Kelvn — para fotógrafos de casamento</p></td></tr>
</table></td></tr></table></body></html>`;
}

function esc(str) {
  if (!str) return '';
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
