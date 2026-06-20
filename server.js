// =============================================
// InteliBrief — Backend (Node.js + Express)
// Despliega esto en Railway.app (gratis)
// =============================================

import express from 'express';
import cors from 'cors';
import Stripe from 'stripe';
import Anthropic from '@anthropic-ai/sdk';
import { createClient } from '@supabase/supabase-js';

const app = express();

// =============================================
// CONFIGURACIÓN — pon tus claves aquí
// o mejor: como variables de entorno en Railway
// =============================================
const STRIPE_SECRET    = process.env.STRIPE_SECRET_KEY;       // sk_live_...
const STRIPE_WEBHOOK   = process.env.STRIPE_WEBHOOK_SECRET;   // whsec_...
const ANTHROPIC_KEY    = process.env.ANTHROPIC_API_KEY;       // sk-ant-...
const SUPABASE_URL     = process.env.SUPABASE_URL;            // https://xxx.supabase.co
const SUPABASE_KEY     = process.env.SUPABASE_SERVICE_KEY;    // service_role key
const FRONTEND_URL     = process.env.FRONTEND_URL || 'http://localhost:3000';
const PORT             = process.env.PORT || 4000;

const stripe    = new Stripe(STRIPE_SECRET);
const anthropic = new Anthropic({ apiKey: ANTHROPIC_KEY });
const supabase  = createClient(SUPABASE_URL, SUPABASE_KEY);

// Middleware
app.use(cors({ origin: FRONTEND_URL }));
// IMPORTANTE: el webhook de Stripe necesita el body crudo (raw)
app.use('/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());

// =============================================
// HEALTH CHECK
// =============================================
app.get('/', (req, res) => res.json({ status: 'InteliBrief API running ✓' }));

// =============================================
// STRIPE — Crear sesión de checkout
// =============================================
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
      subscription_data: {
        trial_period_days: 14  // 14 días gratis
      }
    });

    res.json({ sessionId: session.id });
  } catch (err) {
    console.error('Checkout error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// =============================================
// STRIPE — Webhook (eventos de pago)
// =============================================
app.post('/webhook', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK);
  } catch (err) {
    console.error('Webhook error:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object;
      const email = session.customer_details?.email;
      const customerId = session.customer;
      const subscriptionId = session.subscription;

      // Guardar suscriptor en Supabase
      await supabase.from('subscribers').upsert({
        email,
        stripe_customer_id: customerId,
        stripe_subscription_id: subscriptionId,
        status: 'trialing',
        plan: session.amount_total > 1000 ? 'pro' : 'basic',
        created_at: new Date().toISOString()
      }, { onConflict: 'email' });

      console.log(`✓ Nuevo suscriptor: ${email}`);
      break;
    }

    case 'invoice.paid': {
      const invoice = event.data.object;
      const customerId = invoice.customer;

      await supabase.from('subscribers')
        .update({ status: 'active', last_payment: new Date().toISOString() })
        .eq('stripe_customer_id', customerId);

      console.log(`✓ Pago recibido: cliente ${customerId}`);
      break;
    }

    case 'customer.subscription.deleted': {
      const sub = event.data.object;

      await supabase.from('subscribers')
        .update({ status: 'cancelled' })
        .eq('stripe_subscription_id', sub.id);

      console.log(`✗ Suscripción cancelada: ${sub.id}`);
      break;
    }
  }

  res.json({ received: true });
});

// =============================================
// STATS — Para mostrar en la web
// =============================================
app.get('/stats', async (req, res) => {
  try {
    const { count: subscribers } = await supabase
      .from('subscribers')
      .select('*', { count: 'exact', head: true })
      .eq('status', 'active');

    const { count: articles } = await supabase
      .from('articles')
      .select('*', { count: 'exact', head: true });

    res.json({ subscribers: subscribers || 0, articles: articles || 0 });
  } catch (err) {
    res.json({ subscribers: 0, articles: 0 });
  }
});

// =============================================
// ARTÍCULOS — Obtener lista
// =============================================
app.get('/articles', async (req, res) => {
  try {
    const { data } = await supabase
      .from('articles')
      .select('id, title, excerpt, free, created_at')
      .order('created_at', { ascending: false })
      .limit(20);

    res.json({ articles: data || [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// =============================================
// ARTÍCULOS — Obtener uno (verificar suscripción)
// =============================================
app.get('/articles/:id', async (req, res) => {
  try {
    const { data: article } = await supabase
      .from('articles')
      .select('*')
      .eq('id', req.params.id)
      .single();

    if (!article) return res.status(404).json({ error: 'No encontrado' });

    // Si es de pago, verificar token
    if (!article.free) {
      const token = req.headers.authorization?.replace('Bearer ', '');
      if (!token) return res.status(401).json({ error: 'Se requiere suscripción' });

      const { data: sub } = await supabase
        .from('subscribers')
        .select('status')
        .eq('access_token', token)
        .single();

      if (!sub || !['active', 'trialing'].includes(sub.status)) {
        return res.status(403).json({ error: 'Suscripción inactiva' });
      }
    }

    res.json({ article });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// =============================================
// GENERACIÓN — Crear artículo con IA (protegido)
// Este endpoint lo llama el script automático
// =============================================
app.post('/generate-article', async (req, res) => {
  const adminKey = req.headers['x-admin-key'];
  if (adminKey !== process.env.ADMIN_KEY) {
    return res.status(401).json({ error: 'No autorizado' });
  }

  try {
    const topics = [
      'las últimas novedades en modelos de lenguaje grandes (LLMs) y cómo afectan al usuario común',
      'herramientas de inteligencia artificial gratuitas o de bajo coste para productividad personal',
      'cómo las empresas están adoptando la IA y qué significa para los trabajadores',
      'los avances más recientes en IA generativa para imágenes, vídeo y audio',
      'aplicaciones prácticas de la IA en educación, salud y creatividad',
      'comparativa de los asistentes de IA más populares en español',
      'cómo proteger tu privacidad al usar herramientas de inteligencia artificial',
      'el impacto económico de la IA: quién gana y quién pierde',
      'tutoriales básicos de prompt engineering para usuarios no técnicos',
      'noticias de la semana en el mundo de la IA explicadas en 5 minutos'
    ];

    const topic = topics[Math.floor(Math.random() * topics.length)];
    const isFree = Math.random() > 0.6; // 40% gratis, 60% Pro

    const prompt = `Escribe un artículo periodístico de alta calidad en español sobre: ${topic}.

Requisitos:
- Entre 400 y 600 palabras
- Tono informativo, claro y cercano, sin tecnicismos innecesarios
- Estructura: introducción llamativa, desarrollo con 3-4 puntos clave, conclusión práctica
- Incluye datos o ejemplos concretos cuando sea posible
- Escribe en texto plano sin asteriscos, sin markdown, sin hashtags
- Párrafos de 3-5 líneas separados por saltos de línea
- El título debe ser atractivo y descriptivo (incluye "TÍTULO:" al principio)

Empieza directamente con TÍTULO: seguido del título, luego EXTRACTO: seguido de una frase resumen de 15 palabras, luego el artículo completo.`;

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1200,
      messages: [{ role: 'user', content: prompt }]
    });

    const fullText = response.content[0].text;

    // Parsear título y extracto
    const titleMatch = fullText.match(/TÍTULO:\s*(.+)/);
    const excerptMatch = fullText.match(/EXTRACTO:\s*(.+)/);
    const bodyStart = fullText.indexOf('\n', fullText.indexOf('EXTRACTO:')) + 1;
    const body = fullText.slice(bodyStart).trim();

    const title   = titleMatch?.[1]?.trim() || 'Artículo de IA';
    const excerpt = excerptMatch?.[1]?.trim() || body.slice(0, 120) + '...';

    // Guardar en Supabase
    const { data: saved, error } = await supabase.from('articles').insert({
      title,
      excerpt,
      body,
      free: isFree,
      topic,
      created_at: new Date().toISOString()
    }).select().single();

    if (error) throw error;

    console.log(`✓ Artículo generado: "${title}" (${isFree ? 'gratis' : 'Pro'})`);
    res.json({ success: true, article: saved });

  } catch (err) {
    console.error('Generation error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => console.log(`✓ InteliBrief API en puerto ${PORT}`));
