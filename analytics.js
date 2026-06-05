// analytics.js
module.exports = async function (fastify, opts) {
  // 1. Post a new analytics event
  fastify.post('/api/analytics', async (request, reply) => {
    if (!request.tenantId) return reply.status(400).send({ error: 'X-Tenant-ID header required' });
    
    const { 
        inventory_unit_id, 
        session_id, 
        event_type, 
        payload 
    } = request.body;

    if (!session_id || !event_type) {
        return reply.status(400).send({ error: 'session_id and event_type are required' });
    }

    // Insert event
    await fastify.queryWithTenant(request,
        `INSERT INTO analytics_events (tenant_id, inventory_unit_id, session_id, event_type, payload)
         VALUES ($1, $2, $3, $4, $5)`,
        [request.tenantId, inventory_unit_id, session_id, event_type, payload || {}]
    );

    return { status: 'success' };
  });

  // 2. GET summary analytics for the dashboard
  fastify.get('/api/analytics/summary', async (request, reply) => {
    if (!request.tenantId) return reply.status(400).send({ error: 'X-Tenant-ID header required' });

    // Aggregate some basic metrics
    // Total events, unique sessions, events by type
    const stats = await fastify.queryWithTenant(request,
        `SELECT 
            COUNT(*) as total_events,
            COUNT(DISTINCT session_id) as unique_sessions,
            COUNT(DISTINCT inventory_unit_id) as vehicles_viewed,
            AVG((payload->>'duration_sec')::numeric) FILTER (WHERE event_type = 'viewer_closed') as avg_session_duration
         FROM analytics_events`
    );

    const eventsByType = await fastify.queryWithTenant(request,
        `SELECT event_type, COUNT(*) as count 
         FROM analytics_events 
         GROUP BY event_type 
         ORDER BY count DESC`
    );

    const popularColors = await fastify.queryWithTenant(request,
        `SELECT payload->>'color' as color, COUNT(*) as count 
         FROM analytics_events 
         WHERE event_type = 'color_changed' AND payload->>'color' IS NOT NULL
         GROUP BY payload->>'color' 
         ORDER BY count DESC 
         LIMIT 5`
    );

    return {
        overall: stats[0],
        events_by_type: eventsByType,
        popular_colors: popularColors
    };
  });

  // 3. GET vehicle-specific analytics
  fastify.get('/api/analytics/vehicle/:id', async (request, reply) => {
    if (!request.tenantId) return reply.status(400).send({ error: 'X-Tenant-ID header required' });
    const { id } = request.params;

    const stats = await fastify.queryWithTenant(request,
        `SELECT 
            COUNT(*) as total_events,
            COUNT(DISTINCT session_id) as unique_sessions
         FROM analytics_events
         WHERE inventory_unit_id = $1`,
        [id]
    );

    const timeline = await fastify.queryWithTenant(request,
        `SELECT event_type, created_at, payload
         FROM analytics_events
         WHERE inventory_unit_id = $1
         ORDER BY created_at DESC
         LIMIT 100`,
        [id]
    );

    return {
        vehicle_id: id,
        summary: stats[0],
        recent_events: timeline
    };
  });
};
