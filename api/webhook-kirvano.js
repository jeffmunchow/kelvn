export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const body = req.body;

    // Verifica se é um evento de compra aprovada
    const status = body?.status || body?.data?.status;
    const email = body?.customer?.email || body?.data?.customer?.email;

    if (!email) {
      return res.status(400).json({ error: 'Email não encontrado no payload' });
    }

    if (status !== 'approved' && status !== 'APPROVED' && status !== 'paid' && status !== 'PAID') {
      return res.status(200).json({ message: 'Evento ignorado — status não é aprovado' });
    }

    // Cria usuário no Supabase via Admin API
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;

    // Chama a API de admin do Supabase para criar o usuário
    const response = await fetch(`${supabaseUrl}/auth/v1/admin/users`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': supabaseServiceKey,
        'Authorization': `Bearer ${supabaseServiceKey}`
      },
      body: JSON.stringify({
        email: email,
        email_confirm: true,
        password: generateTempPassword(),
        user_metadata: {
          nome: body?.customer?.name || body?.data?.customer?.name || '',
          plano: body?.product?.name || body?.data?.product?.name || 'mensal',
          origem: 'kirvano'
        }
      })
    });

    const userData = await response.json();

    if (response.ok) {
      // Envia email de redefinição de senha para o novo usuário definir sua senha
      await fetch(`${supabaseUrl}/auth/v1/admin/users/${userData.id}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'apikey': supabaseServiceKey,
          'Authorization': `Bearer ${supabaseServiceKey}`
        },
        body: JSON.stringify({ email_confirm: true })
      });

      // Dispara email de recuperação de senha para o usuário definir sua senha
      await fetch(`${supabaseUrl}/auth/v1/recover`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': supabaseServiceKey,
          'Authorization': `Bearer ${supabaseServiceKey}`
        },
        body: JSON.stringify({
          email: email,
          gotrue_meta_security: {}
        })
      });

      return res.status(200).json({ success: true, message: 'Usuário criado com sucesso', email });
    } else {
      // Se o usuário já existe, apenas dispara o email de acesso
      if (userData.msg?.includes('already') || userData.code === 'email_exists') {
        return res.status(200).json({ success: true, message: 'Usuário já existe', email });
      }
      return res.status(500).json({ error: 'Erro ao criar usuário', details: userData });
    }

  } catch (error) {
    console.error('Webhook error:', error);
    return res.status(500).json({ error: 'Erro interno', message: error.message });
  }
}

function generateTempPassword() {
  return 'Kelvn_' + Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6).toUpperCase();
}
