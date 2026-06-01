# Kelvn — Contexto para Claude Code

> Este arquivo é o ponto de partida para qualquer sessão no Claude Code.
> Leia antes de qualquer tarefa. Atualize ao concluir pendências.

---

## 1. O projeto

**Kelvn** é um CRM/gestão para fotógrafos de casamento brasileiros.
Fundador: Jeff Münchow (Münchow Studio).

### Stack de produção

| Camada | Tecnologia |
|---|---|
| Frontend | `app/kelvn.html` — HTML/CSS/JS puro, sem framework |
| Páginas públicas | `app/assinar.html`, `app/form.html`, `app/galeria.html` |
| Hospedagem | Vercel (auto-deploy no push para `main`) |
| Backend | Supabase (Postgres + RLS + Auth), região São Paulo |
| Fotos | Cloudflare R2 via `/api/gallery-*` |
| Pagamento | Kirvano → webhook cria usuário |
| Email | Resend |
| DNS | Hostinger |
| Repo | `github.com/jeffmunchow/kelvn` (público) |

### Chaves

- **Chave anon/publishable** (`eyJ...` ou `sb_publishable_...`): pública por design, está no `kelvn.html`. A segurança **não** depende dela ser secreta.
- **`SUPABASE_SERVICE_KEY`**: env da Vercel, ignora RLS, nunca deve aparecer no client.
- **`ANTHROPIC_API_KEY`**, credenciais R2, token Kirvano: env da Vercel.

### Regra de ouro de segurança

Na Kelvn, a chave publishable é pública. **Toda a segurança de dados está nas políticas RLS e nas funções serverless.** É lá que focamos.

---

## 2. Histórico de segurança — 8 vulnerabilidades resolvidas (maio/2026)

Todas mergeadas e em produção. Nenhuma pendência das rodadas anteriores.

| # | Severidade | Vulnerabilidade | PR |
|---|---|---|---|
| 1 | P0 | Webhook Kirvano sem verificação de origem | #1 |
| 2 | P0 | RLS de `contratos` não impunha o token | #1 |
| 3 | P1 | IDOR em `gallery-delete` | #2 |
| 4 | P1 | `gallery-download` sem autenticação | #2 |
| 5 | P2 | `gallery-upload` com userId do body | #2 |
| 6 | P1 | Token de questionário sem RLS | #3 |
| 7 | P2 | `gallery-verify` sem rate limit | #4 |
| 8 | P2 | `gallery-public` sem filtro no banco | #5 |

---

## 3. Auditoria nova — 13 achados (junho/2026) — TODOS ABERTOS

Identificados lendo o código em junho/2026. Zerar conforme resolver.

---

### P0 — Resolver agora

#### P0-A · Stored XSS via favoritos → tomada de conta do fotógrafo

**Arquivo:** `api/favoritos.js` + `app/kelvn.html` (renderSelecoes)

`action=save` é público e sem autenticação. Aceita `email` livre que passa por regex fraca (`[^\s@]+@[^\s@]+\.[^\s@]+`) — a regex **não bloqueia** `<`, `>`, `'`. O email é gravado em `galeria_favoritos` e depois renderizado via `innerHTML` **sem escape** na tela de Seleções do fotógrafo (linha ~6861) e dentro de um `onclick=` (linha ~7009), quebrando o atributo.

**E daí:** um atacante anônimo injeta marcação HTML em qualquer galeria; quando o fotógrafo abre as Seleções, o código executa **dentro da sessão autenticada** — exfiltrando clientes, financeiro, contratos, PIX.

**Fix:**
1. Sanitizar `email` no `favoritos.js` antes de gravar (usar `DOMPurify` ou regex que bloqueie caracteres HTML).
2. Criar helper `esc(s)` em `kelvn.html` e usá-lo em **todo** lugar que renderiza dado de terceiro via `innerHTML`.
3. Especialmente: substituir as linhas ~6861/6898/7009-7010 por `textContent` ou `esc(sel.email)`.

---

#### P0-B · `/api/newsletter-semanal` cron aberto — vaza base de e-mails + spam forçado

**Arquivo:** `api/newsletter-semanal.js`

Não verifica origem nenhuma (aceita GET e POST de qualquer um). A resposta devolve `results: [{email, status}...]` com **todos os e-mails dos membros ativos**. Um chamador anônimo recebe a base de e-mails inteira e dispara o envio do resumo para todos os membros simultaneamente — queimando o domínio `oi@kelvn.com.br` no Resend e a cota.

**Fix:**
```javascript
// No topo do handler, antes de qualquer coisa:
const cronSecret = process.env.CRON_SECRET;
const authHeader = req.headers['authorization'];
if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
  return res.status(401).json({ error: 'Unauthorized' });
}
// E nunca retornar os e-mails na resposta — só { sent, skipped }
```
Adicionar `CRON_SECRET` nas env vars da Vercel e no `vercel.json` (crons section).

---

#### P0-C · Token do Browserless hardcoded no repositório público

**Arquivo:** `api/contrato-pdf.js`, linha 1

```javascript
const BROWSERLESS_TOKEN = '2UXSEs19xerqqFb519fb241062efb3309bde0aa013eb278bb';
```

Este token está **visível para qualquer um que abra o repositório no GitHub**. É segredo vazado — rotacionar o valor antigo não basta para reverter a exposição histórica, mas rotacionar mata o uso indevido imediato.

**Fix:**
1. Rotacionar o token no painel do Browserless agora.
2. Substituir a linha por `const BROWSERLESS_TOKEN = process.env.BROWSERLESS_TOKEN;`
3. Adicionar `BROWSERLESS_TOKEN` nas env vars da Vercel.

---

### P1 — Esta semana

#### P1-A · `/api/ai-proxy` é um proxy de LLM aberto

**Arquivo:** `api/ai-proxy.js`

Sem nenhuma autenticação. O `Access-Control-Allow-Origin: https://app.kelvn.com.br` **não protege nada** fora do navegador — qualquer `curl` ignora CORS. Qualquer um chama a URL com qualquer `{messages, system}` e usa a API da Anthropic com a sua chave, sem teto de custo.

**Fix:**
```javascript
// Validar JWT do Supabase antes de chamar a Anthropic:
const { createClient } = require('@supabase/supabase-js');
const token = req.headers.authorization?.split('Bearer ')[1];
if (!token) return res.status(401).json({ error: 'Unauthorized' });
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const { data: { user }, error } = await sb.auth.getUser(token);
if (error || !user) return res.status(401).json({ error: 'Unauthorized' });
// Opcional: fixar o system no servidor, não aceitar do client
```

---

#### P1-B · `favoritos.js` autentica com JWT sem validar a assinatura

**Arquivo:** `api/favoritos.js`

O helper `jwtUserId()` faz `JSON.parse(base64(token.split('.')[1]))` e lê `sub` — **não verifica a assinatura**. Qualquer um forja um JWT com o `sub` que quiser. Além disso, `action=all` busca os favoritos de qualquer array de `slugs` passado pelo client, **sem confirmar que esses slugs pertencem ao usuário autenticado** — vazando e-mails de convidados de galerias de outros fotógrafos.

**Fix:**
```javascript
// Substituir jwtUserId() por validação real:
const { data: { user }, error } = await supabase.auth.getUser(token);
if (error || !user) return res.status(401).json({ error: 'Invalid token' });
const userId = user.id;

// No action=all, filtrar os slugs pelo dono:
const { data: galRow } = await supabase.from('galerias').select('data').eq('user_id', userId).single();
const galeriasDoUser = (galRow?.data || []).map(g => g.slug);
const slugsFiltrados = slugs.filter(s => galeriasDoUser.includes(s));
// Buscar só slugsFiltrados
```

---

#### P1-C · Token de questionário gerado com `Math.random()`

**Arquivo:** `app/kelvn.html`, linha ~5416

```javascript
var token = uid()+uid(); // uid() usa Math.random() — não é criptográfico
```

`Math.random()` é previsível em V8. Combinado com `Date.now()` conhecido, o token pode ser forçado/previsto — dando acesso a questionários de clientes de outros fotógrafos (cujo `/form?t=` a função SECURITY DEFINER protege, mas a barreira cai se o token for adivinhável). O contrato já usa `crypto.randomUUID()` corretamente.

**Fix:** Substituir apenas a geração do token de questionário:
```javascript
var token = crypto.randomUUID(); // seguro, 122 bits de entropia
```
Os `uid()` usados para IDs internos (eventos, parcelas, etc.) são OK — não são segredos.

---

#### P1-D · Saída da IA injetada com `innerHTML`

**Arquivo:** `app/kelvn.html`, linhas ~3851, 3940, 3949

```javascript
txtEl.innerHTML = msg; // msg = data.content[0].text da Anthropic
```

Saída de LLM é conteúdo não confiável para o DOM. Se a IA emitir marcação HTML (por conta própria ou induzida por dados de cliente no prompt — prompt injection), executa na sessão autenticada do fotógrafo.

**Fix:**
```javascript
// Opção 1 — simples, se não precisar de formatação HTML:
txtEl.textContent = msg;

// Opção 2 — se precisar renderizar markdown/HTML da IA:
// Sanitizar com DOMPurify antes de injetar:
txtEl.innerHTML = DOMPurify.sanitize(msg);
```

---

### P2 — Hardening

#### P2-A · Zero headers de segurança no `vercel.json`

Sem CSP, HSTS, `X-Frame-Options` (clickjacking), `X-Content-Type-Options`, `Referrer-Policy`. Uma CSP seria a rede de proteção que reduz o dano dos XSS acima.

**Fix:** Adicionar bloco `headers` no `vercel.json`:
```json
{
  "headers": [
    {
      "source": "/(.*)",
      "headers": [
        { "key": "X-Content-Type-Options", "value": "nosniff" },
        { "key": "X-Frame-Options", "value": "DENY" },
        { "key": "Referrer-Policy", "value": "strict-origin-when-cross-origin" },
        { "key": "Permissions-Policy", "value": "camera=(), microphone=(), geolocation=()" },
        {
          "key": "Content-Security-Policy",
          "value": "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://fonts.googleapis.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data: https:; connect-src 'self' https://*.supabase.co wss://*.supabase.co https://api.anthropic.com; object-src 'none'; base-uri 'self';"
        }
      ]
    }
  ]
}
```
> Nota: `unsafe-inline` é necessário porque o app usa scripts e estilos inline. Ainda assim, `object-src 'none'` e `base-uri 'self'` já cortam vetores importantes.

---

#### P2-B · `favoritos.save` permite adulterar seleções de qualquer galeria

Sem validar dono ou existência do slug, dá pra sobrescrever (ou zerar) a seleção de fotos de qualquer convidado e escrever lixo em massa na tabela. Ver fix em P1-B.

---

#### P2-C · `contrato-pdf` aberto (CORS `*`, sem auth)

Mesmo após rotacionar o token (P0-C), o endpoint aceita HTML de qualquer pessoa e gera PDF na conta Browserless. Adicionar auth igual ao ai-proxy (P1-A).

---

### P3 — Backlog

- **MFA na conta do Jeff.** O e-mail `jeffmunchowweddings@gmail.com` está exposto no JS (`isAdmin()`). Liga MFA imediatamente. Nunca use `isAdmin()` para gate de ação real — só para demo.
- **`newsletter-unsubscribe` por uid não assinado.** Assinar o `uid` com HMAC para evitar que terceiros descadastrem membros arbitrários.
- **Sem lockfile.** Adicionar `package-lock.json` (rodar `npm install` no repo e commitar). Builds não-determinísticos com `^` nas dependências.

---

## 4. Verificação pendente (requer query no Supabase)

Só `contratos.sql` e `galerias.sql` estão versionados. A RLS das outras tabelas vive apenas no Supabase. Rodar a query abaixo no SQL Editor para auditar:

```sql
SELECT
  t.schemaname,
  t.tablename,
  t.rowsecurity AS rls_habilitada,
  count(p.policyname) AS total_politicas,
  string_agg(p.policyname, ', ' ORDER BY p.policyname) AS politicas
FROM pg_tables t
LEFT JOIN pg_policies p
  ON t.schemaname = p.schemaname AND t.tablename = p.tablename
WHERE t.schemaname = 'public'
GROUP BY t.schemaname, t.tablename, t.rowsecurity
ORDER BY t.tablename;
```

Tabelas a confirmar: `clientes`, `financeiro`, `financeiro_pessoal`, `configuracoes`, `eventos`, `orcamentos`, `profiles`, `newsletter_unsub`, `galeria_favoritos`, `q_form_tokens`, `contratos`, `galerias`.

Esperado: `rls_habilitada = true` e pelo menos 4 políticas com `auth.uid() = user_id` em cada.

---

## 5. Ordem de ataque sugerida

1. **P0-C:** Rotacionar token do Browserless + mover pra env var (5 min).
2. **P0-B:** Fechar o cron do newsletter e parar de vazar e-mails (15 min).
3. **Verificação de RLS** (query acima no Supabase, 5 min).
4. **P0-A:** Stored XSS via favoritos (é o mais complexo — envolve fix no backend e helper de escape no `kelvn.html`).
5. **P1-A/B:** Fechar ai-proxy e favoritos com auth real.
6. **P1-C/D:** token UUID + innerHTML da IA.
7. **P2-A:** Headers de segurança no vercel.json.
8. O restante conforme capacidade.

---

## 6. Princípios de desenvolvimento (segurança)

- CORS não é autenticação. Endpoint com service key sem auth = lógica do código é a única muralha.
- RLS habilitada em TODA tabela — ter política não basta sem `ENABLE ROW LEVEL SECURITY`.
- Token de acesso público: sempre `crypto.randomUUID()`, nunca `Math.random()`.
- Acesso anônimo por token: sempre via função `SECURITY DEFINER` no Postgres, nunca `.eq()` no client.
- Campo de terceiro no DOM: sempre `textContent` ou `esc()`, nunca `innerHTML` direto.
- Segredo já commitado = segredo vazado. Rotacionar imediatamente.

---

*Última atualização: junho/2026 — após segunda rodada de auditoria.*
