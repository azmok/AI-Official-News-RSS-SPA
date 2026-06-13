import { Request, Response } from 'express';
import { fetchAllSources } from './fetcher';
import { detectNewArticles, markAsSeen } from './dedup';
import { sendDigest } from './mailer';

/**
 * AI News Digest Core Orchestration Handler
 * Implements Prompt 3 flow securely and idempotently:
 * 1. fetchAllSources() -> Crawl all blogs in parallel with error isolation
 * 2. detectNewArticles() -> Read Firestore for seen items in batches (SHA-256 ID lookups)
 * 3. sendDigest() -> Compile and email JST-focused digest if new content exists
 * 4. markAsSeen() -> Record newly mailed links in database to guarantee single-delivery idempotence
 */
export async function handleCheck(req: Request, res: Response) {
  const startTime = Date.now();
  console.log(JSON.stringify({
    severity: 'INFO',
    message: '[Cron] Triggered periodic feed compilation cycle.'
  }));

  try {
    // Step 1: Crawl all configured blogs
    const rawArticles = await fetchAllSources();

    // Step 2: Extract unseen novel entries (deduplicates within batch and against DB)
    const newArticles = await detectNewArticles(rawArticles);

    let emailSent = false;
    if (newArticles.length > 0) {
      // Step 3: Dispatch digest HTML email to configured subscriber
      emailSent = await sendDigest(newArticles);

      // Step 4: Index of mailed articles in the database cache
      if (emailSent) {
        await markAsSeen(newArticles);
      }
    } else {
      console.log(JSON.stringify({
        severity: 'INFO',
        message: 'No unseen articles extracted. Cycle concluded with no dispatch.'
      }));
    }

    const durationMs = Date.now() - startTime;
    const report = {
      status: 'success',
      totalFetched: rawArticles.length,
      newDiscovered: newArticles.length,
      newArticlesCount: newArticles.length,
      newArticles: newArticles.map((art) => ({
        sourceName: art.sourceName,
        title: art.title,
        url: art.link
      })),
      emailSent,
      durationMs
    };

    console.log(JSON.stringify({
      severity: 'INFO',
      message: 'Digest compilation cycle completed successfully.',
      ...report
    }));

    return res.status(200).json(report);
  } catch (err: any) {
    const durationMs = Date.now() - startTime;
    console.error(JSON.stringify({
      severity: 'ERROR',
      message: 'Fatal error occurred during digest orchestration sweep',
      error: err.message || String(err),
      durationMs
    }));

    return res.status(500).json({
      status: 'error',
      message: err.message || 'Fatal feed parser panic.'
    });
  }
}

/**
 * =========================================================================
 * ⚙️ GOOGLE CLOUD INBOUND INTEGRATION & DEPLOYMENT INSTRUCTIONS
 * =========================================================================
 *
 * 1. GMAIL APP PASSWORD FORMULATION:
 *    - Visit Google Account Profile -> Security -> 2-Step Verification -> App Passwords
 *    - Generate a custom App Name (e.g. "Cloud Run AI Reader") and copy the 16-char secret.
 *
 * 2. PROVISION CLOUD RUN CONTAINER DEPLOYMENT:
 *    Submit the following gcloud command inside CLI terminal to package, build, and deploy.
 *    Provide authorization prompts as necessary.
 *
 *    gcloud run deploy ai-news-digest \
 *      --source . \
 *      --platform managed \
 *      --region asia-northeast1 \
 *      --allow-unauthenticated \
 *      --update-env-vars=SMTP_USER="your-email@gmail.com",SMTP_PASS="xxxx-xxxx-xxxx-xxxx",DIGEST_TO="gentakanashi0425@gmail.com",CHECK_SECRET="my_shared_secure_cron_token"
 *
 * 3. SETUP SECURE CRON SCHEDULER:
 *    Schedule the target Cloud Run instance to trigger 3 times per day (8:00 JST, 13:00 JST, 18:00 JST)
 *    Cron pattern representation: '0 8,13,18 * * *' with timezone specified.
 *
 *    gcloud scheduler jobs create http ai-news-digest-cron \
 *      --schedule="0 8,13,18 * * *" \
 *      --uri="https://<YOUR-CLOUD-RUN-URL>/api/check?secret=my_shared_secure_cron_token" \
 *      --http-method=POST \
 *      --time-zone="Asia/Tokyo" \
 *      --description="Trigger digest news harvester hourly sequence"
 */
