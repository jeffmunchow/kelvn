import { createClient } from '@supabase/supabase-js';

const BROWSERLESS_TOKEN = process.env.BROWSERLESS_TOKEN;

export const config = {
  api: { bodyParser: { sizeLimit: '4mb' } },
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://app.kelvn.com.br');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Apenas fotógrafos autenticados podem gerar PDFs — sem auth qualquer um
  // consumiria os créditos do Browserless e enviaria HTML arbitrário.
  const token = req.headers.authorization?.split('Bearer ')[1];
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  const { data: { user }, error: authError } = await supabase.auth.getUser(token);
  if (authError || !user) return res.status(401).json({ error: 'Unauthorized' });

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { return res.status(400).json({ error: 'Invalid JSON' }); }
  }
  const html = body?.html;
  if (!html) return res.status(400).json({ error: 'html required' });

  const t0 = Date.now();
  try {
    const response = await fetch(
      `https://chrome.browserless.io/pdf?token=${BROWSERLESS_TOKEN}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          html,
          options: {
            format: 'A4',
            printBackground: true,
            preferCSSPageSize: true,
          },
        }),
      }
    );

    if (!response.ok) {
      const errText = await response.text();
      console.error('Browserless error:', response.status, errText);
      return res.status(500).json({
        error: 'pdf_failed',
        message: `Browserless ${response.status}: ${errText.slice(0, 200)}`,
        elapsed_ms: Date.now() - t0,
      });
    }

    const pdf = Buffer.from(await response.arrayBuffer());
    console.log(`PDF generated in ${Date.now() - t0}ms, size=${pdf.length}`);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="contrato.pdf"');
    res.setHeader('Content-Length', pdf.length);
    return res.status(200).send(pdf);
  } catch (error) {
    console.error('PDF generation failed:', error);
    return res.status(500).json({
      error: 'pdf_failed',
      message: error?.message || String(error),
      elapsed_ms: Date.now() - t0,
    });
  }
}
