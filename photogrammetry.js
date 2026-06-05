const axios = require('axios');
const fs = require('fs');
const path = require('path');

const LUMA_API_KEY = process.env.LUMA_AI_API_KEY || 'luma_api_key_placeholder';
const UPLOAD_DIR = path.join(__dirname, 'uploads');

module.exports = async function (fastify, opts) {
  // 1. Trigger photogrammetry for a vehicle
  fastify.post('/inventory/:vin/process-3d', async (request, reply) => {
    if (!request.tenantId) return reply.status(400).send({ error: 'X-Tenant-ID header required' });
    const { vin } = request.params;

    // Get inventory unit
    const units = await fastify.queryWithTenant(request, 
        'SELECT id FROM inventory_units WHERE vin = $1', [vin]);
    if (units.length === 0) return reply.status(404).send({ error: 'Inventory unit not found' });
    const unit = units[0];

    // Check if job already exists/in-progress
    const existingJobs = await fastify.queryWithTenant(request,
        "SELECT id FROM photogrammetry_jobs WHERE inventory_unit_id = $1 AND status IN ('pending', 'processing')",
        [unit.id]);
    if (existingJobs.length > 0) return reply.status(400).send({ error: 'A job is already in progress for this vehicle' });

    // Check for enough assets
    const assets = await fastify.queryWithTenant(request,
        'SELECT * FROM assets WHERE inventory_unit_id = $1 AND file_type LIKE $2',
        [unit.id, 'image/%']);
    
    if (assets.length < 5) {
        return reply.status(400).send({ error: 'At least 5 images are required to trigger photogrammetry' });
    }

    // Create job
    const rows = await fastify.queryWithTenant(request,
        `INSERT INTO photogrammetry_jobs (tenant_id, inventory_unit_id, status)
         VALUES ($1, $2, 'pending') RETURNING *`,
        [request.tenantId, unit.id]
    );
    const job = rows[0];

    // Update unit status
    await fastify.queryWithTenant(request,
        'UPDATE inventory_units SET splat_status = $1 WHERE id = $2',
        ['processing', unit.id]
    );

    // Trigger async pipeline
    setImmediate(() => runPipeline(fastify, job.id, assets, request.tenantId));

    return { job_id: job.id, status: 'started' };
  });

  // 2. GET jobs for a tenant
  fastify.get('/photogrammetry/jobs', async (request, reply) => {
      if (!request.tenantId) return reply.status(400).send({ error: 'X-Tenant-ID header required' });
      return await fastify.queryWithTenant(request, 'SELECT * FROM photogrammetry_jobs ORDER BY created_at DESC');
  });

  async function runPipeline(fastify, jobId, assets, tenantId) {
    const log = fastify.log.child({ jobId });
    log.info('Starting photogrammetry pipeline');

    try {
        // Update job to processing
        await updateJob(fastify, jobId, 'processing', tenantId);

        if (!LUMA_API_KEY || LUMA_API_KEY === 'luma_api_key_placeholder') {
            log.warn('LUMA_AI_API_KEY is not configured or is a placeholder. Using mock simulation.');
            
            // Simulate Luma AI API call
            log.info(`Sending ${assets.length} images to Luma AI API (Simulated)...`);
            await new Promise(r => setTimeout(r, 2000));
            const lumaCaptureId = 'luma_cap_' + Math.random().toString(36).substring(7);
            
            await updateJob(fastify, jobId, 'processing', tenantId, { external_id: lumaCaptureId });

            // Simulate waiting for Luma to process
            log.info(`Luma processing job ${lumaCaptureId} (Simulated)...`);
            await new Promise(r => setTimeout(r, 10000));

            // Mock result URL
            const mockSplatUrl = `https://storage.vroom3d.com/splats/${lumaCaptureId}.splat`;
            
            // Post-processing: compress .splat (mocked)
            log.info(`Compressing .splat for job ${jobId} (Simulated)...`);
            await new Promise(r => setTimeout(r, 2000));

            // Complete job
            await updateJob(fastify, jobId, 'completed', tenantId, { result_url: mockSplatUrl });

            // Update inventory unit
            await updateInventoryUnit(fastify, jobId, tenantId, mockSplatUrl);
            
            log.info('Photogrammetry pipeline completed successfully (Simulated)');
            return;
        }

        // --- REAL LUMA AI INTEGRATION ---
        log.info('Initializing Luma AI Capture...');
        
        // 1. Create Capture
        const createRes = await axios.post('https://webapp.lumalabs.ai/api/v2/capture', {
            title: `Job ${jobId}`
        }, {
            headers: { 'Authorization': `Token ${LUMA_API_KEY}` }
        });

        const lumaCaptureId = createRes.data.id;
        log.info(`Created Luma capture: ${lumaCaptureId}`);
        await updateJob(fastify, jobId, 'processing', tenantId, { external_id: lumaCaptureId });

        // 2. Upload images
        log.info(`Uploading ${assets.length} images to Luma...`);
        for (const asset of assets) {
            const filePath = path.join(UPLOAD_DIR, asset.storage_path);
            if (!fs.existsSync(filePath)) {
                log.warn(`File not found: ${filePath}, skipping...`);
                continue;
            }

            // Get signed upload URL for this image
            const uploadUrlRes = await axios.post(`https://webapp.lumalabs.ai/api/v2/capture/${lumaCaptureId}/upload-url`, {
                filename: asset.file_name
            }, {
                headers: { 'Authorization': `Token ${LUMA_API_KEY}` }
            });

            const { url } = uploadUrlRes.data;
            const fileStream = fs.createReadStream(filePath);
            
            log.info(`Uploading asset ${asset.id} (${asset.file_name})`);
            await axios.put(url, fileStream, {
                headers: { 'Content-Type': asset.file_type }
            });
        }

        // 3. Trigger processing
        log.info('Triggering Luma AI processing...');
        await axios.post(`https://webapp.lumalabs.ai/api/v2/capture/${lumaCaptureId}/trigger`, {}, {
            headers: { 'Authorization': `Token ${LUMA_API_KEY}` }
        });

        // 4. Polling for completion
        let status = 'processing';
        let resultUrl = null;
        let pollCount = 0;
        const maxPolls = 60; // 30 minutes max polling (30s * 60)

        while ((status === 'processing' || status === 'pending') && pollCount < maxPolls) {
            pollCount++;
            log.info(`Polling Luma status for ${lumaCaptureId} (attempt ${pollCount})...`);
            await new Promise(r => setTimeout(r, 30000)); // Poll every 30s
            
            const statusRes = await axios.get(`https://webapp.lumalabs.ai/api/v2/capture/${lumaCaptureId}`, {
                headers: { 'Authorization': `Token ${LUMA_API_KEY}` }
            });
            
            status = statusRes.data.status;
            log.info(`Current status: ${status}`);

            if (status === 'completed') {
                // Find Gaussian Splat artifact in the latest run
                const splatArtifact = statusRes.data.latest_run?.artifacts?.find(a => a.type === 'gaussian_splat');
                resultUrl = splatArtifact?.url;
                
                if (!resultUrl) {
                    // Fallback to searching all artifacts if latest_run is structured differently
                    const anySplat = statusRes.data.artifacts?.find(a => a.type === 'gaussian_splat');
                    resultUrl = anySplat?.url;
                }
            } else if (status === 'failed') {
                throw new Error(`Luma AI processing failed: ${statusRes.data.error || 'Unknown error'}`);
            }
        }

        if (pollCount >= maxPolls) {
            throw new Error('Timed out waiting for Luma AI processing');
        }

        if (!resultUrl) {
            throw new Error('Luma AI completed but no Gaussian Splat URL was found');
        }

        log.info(`Luma AI processing complete. Result: ${resultUrl}`);

        // 5. Finalize Job
        await updateJob(fastify, jobId, 'completed', tenantId, { result_url: resultUrl });
        await updateInventoryUnit(fastify, jobId, tenantId, resultUrl);

        log.info('Photogrammetry pipeline completed successfully');

    } catch (err) {
        log.error(err, 'Photogrammetry pipeline failed');
        try {
            await updateJob(fastify, jobId, 'failed', tenantId);
            const client = await fastify.pg.connect();
            try {
                await client.query("SELECT set_config('app.current_tenant_id', $1, false)", [tenantId]);
                const jobDataResult = await client.query('SELECT inventory_unit_id FROM photogrammetry_jobs WHERE id = $1', [jobId]);
                if (jobDataResult.rows.length > 0) {
                    await client.query(
                        'UPDATE inventory_units SET splat_status = $1 WHERE id = $2',
                        ['failed', jobDataResult.rows[0].inventory_unit_id]
                    );
                }
            } finally {
                client.release();
            }
        } catch (updateErr) {
            log.error(updateErr, 'Failed to update job status after failure');
        }
    }
  }

  async function updateInventoryUnit(fastify, jobId, tenantId, splatUrl) {
    const client = await fastify.pg.connect();
    try {
        await client.query("SELECT set_config('app.current_tenant_id', $1, false)", [tenantId]);
        const jobDataResult = await client.query('SELECT inventory_unit_id FROM photogrammetry_jobs WHERE id = $1', [jobId]);
        const inventoryUnitId = jobDataResult.rows[0].inventory_unit_id;
        
        await client.query(
            'UPDATE inventory_units SET splat_url = $1, splat_status = $2 WHERE id = $3',
            [splatUrl, 'ready', inventoryUnitId]
        );
    } finally {
        client.release();
    }
  }

  async function updateJob(fastify, jobId, status, tenantId, extras = {}) {
    const fields = ['status = $1', 'updated_at = CURRENT_TIMESTAMP'];
    const params = [status, jobId];
    
    let counter = 3;
    if (extras.external_id) {
        fields.push(`external_id = $${counter++}`);
        params.push(extras.external_id);
    }
    if (extras.result_url) {
        fields.push(`result_url = $${counter++}`);
        params.push(extras.result_url);
    }

    const client = await fastify.pg.connect();
    try {
        await client.query("SELECT set_config('app.current_tenant_id', $1, false)", [tenantId]);
        await client.query(
            `UPDATE photogrammetry_jobs SET ${fields.join(', ')} WHERE id = $2`,
            params
        );
    } finally {
        client.release();
    }
  }
};
