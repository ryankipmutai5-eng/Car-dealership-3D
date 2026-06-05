const axios = require('axios');

module.exports = async function (fastify, opts) {
  // 1. Capture a new lead (from the widget)
  fastify.post('/api/leads', async (request, reply) => {
    // The widget must provide the tenant ID. 
    if (!request.tenantId) return reply.status(400).send({ error: 'X-Tenant-ID header required' });
    
    // Security: Verify the request origin matches allowed domains for this tenant
    const origin = request.headers.origin || request.headers.referer;
    if (origin) {
        const brandingRows = await fastify.queryWithTenant(request, 
            'SELECT allowed_domains FROM tenant_branding WHERE tenant_id = $1', 
            [request.tenantId]
        );
        
        if (brandingRows.length > 0) {
            const { allowed_domains } = brandingRows[0];
            // Only enforce if allowed_domains is not empty
            if (allowed_domains && allowed_domains.length > 0) {
                const originUrl = new URL(origin);
                const isAllowed = allowed_domains.some(domain => 
                    originUrl.hostname === domain || originUrl.hostname.endsWith('.' + domain)
                );
                
                if (!isAllowed) {
                    fastify.log.warn(`Unauthorized origin ${originUrl.hostname} for tenant ${request.tenantId}`);
                    return reply.status(403).send({ error: 'Unauthorized origin' });
                }
            }
        }
    }

    const { 
        first_name, 
        last_name, 
        email, 
        phone, 
        inventory_unit_id, 
        configuration, 
        message 
    } = request.body;

    if (!first_name || !last_name || !email) {
        return reply.status(400).send({ error: 'First name, last name, and email are required' });
    }

    const rows = await fastify.queryWithTenant(request,
        `INSERT INTO leads (tenant_id, inventory_unit_id, first_name, last_name, email, phone, configuration, message)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
        [request.tenantId, inventory_unit_id, first_name, last_name, email, phone, configuration, message]
    );

    const lead = rows[0];

    // Trigger async notification and CRM sync
    setImmediate(() => notifyDealer(fastify, lead));

    return { status: 'success', lead_id: lead.id };
  });

  // 2. GET leads for a tenant (dashboard)
  fastify.get('/api/leads', async (request, reply) => {
    if (!request.tenantId) return reply.status(400).send({ error: 'X-Tenant-ID header required' });
    
    // We can join with inventory_units to show which car they are interested in
    const rows = await fastify.queryWithTenant(request,
        `SELECT l.*, iu.vin, iu.stock_number, cm.make, cm.model, cm.year
         FROM leads l
         LEFT JOIN inventory_units iu ON l.inventory_unit_id = iu.id
         LEFT JOIN car_models cm ON iu.car_model_id = cm.id
         ORDER BY l.created_at DESC`
    );
    return rows;
  });

  // 3. GET tenant config (including CRM keys)
  fastify.get('/api/tenant/config', async (request, reply) => {
    if (!request.tenantId) return reply.status(400).send({ error: 'X-Tenant-ID header required' });
    
    const rows = await fastify.queryWithTenant(request,
        'SELECT * FROM tenant_configs WHERE tenant_id = $1',
        [request.tenantId]
    );
    return rows[0] || { tenant_id: request.tenantId, lead_webhook_url: null };
  });

  // 4. POST tenant config (update CRM keys)
  fastify.post('/api/tenant/config', async (request, reply) => {
    if (!request.tenantId) return reply.status(400).send({ error: 'X-Tenant-ID header required' });
    
    const { 
        lead_webhook_url, 
        hubspot_access_token, 
        dealersocket_api_key, 
        dealersocket_dealer_id 
    } = request.body;

    const rows = await fastify.queryWithTenant(request,
        `INSERT INTO tenant_configs (
            tenant_id, 
            lead_webhook_url, 
            hubspot_access_token, 
            dealersocket_api_key, 
            dealersocket_dealer_id
        )
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (tenant_id) DO UPDATE SET
         lead_webhook_url = EXCLUDED.lead_webhook_url,
         hubspot_access_token = COALESCE(EXCLUDED.hubspot_access_token, tenant_configs.hubspot_access_token),
         dealersocket_api_key = COALESCE(EXCLUDED.dealersocket_api_key, tenant_configs.dealersocket_api_key),
         dealersocket_dealer_id = COALESCE(EXCLUDED.dealersocket_dealer_id, tenant_configs.dealersocket_dealer_id),
         updated_at = CURRENT_TIMESTAMP
         RETURNING *`,
        [request.tenantId, lead_webhook_url, hubspot_access_token, dealersocket_api_key, dealersocket_dealer_id]
    );
    return rows[0];
  });

  async function notifyDealer(fastify, lead) {
    const log = fastify.log.child({ leadId: lead.id });
    
    try {
        const client = await fastify.pg.connect();
        let config = null;
        try {
            await client.query("SELECT set_config('app.current_tenant_id', $1, false)", [lead.tenant_id]);
            const configResult = await client.query('SELECT * FROM tenant_configs WHERE tenant_id = $1', [lead.tenant_id]);
            if (configResult.rows.length > 0) {
                config = configResult.rows[0];
            }
        } finally {
            client.release();
        }

        if (!config) {
            log.info('No config found for tenant, skipping notification/sync');
            return;
        }

        const syncPromises = [];

        // 1. Webhook Notification
        if (config.lead_webhook_url) {
            log.info(`Sending lead notification to ${config.lead_webhook_url}`);
            syncPromises.push(
                axios.post(config.lead_webhook_url, {
                    event: 'lead.created',
                    data: lead
                }, { timeout: 4000 }).then(() => log.info('Webhook sent successfully'))
            );
        }

        // 2. HubSpot CRM Sync
        if (config.hubspot_access_token) {
            log.info('Syncing lead to HubSpot...');
            syncPromises.push(
                axios.post('https://api.hubapi.com/crm/v3/objects/contacts', {
                    properties: {
                        firstname: lead.first_name,
                        lastname: lead.last_name,
                        email: lead.email,
                        phone: lead.phone,
                        message: lead.message || 'Lead from Vroom3D 3D Showroom'
                    }
                }, {
                    headers: { 'Authorization': `Bearer ${config.hubspot_access_token}` },
                    timeout: 4000
                }).then(() => log.info('HubSpot sync successful'))
            );
        }

        // 3. DealerSocket CRM Sync
        if (config.dealersocket_api_key) {
            log.info('Syncing lead to DealerSocket...');
            syncPromises.push(
                axios.post('https://api.dealersocket.com/v1/leads', {
                    dealerId: config.dealersocket_dealer_id,
                    customer: {
                        firstName: lead.first_name,
                        lastName: lead.last_name,
                        email: lead.email,
                        phone: lead.phone
                    },
                    comments: lead.message || 'Lead from Vroom3D 3D Showroom'
                }, {
                    headers: { 'x-api-key': config.dealersocket_api_key },
                    timeout: 4000
                }).then(() => log.info('DealerSocket sync successful'))
            );
        }

        // Run all sync tasks in parallel, with a timeout to ensure we don't hang
        await Promise.allSettled(syncPromises);

    } catch (err) {
        log.error(err, 'Failed to process lead integrations');
    }
  }
};
