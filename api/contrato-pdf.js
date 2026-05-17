import chromium from '@sparticuz/chromium';
import puppeteer from 'puppeteer-core';

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

  let browser = null;
  const t0 = Date.now();
  try {
    const executablePath = await chromium.executablePath();
    const t1 = Date.now();

    browser = await puppeteer.launch({
      args: [...chromium.args, '--hide-scrollbars', '--disable-web-security', '--no-sandbox'],
      defaultViewport: chromium.defaultViewport,
      executablePath,
      headless: chromium.headless,
      ignoreHTTPSErrors: true,
    });
    const t2 = Date.now();

    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0', timeout: 20000 });
    try { await page.evaluateHandle('document.fonts.ready'); } catch {}
    const t3 = Date.now();

    const pdf = await page.pdf({
      format: 'A4',
      printBackground: true,
      preferCSSPageSize: true,
    });
    const t4 = Date.now();

    console.log(`PDF timings: exec=${t1-t0}ms launch=${t2-t1}ms render=${t3-t2}ms pdf=${t4-t3}ms total=${t4-t0}ms`);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="contrato.pdf"');
    res.setHeader('Content-Length', pdf.length);
    return res.status(200).send(Buffer.from(pdf));
  } catch (error) {
    console.error('PDF generation failed:', error);
    return res.status(500).json({
      error: 'pdf_failed',
      message: error?.message || String(error),
      elapsed_ms: Date.now() - t0,
    });
  } finally {
    if (browser) {
      try { await browser.close(); } catch {}
    }
  }
}
