import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY!
);

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).send('Method not allowed');
  }

  try {
    const { event_type, event_category, surface, session_id, metadata } = req.body;

    const metaStr = JSON.stringify(metadata || {});
    if (metaStr.includes('api_key') || metaStr.includes('amount') ||
        metaStr.includes('balance') || metaStr.includes('sk-') ||
        metaStr.includes('0x')) {
      return res.status(400).send('Rejected: sensitive data in metadata');
    }

    await supabase.from('events').insert({
      event_type: event_type || 'unknown',
      event_category: event_category || null,
      surface: surface || 'unknown',
      session_id: session_id || null,
      metadata: metadata || {}
    });

    return res.status(200).send('OK');
  } catch (e) {
    return res.status(500).send('Error');
  }
}
