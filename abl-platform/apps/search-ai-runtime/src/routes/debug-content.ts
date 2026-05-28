/**
 * Debug endpoint to check if chunks have empty content
 * Temporary diagnostic route - remove after fixing the issue
 */

import express from 'express';
import { createLogger } from '@abl/compiler/platform';

const logger = createLogger('debug-content');

export function createDebugContentRouter(getDb: () => any, vectorStore: any): express.Router {
  const router = express.Router();

  router.get('/debug/:indexId/content-check', async (req, res) => {
    try {
      const { indexId } = req.params;

      // Get MongoDB connection
      const db = getDb();
      const SearchChunk = db.model('SearchChunk');

      // Sample 5 chunks from this index
      const chunks = await SearchChunk.find({ indexId })
        .limit(5)
        .select('_id content tokenCount metadata.sys')
        .lean();

      const analysis = chunks.map((chunk: any) => ({
        chunkId: chunk._id.toString(),
        contentLength: (chunk.content || '').length,
        tokenCount: chunk.tokenCount,
        hasContent: !!chunk.content && chunk.content.length > 0,
        documentId: chunk.metadata?.sys?.documentId,
      }));

      // Count empty chunks in this index
      const totalChunks = await SearchChunk.countDocuments({ indexId });
      const emptyChunks = await SearchChunk.countDocuments({
        indexId,
        $or: [{ content: '' }, { content: { $exists: false } }],
      });

      res.json({
        indexId,
        totalChunks,
        emptyChunks,
        emptyPercentage: ((emptyChunks / totalChunks) * 100).toFixed(2) + '%',
        sample: analysis,
      });
    } catch (error) {
      logger.error('Debug content check failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({ error: 'Failed to check content' });
    }
  });

  return router;
}
