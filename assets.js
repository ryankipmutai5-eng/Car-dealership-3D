// assets.js
const fs = require('fs');
const path = require('path');
const { pipeline } = require('stream/promises');
const sharp = require('sharp');
const { v4: uuidv4 } = require('uuid');

const UPLOAD_DIR = path.join(__dirname, 'uploads');

// Ensure upload directory exists
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

async function assetRoutes(fastify, options) {
  // Helper to get DB client with tenant context
  const getClient = async (tenantId) => {
    const client = await fastify.pg.connect();
    await client.query(`SET app.current_tenant_id = '${tenantId}'`);
    return client;
  };

  // POST /assets/upload
  fastify.post('/assets/upload', async (request, reply) => {
    const tenantId = request.headers['x-tenant-id'];
    if (!tenantId) {
      return reply.code(400).send({ error: 'X-Tenant-ID header is required' });
    }

    const data = await request.file();
    if (!data) {
      return reply.code(400).send({ error: 'No file uploaded' });
    }

    const {
      filename,
      mimetype,
      fields
    } = data;
    
    const inventoryUnitId = fields.inventory_unit_id?.value;
    const assetType = fields.asset_type?.value || 'photo';
    const isPrimary = fields.is_primary?.value === 'true';

    const assetId = uuidv4();
    const extension = path.extname(filename);
    const storageName = `${assetId}${extension}`;
    const storagePath = path.join(UPLOAD_DIR, storageName);

    // Save file to local storage
    await pipeline(data.file, fs.createWriteStream(storagePath));

    // Extract metadata if it's an image
    let metadata = { size: fs.statSync(storagePath).size };
    if (mimetype.startsWith('image/')) {
      try {
        const image = sharp(storagePath);
        const imageMetadata = await image.metadata();
        metadata.width = imageMetadata.width;
        metadata.height = imageMetadata.height;
        if (imageMetadata.size) metadata.size = imageMetadata.size;
      } catch (err) {
        fastify.log.error('Failed to extract image metadata', err);
      }
    }

    const client = await getClient(tenantId);
    try {
      const { rows } = await client.query(
        `INSERT INTO assets (
          id, tenant_id, inventory_unit_id, file_name, file_type, 
          file_size, storage_path, resolution_width, resolution_height, 
          asset_type, is_primary
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        RETURNING *`,
        [
          assetId,
          tenantId,
          inventoryUnitId,
          filename,
          mimetype,
          metadata.size,
          storageName, // Just store the filename in the DB
          metadata.width,
          metadata.height,
          assetType,
          isPrimary
        ]
      );

      return rows[0];
    } finally {
      client.release();
    }
  });

  // GET /assets
  fastify.get('/assets', async (request, reply) => {
    const tenantId = request.headers['x-tenant-id'];
    const inventoryUnitId = request.query.inventory_unit_id;

    const client = await getClient(tenantId);
    try {
      let query = 'SELECT * FROM assets WHERE 1=1';
      const params = [];
      if (inventoryUnitId) {
        query += ' AND inventory_unit_id = $1';
        params.push(inventoryUnitId);
      }
      query += ' ORDER BY created_at DESC';

      const { rows } = await client.query(query, params);
      return rows;
    } finally {
      client.release();
    }
  });

  // GET /assets/:id/content
  fastify.get('/assets/:id/content', async (request, reply) => {
    const tenantId = request.headers['x-tenant-id'];
    const { id } = request.params;

    let asset;
    const client = await getClient(tenantId);
    try {
      const { rows } = await client.query('SELECT * FROM assets WHERE id = $1', [id]);
      if (rows.length === 0) {
        return reply.code(404).send({ error: 'Asset not found' });
      }
      asset = rows[0];
    } finally {
      client.release();
    }

    const filePath = path.join(UPLOAD_DIR, asset.storage_path);
    if (!fs.existsSync(filePath)) {
      return reply.code(404).send({ error: 'File not found on disk' });
    }

    const stream = fs.createReadStream(filePath);
    return reply.type(asset.file_type).send(stream);
  });
  
  // DELETE /assets/:id
  fastify.delete('/assets/:id', async (request, reply) => {
    const tenantId = request.headers['x-tenant-id'];
    const { id } = request.params;

    const client = await getClient(tenantId);
    try {
      const { rows } = await client.query('DELETE FROM assets WHERE id = $1 RETURNING storage_path', [id]);
      if (rows.length === 0) {
        return reply.code(404).send({ error: 'Asset not found' });
      }

      const storagePath = path.join(UPLOAD_DIR, rows[0].storage_path);
      if (fs.existsSync(storagePath)) {
        fs.unlinkSync(storagePath);
      }

      return { success: true };
    } finally {
      client.release();
    }
  });
}

module.exports = assetRoutes;
