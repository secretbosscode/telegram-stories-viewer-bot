import express from 'express';
import Stripe from 'stripe';
import bodyParser from 'body-parser';
// import { addPremiumUser } from './premium-service'; // Assuming this import path is correct

dotenv.config(); // Load .env variables

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: '2025-05-28.basil', // CHANGED LINE HERE
});

const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET!;

const app = express(); // Initialize Express app

// Stripe webhook endpoint
app.post('/webhook', bodyParser.raw({ type: 'application/json' }), (req, res) => {
  const sig = req.headers['stripe-signature'] as string;
  let event: Stripe.Event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
  } catch (err: any) {
    console.error('❌ Webhook signature verification failed:', err.message);
    res.status(400).send(`Webhook Error: ${err.message}`);
    return;
  }

  // Handle successful payment event
  // ... (rest of your event handling logic)
  res.json({ received: true }); // Acknowledge receipt of the event
});

// You'll likely need to listen on a port:
// const PORT = process.env.PORT || 3000;
// app.listen(PORT, () => console.log(`Stripe webhook server listening on port ${PORT}`));
