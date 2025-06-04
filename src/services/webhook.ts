// webhook.ts
import express from 'express';
import Stripe from 'stripe';
import bodyParser from 'body-parser';
import dotenv from 'dotenv';
import { addPremiumUser } from './premium-service';

dotenv.config(); // Load .env variables

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: '2022-11-15',
});

const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET!;
const app = express();

// Stripe requires the raw body to verify webhook signatures
app.post('/webhook', bodyParser.raw({ type: 'application/json' }), (req, res) => {
  const sig = req.headers['stripe-signature'] as string;
  let event: Stripe.Event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
  } catch (err: any) {
    console.error('❌ Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Handle successful payment event
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object as Stripe.Checkout.Session;
    const telegramId = session.metadata?.telegram_id;
    const username = session.metadata?.username;

    if (telegramId) {
      addPremiumUser(telegramId, username);
      console.log(`✅ Premium access granted to Telegram ID: ${telegramId} (${username})`);
    } else {
      console.warn('⚠️ Missing telegram_id in session metadata');
    }
  }

  res.sendStatus(200);
});

// Start webhook server
const PORT = process.env.PORT || 33001;
app.listen(PORT, () => {
  console.log(`🚀 Webhook running on http://localhost:${PORT}/webhook`);
});
