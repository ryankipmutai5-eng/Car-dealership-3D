// billing.js
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY || 'sk_test_placeholder');

async function billingRoutes(fastify, options) {
  
  // POST /billing/create-checkout-session
  // Tenant initiates a subscription
  fastify.post('/billing/create-checkout-session', async (request, reply) => {
    const tenantId = request.headers['x-tenant-id'];
    if (!tenantId) return reply.code(400).send({ error: 'X-Tenant-ID required' });

    const { tier } = request.body; // 'basic', 'pro'
    if (!['basic', 'pro'].includes(tier)) {
      return reply.code(400).send({ error: 'Invalid tier' });
    }

    // 1. Get tenant info
    // Note: We use fastify.pg directly here as we are doing a tenant-specific lookup by ID
    const { rows } = await fastify.pg.query('SELECT * FROM tenants WHERE id = $1', [tenantId]);
    const tenant = rows[0];
    if (!tenant) return reply.code(404).send({ error: 'Tenant not found' });

    // 2. Map tier to Stripe Price ID (using placeholder for now)
    // In a real app, these would come from env or config
    const priceMap = {
      'basic': process.env.STRIPE_PRICE_BASIC || 'price_basic_placeholder',
      'pro': process.env.STRIPE_PRICE_PRO || 'price_pro_placeholder'
    };
    const priceId = priceMap[tier];

    // 3. Create Stripe Checkout Session
    try {
      if (process.env.STRIPE_SECRET_KEY && process.env.STRIPE_SECRET_KEY !== 'sk_test_placeholder') {
        const session = await stripe.checkout.sessions.create({
          payment_method_types: ['card'],
          line_items: [{
            price: priceId,
            quantity: 1,
          }],
          mode: 'subscription',
          success_url: `${request.headers.origin || 'http://localhost:3000'}/success?session_id={CHECKOUT_SESSION_ID}`,
          cancel_url: `${request.headers.origin || 'http://localhost:3000'}/cancel`,
          customer: tenant.stripe_customer_id.startsWith('mock_') ? undefined : tenant.stripe_customer_id,
          customer_email: tenant.stripe_customer_id ? undefined : `billing+${tenant.slug}@vroom3d.com`,
          metadata: {
            tenant_id: tenantId,
            tier: tier
          }
        });
        return { url: session.url };
      } else {
        fastify.log.warn('Using mock Checkout Session URL due to missing/placeholder key');
        return { url: `http://localhost:3000/mock-checkout?tenant_id=${tenantId}&tier=${tier}` };
      }
    } catch (err) {
      fastify.log.error(err);
      return reply.code(500).send({ error: 'Failed to create checkout session' });
    }
  });

  // POST /billing/webhook
  // Stripe webhooks to update tenant status
  fastify.post('/billing/webhook', { config: { rawBody: true } }, async (request, reply) => {
    const sig = request.headers['stripe-signature'];
    let event;

    try {
      if (process.env.STRIPE_WEBHOOK_SECRET && process.env.STRIPE_WEBHOOK_SECRET !== 'whsec_placeholder') {
        event = stripe.webhooks.constructEvent(request.rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET);
      } else {
        fastify.log.warn('Skipping webhook signature verification due to missing/placeholder secret');
        event = request.body; // Use parsed body directly
      }
    } catch (err) {
      fastify.log.error(`Webhook signature verification failed: ${err.message}`);
      return reply.code(400).send(`Webhook Error: ${err.message}`);
    }

    // Handle the event
    try {
      switch (event.type) {
        case 'checkout.session.completed':
          const session = event.data.object;
          await handleCheckoutSessionCompleted(session);
          break;
        case 'customer.subscription.updated':
        case 'customer.subscription.deleted':
          const subscription = event.data.object;
          await handleSubscriptionChange(subscription);
          break;
        default:
          fastify.log.info(`Unhandled event type ${event.type}`);
      }
    } catch (err) {
      fastify.log.error(`Error handling webhook ${event.type}: ${err.message}`);
      return reply.code(500).send('Internal Server Error');
    }

    return { received: true };
  });

  async function handleCheckoutSessionCompleted(session) {
    const tenantId = session.metadata.tenant_id;
    const tier = session.metadata.tier;
    const stripeCustomerId = session.customer;
    const stripeSubscriptionId = session.subscription;

    await fastify.pg.query(
      `UPDATE tenants SET 
        stripe_customer_id = $1, 
        stripe_subscription_id = $2, 
        subscription_tier = $3, 
        subscription_status = 'active' 
      WHERE id = $4`,
      [stripeCustomerId, stripeSubscriptionId, tier, tenantId]
    );
  }

  async function handleSubscriptionChange(subscription) {
    const stripeSubscriptionId = subscription.id;
    const status = subscription.status; // 'active', 'past_due', 'canceled', etc.
    
    await fastify.pg.query(
      `UPDATE tenants SET subscription_status = $1 WHERE stripe_subscription_id = $2`,
      [status, stripeSubscriptionId]
    );
  }
}

module.exports = billingRoutes;
