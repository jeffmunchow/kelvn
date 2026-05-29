const { createClient } = require('@supabase/supabase-js');

// GET /api/newsletter-unsubscribe?uid=<user_id>
// Chamado quando o membro clica em "Cancelar recebimento" no email
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { uid } = req.query;
  if (!uid) return res.status(400).send(pagina('Erro', 'Link inválido.'));

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  try {
    // Busca o email do membro pelo user_id
    const { data: profile, error } = await supabase
      .from('profiles')
      .select('email, nome')
      .eq('id', uid)
      .single();

    if (error || !profile) return res.status(404).send(pagina('Erro', 'Membro não encontrado.'));

    // Adiciona à lista de descadastro
    await supabase.from('newsletter_unsub').upsert({ email: profile.email.toLowerCase() });

    // Também desativa o toggle no app (sd.newsletter_ativo = false)
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
    console.error('newsletter-unsubscribe error:', err);
    return res.status(500).send(pagina('Erro', 'Algo deu errado. Tente novamente.'));
  }
};

function pagina(titulo, mensagem) {
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${titulo} — Kelvn</title>
<style>*{margin:0;padding:0;box-sizing:border-box;}
body{font-family:'Helvetica Neue',sans-serif;background:#F7F4EF;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:2rem;}
.box{background:#fff;border:.5px solid rgba(0,0,0,.08);border-radius:12px;padding:2.5rem 2rem;max-width:400px;width:100%;text-align:center;}
.logo{font-size:1.6rem;color:#C4780A;font-weight:700;margin-bottom:1.5rem;}
h1{font-size:1.2rem;color:#1A1814;font-family:Georgia,serif;margin-bottom:.75rem;}
p{font-size:.85rem;color:#6B6660;line-height:1.6;}
a{color:#C4780A;text-decoration:none;display:inline-block;margin-top:1.5rem;font-size:.82rem;}
</style></head>
<body><div class="box">
  <div class="logo">Kelvn</div>
  <h1>${titulo}</h1>
  <p>${mensagem}</p>
  <a href="https://app.kelvn.com.br">Voltar para o app →</a>
</div></body></html>`;
}
