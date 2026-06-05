const fastify = require('fastify')({ logger: true });
const { parse } = require('csv-parse');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY || 'sk_test_placeholder');

// Register PostgreSQL
fastify.register(require('@fastify/postgres'), {
  connectionString: 'postgres://vroom3d_app:password@localhost/vroom3d'
});

// Register Raw Body for Stripe Webhooks
fastify.register(require('fastify-raw-body'), {
    field: 'rawBody',
    global: false,
    encoding: 'utf8',
    runFirst: true,
});

// Register Multipart for file uploads
fastify.register(require('@fastify/multipart'), {
    limits: {
        fileSize: 50 * 1024 * 1024 // 50MB
    }
});

// Register Asset Routes
fastify.register(require('./assets'));

// Register Billing Routes
fastify.register(require('./billing'));

// Register Photogrammetry Routes
fastify.register(require('./photogrammetry'));

// Register Lead Routes
fastify.register(require('./leads'));

// Register Analytics Routes
fastify.register(require('./analytics'));

// Tenant Resolution Middleware
fastify.addHook('preHandler', async (request, reply) => {
  const tenantId = request.headers['x-tenant-id'];
  if (tenantId) {
    request.tenantId = tenantId;
  }
});

// Helper to execute query with tenant context
fastify.decorate('queryWithTenant', async function (request, query, params = []) {
  const client = await this.pg.connect();
  try {
    if (request.tenantId) {
      await client.query(`SELECT set_config($1, $2, $3)`, ['app.current_tenant_id', request.tenantId, false]);
    }
    const result = await client.query(query, params);
    return result.rows;
  } catch (err) {
      request.log.error(err);
      throw err;
  } finally {
    client.release();
  }
});

// --- Routes ---

// 1. Tenants (Global)
fastify.get('/tenants', async (request, reply) => {
    const result = await fastify.pg.query('SELECT * FROM tenants');
    return result.rows;
});

fastify.post('/tenants', async (request, reply) => {
    const { name, slug } = request.body;

    try {
      let stripeCustomerId = 'mock_cus_' + slug;

      // Create Stripe Customer (only if not a placeholder key)
      if (process.env.STRIPE_SECRET_KEY && process.env.STRIPE_SECRET_KEY !== 'sk_test_placeholder') {
        const customer = await stripe.customers.create({
          name: name,
          metadata: { slug: slug }
        });
        stripeCustomerId = customer.id;
      } else {
        fastify.log.warn('Using mock Stripe Customer ID due to missing/placeholder key');
      }

      const result = await fastify.pg.query(
          'INSERT INTO tenants (name, slug, stripe_customer_id) VALUES ($1, $2, $3) RETURNING *',
          [name, slug, stripeCustomerId]
      );
      return result.rows[0];
    } catch (err) {
      fastify.log.error(err);
      return reply.code(500).send({ error: 'Failed to create tenant' });
    }
});

// 2. Car Models
fastify.get('/cars', async (request, reply) => {
    if (!request.tenantId) return reply.status(400).send({ error: 'X-Tenant-ID header required' });
    return await fastify.queryWithTenant(request, 'SELECT * FROM car_models');
});

fastify.post('/cars', async (request, reply) => {
    if (!request.tenantId) return reply.status(400).send({ error: 'X-Tenant-ID header required' });
    const { make, model, year, gltf_url } = request.body;
    const rows = await fastify.queryWithTenant(
        request,
        'INSERT INTO car_models (tenant_id, make, model, year, gltf_url) VALUES ($1, $2, $3, $4, $5) RETURNING *',
        [request.tenantId, make, model, year, gltf_url]
    );
    return rows[0];
});

// 3. Trims
fastify.get('/trims', async (request, reply) => {
    if (!request.tenantId) return reply.status(400).send({ error: 'X-Tenant-ID header required' });
    return await fastify.queryWithTenant(request, 'SELECT * FROM trims');
});

fastify.post('/trims', async (request, reply) => {
    if (!request.tenantId) return reply.status(400).send({ error: 'X-Tenant-ID header required' });
    const { car_model_id, name, base_price } = request.body;
    const rows = await fastify.queryWithTenant(
        request,
        'INSERT INTO trims (tenant_id, car_model_id, name, base_price) VALUES ($1, $2, $3, $4) RETURNING *',
        [request.tenantId, car_model_id, name, base_price]
    );
    return rows[0];
});

// 4. Packages
fastify.get('/packages', async (request, reply) => {
    if (!request.tenantId) return reply.status(400).send({ error: 'X-Tenant-ID header required' });
    return await fastify.queryWithTenant(request, 'SELECT * FROM packages');
});

fastify.post('/packages', async (request, reply) => {
    if (!request.tenantId) return reply.status(400).send({ error: 'X-Tenant-ID header required' });
    const { car_model_id, name, description, price } = request.body;
    const rows = await fastify.queryWithTenant(
        request,
        'INSERT INTO packages (tenant_id, car_model_id, name, description, price) VALUES ($1, $2, $3, $4, $5) RETURNING *',
        [request.tenantId, car_model_id, name, description, price]
    );
    return rows[0];
});

// 5. Inventory Units
fastify.get('/inventory', async (request, reply) => {
    if (!request.tenantId) return reply.status(400).send({ error: 'X-Tenant-ID header required' });
    return await fastify.queryWithTenant(request, 'SELECT * FROM inventory_units');
});

fastify.post('/inventory', async (request, reply) => {
    if (!request.tenantId) return reply.status(400).send({ error: 'X-Tenant-ID header required' });
    const { car_model_id, trim_id, vin, stock_number, color_exterior, color_interior, mileage, price, status, splat_url } = request.body;
    const rows = await fastify.queryWithTenant(
        request,
        `INSERT INTO inventory_units
         (tenant_id, car_model_id, trim_id, vin, stock_number, color_exterior, color_interior, mileage, price, status, splat_url)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, COALESCE($10, 'on_lot'), $11) RETURNING *`,
        [request.tenantId, car_model_id, trim_id, vin, stock_number, color_exterior, color_interior, mileage, price, status, splat_url]
    );
    return rows[0];
});

// 6. DMS Sync (CSV Skeleton)
fastify.post('/sync/csv', async (request, reply) => {
    if (!request.tenantId) return reply.status(400).send({ error: 'X-Tenant-ID header required' });
    
    const data = await request.file();
    if (!data) return reply.status(400).send({ error: 'No file uploaded' });

    const results = [];
    const parser = data.file.pipe(parse({
        columns: true,
        skip_empty_lines: true
    }));

    for await (const record of parser) {
        // Simple mapping from CSV to DB
        // Expecting columns: make, model, year, vin, price, mileage, color_exterior
        try {
            // 1. Find or create car model
            let carModel = (await fastify.queryWithTenant(request, 
                'SELECT id FROM car_models WHERE make = $1 AND model = $2 AND year = $3', 
                [record.make, record.model, parseInt(record.year)])
            )[0];

            if (!carModel) {
                carModel = (await fastify.queryWithTenant(request,
                    'INSERT INTO car_models (tenant_id, make, model, year) VALUES ($1, $2, $3, $4) RETURNING id',
                    [request.tenantId, record.make, record.model, parseInt(record.year)])
                )[0];
            }

            // 2. Insert or update inventory unit
            const inventoryUnit = await fastify.queryWithTenant(request,
                `INSERT INTO inventory_units (tenant_id, car_model_id, vin, price, mileage, color_exterior, status)
                 VALUES ($1, $2, $3, $4, $5, $6, 'on_lot')
                 ON CONFLICT (tenant_id, vin) DO UPDATE SET
                 price = EXCLUDED.price, mileage = EXCLUDED.mileage, color_exterior = EXCLUDED.color_exterior
                 RETURNING *`,
                [request.tenantId, carModel.id, record.vin, parseFloat(record.price), parseInt(record.mileage), record.color_exterior]
            );
            results.push({ vin: record.vin, status: 'synced' });
        } catch (err) {
            results.push({ vin: record.vin, status: 'error', error: err.message });
        }
    }

    return { processed: results.length, details: results };
});

// 7. Branding
fastify.get('/tenants/me/branding', async (request, reply) => {
    if (!request.tenantId) return reply.status(400).send({ error: 'X-Tenant-ID header required' });
    const rows = await fastify.queryWithTenant(request, 'SELECT * FROM tenant_branding WHERE tenant_id = $1', [request.tenantId]);
    return rows[0] || {};
});

fastify.post('/tenants/me/branding', async (request, reply) => {
    if (!request.tenantId) return reply.status(400).send({ error: 'X-Tenant-ID header required' });
    const { primary_color, accent_color, logo_url, custom_css, allowed_domains } = request.body;

    const rows = await fastify.queryWithTenant(
        request,
        `INSERT INTO tenant_branding (tenant_id, primary_color, accent_color, logo_url, custom_css, allowed_domains)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (tenant_id) DO UPDATE SET
         primary_color = COALESCE(EXCLUDED.primary_color, tenant_branding.primary_color),
         accent_color = COALESCE(EXCLUDED.accent_color, tenant_branding.accent_color),
         logo_url = COALESCE(EXCLUDED.logo_url, tenant_branding.logo_url),
         custom_css = COALESCE(EXCLUDED.custom_css, tenant_branding.custom_css),
         allowed_domains = COALESCE(EXCLUDED.allowed_domains, tenant_branding.allowed_domains),
         updated_at = CURRENT_TIMESTAMP
         RETURNING *`,
        [request.tenantId, primary_color, accent_color, logo_url, custom_css, allowed_domains]
    );
    return rows[0];
});

const start = async () => {
  try {
    await fastify.listen({ port: 3000, host: '0.0.0.0' });
    console.log('Server listening on http://0.0.0.0:3000');
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};
start();
