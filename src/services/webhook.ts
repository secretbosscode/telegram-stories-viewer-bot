import express from 'express';
import Stripe from 'stripe';
import bodyParser from 'body-parser';
import dotenv from 'dotenv';
import { addPremiumUser } from './premium-service';

dotenv.config(); // Load env variables

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: '2022-11-15',
});

const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET!;
const app = express();

// Stripe requires raw body for signature verification
app.post('/webhook', bodyParser.raw({ type: 'application/json' }), (req, res) => {
  const sig = req.headers['stripe-signature'] as string;
  let event: Stripe.Event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
  } catch (err: any) {
    console.error('❌ Webhook Error:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Handle successful payment
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object as Stripe.Checkout.Session;
    const telegramId = session.metadata?.telegram_id;
    const username = session.metadata?.username;
    if (telegramId) {
      addPremiumUser(Number(telegramId)); // convert to number
      console.log(`✅ Premium granted to Telegram ID: ${telegramId} (${username})`);
    } else {
      console.warn('⚠️ Missing telegram_id in metadata.');
    }
  }

  res.sendStatus(200);
});

// Start webhook listener
const PORT = process.env.PORT || 33001;
app.listen(PORT, () => {
  console.log(`🚀 Webhook listening at http://localhost:${PORT}/webhook`);
});
