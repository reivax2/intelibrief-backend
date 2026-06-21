import express from 'express';
import cors from 'cors';
import Stripe from 'stripe';
import Anthropic from '@anthropic-ai/sdk';
import { createClient } from '@supabase/supabase-js';

const app = express();

const STRIPE_SECRET    = process.env.STRIPE_SECRET_KEY;
const STRIPE_WEBHOOK   = process.env.STRIPE_WEBHOOK_SECRET;
const ANTHROPIC_KEY    = process.env.ANTHROPIC_API_KEY;
const SUPABASE_URL     = process.env.SUPABASE_URL;
const SUPABASE_KEY     = process.env.SUPABASE_SERVICE_KEY;
const FRONTEND_URL     = process.env.FRONTEND_URL || 'http://localhost:3000';
const PORT             = process.env.PORT || 4000;

const stripe    = new Stripe(STRIPE_SECRET);
const anthropic = new Anthropic({ apiKey: ANTHROPIC_KEY });
const supabase  = createClient(SUPABASE_URL, SUPABASE_KEY);

app.use(cors({ origin: FRONTEND_URL }));
app.use('/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());

// HEALTH CHECK
app.get('/', (req, res) => res.json({ status: 'InteliBrief API running ✓' }));

// NUEVO ENDPOINT — genera artículo desde el frontend
app.post('/article', async (req, res) => {
  try {
    const { prompt } = req.body;
    if (!prompt) return res.status(400).json({ error: 'Falta el prompt' });

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1000,
      messages: [{ role: 'user', content: prompt }]
    });

    const text = response.content?.map(b => b.text || '').join('') || '';
    res.json({ text });
  } catch (err) {
    console.error('Article error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// STRIPE — Crear sesión de checkout
app.post('/create-checkout', async (req, res) => {
  try {
    const { priceId } = req.body;
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${FRONTEND_URL}?success=true&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url:  `${FRONTEND_URL}?cancelled=true`,
      allow_promotion_codes: true,
      subscription_data: { trial_period_days: 14 }
    });
    res.json({ sessionId: session.id });
  } catch (err) {
    console.error('Checkout error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// STRIPE — Webhook
app.post('/webhook', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK);
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object;
      const email = session.customer_details?.email;
      const customerId = session.customer;
      const subscriptionId = session.subscription;
      await supabase.from('subscribers').upsert({
        email, stripe_customer_id: customerId,
        stripe_subscription_id: subscriptionId,
        status: 'trialing',
        plan: session.amount_total > 1000 ? 'pro' : 'basic',
        created_at: new Date().toISOString()
      }, { onConflict: 'email' });
      break;
    }
    case 'invoice.paid': {
      const invoice = event.data.object;
      await supabase.from('subscribers')
        .update({ status: 'active', last_payment: new Date().toISOString() })
        .eq('stripe_customer_id', invoice.customer);
      break;
    }
    case 'customer.subscription.deleted': {
      const sub = event.data.object;
      await supabase.from('subscribers')
        .update({ status: 'cancelled' })
        .eq('stripe_subscription_id', sub.id);
      break;
    }
  }
  res.json({ received: true });
});

// GENERAR ARTÍCULO automático (cron job)
app.post('/generate-article', async (req, res) => {
  const adminKey = req.headers['x-admin-key'];
  if (adminKey !== process.env.ADMIN_KEY) {
    return res.status(401).json({ error: 'No autorizado' });
  }

  try {
    const topics = [
      'las últimas novedades en modelos de lenguaje IA en 2026 y cómo afectan al usuario medio',
      'herramientas de inteligencia artificial gratuitas para productividad personal en 2026',
      'cómo ganar dinero con inteligencia artificial desde casa en 2026',
      'comparativa de los mejores asistentes de IA disponibles en español en 2026',
      'cómo proteger tu privacidad al usar herramientas de inteligencia artificial',
      'agentes de IA: qué son y cómo van a cambiar el trabajo en 2026',
      'IA generativa para creativos: imágenes, vídeo y audio gratuitos',
      'el impacto de la IA en el empleo: quién gana y quién pierde',
      'cómo usar la IA para resumir reuniones y tomar notas automáticamente',
      'informe semanal: los movimientos más importantes en IA esta semana'
    ];

    const topic = topics[Math.floor(Math.random() * topics.length)];
    const isFree = Math.random() > 0.6;

    const prompt = `Escribe un artículo periodístico de 400 palabras en español sobre: ${topic}.
Tono claro, directo y sin tecnicismos. Párrafos cortos.
Empieza con TÍTULO: seguido del título, luego EXTRACTO: seguido de un resumen de 15 palabras, luego el artículo completo.
Sin asteriscos ni markdown, solo texto plano.`;

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1200,
      messages: [{ role: 'user', content: prompt }]
    });

    const fullText = response.content[0].text;
    const titleMatch = fullText.match(/TÍTULO:\s*(.+)/);
    const excerptMatch = fullText.match(/EXTRACTO:\s*(.+)/);
    const bodyStart = fullText.indexOf('\n', fullText.indexOf('EXTRACTO:')) + 1;
    const body = fullText.slice(bodyStart).trim();
    const title = titleMatch?.[1]?.trim() || 'Artículo de IA';
    const excerpt = excerptMatch?.[1]?.trim() || body.slice(0, 120) + '...';

    const { data: saved, error } = await supabase.from('articles').insert({
      title, excerpt, body, free: isFree, topic,
      created_at: new Date().toISOString()
    }).select().single();

    if (error) throw error;

    console.log(`✓ Artículo generado: "${title}"`);
    res.json({ success: true, article: saved });
  } catch (err) {
    console.error('Generation error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => console.log(`✓ API en puerto ${PORT}`));
