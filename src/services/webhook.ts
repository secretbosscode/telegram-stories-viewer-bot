import express from 'express';
import Stripe from 'stripe';
import bodyParser from 'body-parser';
import { addPremiumUser } from './premium-service';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: '2022-11-15' });
const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET!;
const app = express();

app.post('/webhook', bodyParser.raw({ type: 'application/json' }), (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig!, endpointSecret);
  } catch (err) {
    console.error('❌ Webhook Error:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object as Stripe.Checkout.Session;
    const telegramId = session.metadata?.telegram_id;
    const username = session.metadata?.username;
    if (telegramId) {
      addPremiumUser(telegramId, username);
      console.log(`✅ Premium granted to ${telegramId}`);
    }
  }

  res.sendStatus(200);
});

const PORT = process.env.PORT || 33001;
app.listen(PORT, () => {
  console.log(`🚀 Webhook listening on http://localhost:${PORT}/webhook`);
});
