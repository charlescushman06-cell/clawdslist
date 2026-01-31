import { createClientFromRequest } from 'npm:@base44/sdk@0.8.6';

// TODO: Implement HMAC signature verification after basic connectivity confirmed
// Uncomment and set TATUM_WEBHOOK_SECRET env var to enable
// async function verifyTatumSignature(req, bodyText) {
//   const signature = req.headers.get('x-payload-hash');
//   const secret = Deno.env.get('TATUM_WEBHOOK_SECRET');
//   if (!secret || !signature) return false;
//   const encoder = new TextEncoder();
//   const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-512' }, false, ['sign']);
//   const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(bodyText));
//   const computed = Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
//   return computed === signature;
// }

Deno.serve(async (req) => {
  // Only allow POST
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { 
      status: 405,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  let rawPayload;
  let bodyText;
  
  try {
    bodyText = await req.text();
    rawPayload = JSON.parse(bodyText);
  } catch (err) {
    console.error('Failed to parse JSON:', err);
    return Response.json({ ok: true, error: 'Invalid JSON' }, { status: 200 });
  }

  // TODO: Enable signature verification after connectivity confirmed
  // if (!verifyTatumSignature(req, bodyText)) {
  //   console.warn('Invalid Tatum signature');
  //   return Response.json({ ok: false, error: 'Invalid signature' }, { status: 401 });
  // }

  // Log event asynchronously, respond immediately
  const base44 = createClientFromRequest(req);
  
  try {
    await base44.asServiceRole.entities.Event.create({
      event_type: rawPayload.type || 'unknown',
      entity_type: 'system',
      entity_id: rawPayload.subscriptionId || rawPayload.id || null,
      actor_type: 'system',
      actor_id: 'tatum',
      details: JSON.stringify({
        source: 'tatum',
        raw_payload: rawPayload,
        received_at: new Date().toISOString()
      })
    });
    console.log('Tatum webhook logged:', rawPayload.type || 'unknown');
  } catch (err) {
    console.error('Failed to log event:', err);
  }

  return Response.json({ ok: true }, { status: 200 });
});