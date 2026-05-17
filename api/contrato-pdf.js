export const config = {
  api: { bodyParser: { sizeLimit: '4mb' } },
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { return res.status(400).json({ error: 'Invalid JSON' }); }
  }
  const html = body?.html;
  if (!html) return res.status(400).json({ error: 'html required' });

  const apiKey = process.env.PDFSHIFT_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'config', message: 'PDFSHIFT_API_KEY not set' });
  }

  try {
    const resp = await fetch('https://api.pdfshift.io/v3/convert/pdf', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Basic ' + Buffer.from('api:' + apiKey).toString('base64'),
      },
      body: JSON.stringify({
        source: html,
        format: 'A4',
        margin: '0',
        use_print: false,
        sandbox: false,
      }),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      console.error('PDFShift error:', resp.status, errText);
      return res.status(resp.status).json({ error: 'pdfshift_failed', status: resp.status, message: errText.slice(0, 500) });
    }

    const buf = Buffer.from(await resp.arrayBuffer());
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="contrato.pdf"');
    res.setHeader('Content-Length', buf.length);
    return res.status(200).send(buf);
  } catch (error) {
    console.error('PDF generation failed:', error);
    return res.status(500).json({ error: 'pdf_failed', message: error?.message || String(error) });
  }
}
