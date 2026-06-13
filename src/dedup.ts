import crypto from 'crypto';
import { Firestore, FieldValue } from '@google-cloud/firestore';
import { Article } from './fetcher';

import fs from 'fs';
import path from 'path';

// Initialize the DB reference. It'll be passed or initialized in typical Node setup.
// We import and retrieve Firestore instance to match Prompt 2 and Prompt 3 requirements.
let dbInstance: Firestore | null = null;

export function getFirestoreDb(): Firestore {
  if (!dbInstance) {
    let firebaseConfig: any = {};
    try {
      const configPath = path.join(process.cwd(), 'firebase-applet-config.json');
      if (fs.existsSync(configPath)) {
        firebaseConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      }
    } catch (e) {
      console.error('Failed to load firebase-applet-config.json in dedup.ts:', e);
    }

    const serviceAccountEnv = process.env.FIREBASE_SERVICE_ACCOUNT;
    const firestoreOptions: any = {
      projectId: firebaseConfig.projectId,
      databaseId: firebaseConfig.firestoreDatabaseId || '(default)',
    };

    if (serviceAccountEnv) {
      try {
        firestoreOptions.credentials = JSON.parse(serviceAccountEnv);
      } catch (parseErr: any) {
        console.error('Failed to parse FIREBASE_SERVICE_ACCOUNT in dedup.ts:', parseErr.message);
      }
    }

    dbInstance = new Firestore(firestoreOptions);
  }
  return dbInstance;
}

/**
 * Generates a SHA-256 Hex Digest of a given absolute link URL.
 * Used as the stable Firestore document ID to support fast lookups
 * and avoid URL format string problems in document IDs.
 * @param link Normalized article Link
 */
export function getLinkHash(link: string): string {
  return crypto.createHash('sha256').update(link.trim()).digest('hex');
}

/**
 * Filter an array of incoming Feed articles to return only those
 * that do not exist yet in the Firestore database.
 * Uses Firestore db.getAll() for batched reading to maximize speed and cost-performance.
 * @param articles Set of crawled feed articles
 * @returns Filtered list of unseen articles
 */
export async function detectNewArticles(articles: Article[]): Promise<Article[]> {
  const db = getFirestoreDb();
  
  if (!articles.length) return [];

  // 1. Client-Side Dedup: Ensure we don't process the same link multiple times in the same invocation
  const uniqueArticlesMap = new Map<string, Article>();
  for (const art of articles) {
    const canonicalLink = art.link.trim();
    if (canonicalLink) {
      uniqueArticlesMap.set(canonicalLink, art);
    }
  }

  const dedupedInputs = Array.from(uniqueArticlesMap.values());
  const results: Article[] = [];

  // Chunking read requests (Firestore db.getAll max Limit is typically 1000, we use chunks of 200 for stability)
  const chunkSize = 200;
  for (let i = 0; i < dedupedInputs.length; i += chunkSize) {
    const chunk = dedupedInputs.slice(i, i + chunkSize);
    const docRefs = chunk.map((art) => {
      const docId = getLinkHash(art.link);
      return db.collection('seen_articles').doc(docId);
    });

    try {
      // Fetch entire batch of document snapshots in a single network trip
      const snapshots = await db.getAll(...docRefs);
      
      // Compare each item in the chunk. If the snapshot does not exist, it represents a new article
      chunk.forEach((art, idx) => {
        const snap = snapshots[idx];
        if (!snap || !snap.exists) {
          results.push(art);
        }
      });
    } catch (err: any) {
      console.error(JSON.stringify({
        severity: 'ERROR',
        message: `Failed fetching batched documents from seen_articles collection`,
        error: err.message || String(err)
      }));
      // Fail-secure: If DB read fails, skip adding to avoid spamming alerts
    }
  }

  console.log(JSON.stringify({
    severity: 'INFO',
    message: `Deduplication complete. Scanned ${articles.length} items; detected ${results.length} brand-new articles.`
  }));

  return results;
}

/**
 * Batches the recording of newly discovered articles into Firestore's seen_articles cache.
 * Avoids 500-write-limit limits by chunking insertions into standard batches of 200.
 * @param articles Newly discovered articles to store
 */
export async function markAsSeen(articles: Article[]): Promise<void> {
  const db = getFirestoreDb();
  if (!articles.length) return;

  const chunkSize = 200; // Limit is 500, 200 is extremely safe and responsive
  for (let i = 0; i < articles.length; i += chunkSize) {
    const chunk = articles.slice(i, i + chunkSize);
    const batch = db.batch();

    chunk.forEach((art) => {
      const docId = getLinkHash(art.link);
      const docRef = db.collection('seen_articles').doc(docId);

      batch.set(docRef, {
        sourceId: art.sourceId,
        url: art.link,
        title: art.title,
        description: art.summary,
        // We set both the native firestore FieldValue (for index filters/TTL) 
        // and string firstSeenAt (for the front-end components schema representation)
        firstSeenAt: new Date().toISOString(),
        serverTimestamp: FieldValue.serverTimestamp()
      });
    });

    await batch.commit();
  }

  console.log(JSON.stringify({
    severity: 'INFO',
    message: `Successfully indexed ${articles.length} new articles into seen_articles cache collection.`
  }));
}

/**
 * Periodically deletes historical records older than 90 days to stay within free storage bounds.
 * Note: Alternatively, Firestore TTL can be enabled in Google Cloud Console:
 * 'gcloud firestore fields ttl update serverTimestamp --collection-group=seen_articles --enable-ttl'
 * This completely automates deletion with zero compute costs!
 */
export async function cleanupOldArticles(days = 90): Promise<number> {
  const db = getFirestoreDb();
  const rawCutoff = new Date();
  rawCutoff.setDate(rawCutoff.getDate() - days);
  
  const docsToDelete = await db.collection('seen_articles')
    .where('serverTimestamp', '<', rawCutoff)
    .limit(300)
    .get();

  if (docsToDelete.empty) return 0;

  const batch = db.batch();
  docsToDelete.docs.forEach((doc) => {
    batch.delete(doc.ref);
  });

  await batch.commit();
  console.log(JSON.stringify({
    severity: 'INFO',
    message: `Cleaned up ${docsToDelete.size} obsolete legacy records older than ${days} days.`
  }));

  return docsToDelete.size;
}
