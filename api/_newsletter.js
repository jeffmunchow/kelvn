/**
 * _newsletter.js — lógica da newsletter exportada como módulo.
 * Prefixo _ para não contar como função Vercel (limite Hobby = 12).
 * Chamado por album-revisao.js via require('./_newsletter').
 */
const { createClient } = require('@supabase/supabase-js');

// ── Descadastro ───────────────────────────────────────────────────────────────

async function acUnsub(req, res) {
  const { uid } = req.query;
  if (!uid) return res.status(400).send(pagina('Erro', 'Link inválido.'));

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  try {
    const { data: profile, error } = await supabase
      .from('profiles').select('email, nome').eq('id', uid).single();
    if (error || !profile) return res.status(404).send(pagina('Erro', 'Membro não encontrado.'));

    await supabase.from('newsletter_unsub').upsert({ email: profile.email.toLowerCase() });

    const { data: cfg } = await supabase
      .from('configuracoes').select('sd').eq('user_id', uid).single();
    const sd = (cfg && cfg.sd) || {};
    sd.newsletter_ativo = false;
    await supabase.from('configuracoes')
      .upsert({ user_id: uid, sd, atualizado_em: new Date().toISOString() }, { onConflict: 'user_id' });

    return res.status(200).send(pagina(
      'Descadastrado',
      `Pronto, ${profile.nome ? profile.nome.split(' ')[0] : ''}. Você não vai mais receber o resumo semanal.<br><br>
       Se mudar de ideia, é só reativar nos Ajustes do app.`
    ));
  } catch (err) {
    console.error('newsletter unsub error:', err);
    return res.status(500).send(pagina('Erro', 'Algo deu errado. Tente novamente.'));
  }
}

// ── Envio semanal (cron) ──────────────────────────────────────────────────────

async function acEnviar(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST')
    return res.status(405).json({ error: 'Method not allowed' });

  const cronSecret = process.env.CRON_SECRET;
  const authHeader = req.headers['authorization'];
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`)
    return res.status(401).json({ error: 'Unauthorized' });

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  try {
    const { data: profiles, error: pErr } = await supabase
      .from('profiles').select('id, email, nome, plano').eq('ativo', true);
    if (pErr) throw pErr;
    if (!profiles?.length) return res.status(200).json({ sent: 0, message: 'Nenhum membro ativo' });

    const { data: unsubs } = await supabase.from('newsletter_unsub').select('email');
    const unsubEmails = new Set((unsubs || []).map(r => r.email.toLowerCase()));

    const userIds = profiles.map(p => p.id);
    const [configRes, clientesRes, eventosRes, finRes] = await Promise.all([
      supabase.from('configuracoes').select('user_id, sd').in('user_id', userIds),
      supabase.from('clientes').select('user_id, data').in('user_id', userIds),
      supabase.from('eventos').select('user_id, data').in('user_id', userIds),
      supabase.from('financeiro').select('user_id, data').in('user_id', userIds),
    ]);

    const configMap   = {}; (configRes.data   || []).forEach(r => configMap[r.user_id]   = r.sd   || {});
    const clientesMap = {}; (clientesRes.data  || []).forEach(r => clientesMap[r.user_id] = r.data || []);
    const eventosMap  = {}; (eventosRes.data   || []).forEach(r => eventosMap[r.user_id]  = r.data || []);
    const finMap      = {}; (finRes.data       || []).forEach(r => finMap[r.user_id]      = r.data || []);

    const hoje     = new Date(); hoje.setHours(0,0,0,0);
    const em7dias  = new Date(hoje); em7dias.setDate(hoje.getDate() + 7);
    const em30dias = new Date(hoje); em30dias.setDate(hoje.getDate() + 30);
    const inicioMes = new Date(hoje.getFullYear(), hoje.getMonth(), 1);

    let sent = 0, skipped = 0;

    for (const profile of profiles) {
      const email = profile.email?.toLowerCase();
      if (!email || unsubEmails.has(email)) { skipped++; continue; }

      const sd = configMap[profile.id] || {};
      if (sd.newsletter_ativo === false) { skipped++; continue; }

      const clientes = clientesMap[profile.id] || [];
      const eventos  = eventosMap[profile.id]  || [];
      const fin      = finMap[profile.id]       || [];

      const prospects = clientes.filter(c => c.status === 'Prospect');
      const eventosSemana = eventos.filter(e => {
        if (!e.data || e._fromCliente) return false;
        const d = new Date(e.data.substring(0,10)+'T12:00');
        return d >= hoje && d <= em7dias;
      });
      const semContrato = clientes.filter(c => {
        if (!c.data) return false;
        const d = new Date((c.data||'').substring(0,10)+'T12:00');
        return d >= hoje && d <= em30dias
          && (c.status === 'Casamento' || c.status === 'Religioso') && !c.contrato;
      });
      const vencidas = fin.filter(f =>
        f.tipo === 'entrada' && !f.pago && f.data &&
        new Date(f.data.substring(0,10)+'T12:00') < hoje);
      const aReceberSemana = fin.filter(f =>
        f.tipo === 'entrada' && !f.pago && f.data &&
        new Date(f.data.substring(0,10)+'T12:00') >= hoje &&
        new Date(f.data.substring(0,10)+'T12:00') <= em7dias);
      const totalAReceberSemana = aReceberSemana.reduce((s,f) => s + (f.valor||0), 0);
      const receitaMes = fin
        .filter(f => f.tipo === 'entrada' && f.pago && f.data &&
          new Date(f.data.substring(0,10)+'T12:00') >= inicioMes)
        .reduce((s,f) => s + (f.valor||0), 0);
      const casamentosAno = clientes.filter(c => {
        const d = c.data ? new Date(c.data.substring(0,10)+'T12:00') : null;
        return d && d.getFullYear() === hoje.getFullYear() &&
          (c.status === 'Casamento' || c.status === 'Religioso');
      }).length;

      const nome = profile.nome || sd.studio_nome || 'fotógrafo';
      const html = buildEmail({ nome, email, userId: profile.id,
        prospects, eventosSemana, semContrato,
        vencidas, totalAReceberSemana, receitaMes, casamentosAno });

      const r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
          'Content-Type': 'application/json' },
        body: JSON.stringify({ from: 'Kelvn <oi@kelvn.com.br>',
          to: [email], subject: 'Seu resumo da semana — Kelvn', html })
      });

      if (r.ok) sent++; else skipped++;
    }

    return res.status(200).json({ sent, skipped });
  } catch (err) {
    console.error('newsletter enviar error:', err);
    return res.status(500).json({ error: 'Server error', message: err.message });
  }
}

// ── Template de e-mail ────────────────────────────────────────────────────────

function fmt(v) { return 'R$ '+Number(v).toLocaleString('pt-BR',{minimumFractionDigits:2,maximumFractionDigits:2}); }
function fmtData(s) {
  if (!s) return '';
  return new Date(s.substring(0,10)+'T12:00').toLocaleDateString('pt-BR');
}

function buildEmail({ nome, email, userId, prospects, eventosSemana, semContrato,
                      vencidas, totalAReceberSemana, receitaMes, casamentosAno }) {
  const primeiroNome = nome.split(' ')[0];
  const unsubUrl = `https://app.kelvn.com.br/api/album-revisao?action=unsub&uid=${encodeURIComponent(userId)}`;
  const appUrl   = 'https://app.kelvn.com.br';

  const bg='#F7F4EF',surface='#FFFFFF',text='#1A1814',muted='#6B6660',hint='#B0ABA6';
  const amber='#C4780A',coral='#C43A1A',teal='#0A7864',border='rgba(0,0,0,0.08)';

  let alertas = [];
  if (prospects.length > 0) alertas.push(`<tr><td style="padding:10px 0;border-bottom:0.5px solid ${border};">
    <span style="display:inline-block;width:8px;height:8px;background:${amber};border-radius:50%;margin-right:8px;vertical-align:middle;"></span>
    <strong style="color:${text};font-size:14px;">${prospects.length} prospect${prospects.length>1?'s':''} aguardando follow-up</strong>
    <div style="color:${muted};font-size:13px;margin-top:3px;padding-left:16px;">${prospects.slice(0,3).map(c=>c.nome).join(', ')}${prospects.length>3?' e mais...':''}</div>
  </td></tr>`);
  if (semContrato.length > 0) alertas.push(`<tr><td style="padding:10px 0;border-bottom:0.5px solid ${border};">
    <span style="display:inline-block;width:8px;height:8px;background:${coral};border-radius:50%;margin-right:8px;vertical-align:middle;"></span>
    <strong style="color:${text};font-size:14px;">${semContrato.length} casamento${semContrato.length>1?'s':''} sem contrato nos próximos 30 dias</strong>
    <div style="color:${muted};font-size:13px;margin-top:3px;padding-left:16px;">${semContrato.map(c=>`${c.nome} · ${fmtData(c.data)}`).join('<br>')}</div>
  </td></tr>`);
  if (vencidas.length > 0) { const tv=vencidas.reduce((s,f)=>s+(f.valor||0),0);
    alertas.push(`<tr><td style="padding:10px 0;border-bottom:0.5px solid ${border};">
    <span style="display:inline-block;width:8px;height:8px;background:${coral};border-radius:50%;margin-right:8px;vertical-align:middle;"></span>
    <strong style="color:${text};font-size:14px;">${fmt(tv)} em parcelas vencidas</strong>
    <div style="color:${muted};font-size:13px;margin-top:3px;padding-left:16px;">${vencidas.length} entrada${vencidas.length>1?'s':''} não recebida${vencidas.length>1?'s':''}</div>
  </td></tr>`); }

  const eventosSemanaHtml = eventosSemana.length > 0 ? `
    <tr><td style="padding:20px 0 8px;"><p style="margin:0;font-size:12px;color:${hint};text-transform:uppercase;letter-spacing:0.08em;">Essa semana</p></td></tr>
    ${eventosSemana.map(e=>`<tr><td style="padding:8px 0;border-bottom:0.5px solid ${border};color:${text};font-size:14px;"><strong>${e.titulo||e.tipo||'Evento'}</strong><span style="color:${muted};font-size:13px;margin-left:8px;">${fmtData(e.data)}</span></td></tr>`).join('')}` : '';

  const financeiroHtml = totalAReceberSemana > 0 ? `
    <tr><td style="padding:20px 0 8px;"><p style="margin:0;font-size:12px;color:${hint};text-transform:uppercase;letter-spacing:0.08em;">Financeiro</p></td></tr>
    <tr><td style="padding:8px 0;border-bottom:0.5px solid ${border};"><span style="color:${teal};font-size:14px;"><strong>${fmt(totalAReceberSemana)}</strong> a receber nos próximos 7 dias</span></td></tr>` : '';

  let positivoHtml = '';
  if (receitaMes > 0 || casamentosAno > 0) {
    positivoHtml = `<tr><td style="padding:20px 0 8px;"><p style="margin:0;font-size:12px;color:${hint};text-transform:uppercase;letter-spacing:0.08em;">Números</p></td></tr>`;
    if (receitaMes > 0) positivoHtml += `<tr><td style="padding:8px 0;border-bottom:0.5px solid ${border};font-size:14px;"><strong style="color:${teal};">${fmt(receitaMes)}</strong> <span style="color:${muted};">de receita esse mês</span></td></tr>`;
    if (casamentosAno > 0) positivoHtml += `<tr><td style="padding:8px 0;border-bottom:0.5px solid ${border};font-size:14px;"><strong style="color:${amber};">${casamentosAno}</strong> <span style="color:${muted};">casamento${casamentosAno>1?'s':''} confirmado${casamentosAno>1?'s':''} em ${new Date().getFullYear()}</span></td></tr>`;
  }

  const alertasHtml = alertas.length > 0 ? `
    <tr><td style="padding:20px 0 8px;"><p style="margin:0;font-size:12px;color:${hint};text-transform:uppercase;letter-spacing:0.08em;">Para agir agora</p></td></tr>
    ${alertas.join('')}` : '';

  const tudoEmOrdem = alertas.length === 0 && eventosSemana.length === 0 && totalAReceberSemana === 0;

  return `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Seu resumo da semana — Kelvn</title></head>
<body style="margin:0;padding:0;background-color:${bg};font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${bg};">
<tr><td align="center" style="padding:40px 16px;">
<table width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;">
<tr><td style="padding-bottom:32px;text-align:left;"><span style="font-size:28px;color:${amber};font-weight:700;">Kelvn</span></td></tr>
<tr><td style="background:${surface};border-radius:12px;padding:32px;border:0.5px solid ${border};">
<table width="100%" cellpadding="0" cellspacing="0" border="0">
<tr><td style="padding-bottom:24px;border-bottom:0.5px solid ${border};">
<p style="margin:0 0 4px;font-size:22px;font-weight:600;color:${text};font-family:Georgia,serif;">Oi, ${primeiroNome}.</p>
<p style="margin:0;font-size:14px;color:${muted};">Aqui está o que merece atenção essa semana.</p>
</td></tr>
${tudoEmOrdem ? `<tr><td style="padding:24px 0;text-align:center;"><p style="margin:0;font-size:15px;color:${teal};font-weight:600;">Tudo em ordem por aqui ✓</p><p style="margin:8px 0 0;font-size:13px;color:${muted};">Sem alertas pendentes. Continue assim.</p></td></tr>` :
`${alertasHtml}${eventosSemanaHtml}${financeiroHtml}${positivoHtml}`}
<tr><td style="padding-top:28px;text-align:center;"><a href="${appUrl}" style="display:inline-block;background:${text};color:${bg};text-decoration:none;padding:11px 28px;border-radius:8px;font-size:14px;font-weight:500;">Ver no app</a></td></tr>
</table></td></tr>
<tr><td style="padding-top:24px;text-align:center;">
<p style="margin:0;font-size:12px;color:${hint};">Você recebe esse email toda segunda-feira.</p>
<p style="margin:6px 0 0;font-size:12px;color:${hint};"><a href="${unsubUrl}" style="color:${hint};text-decoration:underline;">Cancelar recebimento</a></p>
</td></tr>
</table></td></tr></table></body></html>`;
}

// ── Página HTML simples ───────────────────────────────────────────────────────

function pagina(titulo, mensagem) {
  return `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${titulo} — Kelvn</title>
<style>*{margin:0;padding:0;box-sizing:border-box;}body{font-family:'Helvetica Neue',sans-serif;background:#F7F4EF;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:2rem;}.box{background:#fff;border:.5px solid rgba(0,0,0,.08);border-radius:12px;padding:2.5rem 2rem;max-width:400px;width:100%;text-align:center;}.logo{font-size:1.6rem;color:#C4780A;font-weight:700;margin-bottom:1.5rem;}h1{font-size:1.2rem;color:#1A1814;font-family:Georgia,serif;margin-bottom:.75rem;}p{font-size:.85rem;color:#6B6660;line-height:1.6;}a{color:#C4780A;text-decoration:none;display:inline-block;margin-top:1.5rem;font-size:.82rem;}</style></head>
<body><div class="box"><div class="logo">Kelvn</div><h1>${titulo}</h1><p>${mensagem}</p><a href="https://app.kelvn.com.br">Voltar para o app →</a></div></body></html>`;
}

module.exports = { acUnsub, acEnviar, buildEmail, pagina, fmt, fmtData };
