import nodemailer from 'nodemailer';
import { Article } from './fetcher';

interface MailConfig {
  smtpUser: string;
  smtpPass: string;
  digestTo: string;
}

/**
 * Retrieves general SMTP and recipient credentials from environmental variables.
 * Returns null if unconfigured to support simulator fallback mode.
 */
function getMailConfig(): MailConfig | null {
  const smtpUser = process.env.SMTP_USER;
  const smtpPass = process.env.SMTP_PASS;
  const digestTo = process.env.DIGEST_TO;

  if (!smtpUser || !smtpPass || !digestTo) {
    return null;
  }

  return { smtpUser, smtpPass, digestTo };
}

/**
 * Organizes a flat list of novel Articles by their respective feed sources.
 * @param articles novel articles.
 */
function groupArticlesBySource(articles: Article[]): Record<string, Article[]> {
  const grouped: Record<string, Article[]> = {};
  for (const art of articles) {
    if (!grouped[art.sourceName]) {
      grouped[art.sourceName] = [];
    }
    grouped[art.sourceName].push(art);
  }
  return grouped;
}

/**
 * Sends a streamlined, highly polished HTML Email Digest of discovered updates.
 * Subject format is explicitly normalized to timezone-adjusted JST date: '[AI News] M月D日のダイジェスト（N件）'
 * @param newArticles List of brand-new articles
 */
export async function sendDigest(newArticles: Article[]): Promise<boolean> {
  if (!newArticles.length) {
    console.log(JSON.stringify({
      severity: 'INFO',
      message: 'Skipping email send. No new articles to compile.'
    }));
    return false;
  }

  const mailConfig = getMailConfig();

  // Calculate precise JST "M月D日" (Japan Standard Time, UTC+9)
  const utcNow = new Date();
  const jstOffset = 9 * 60 * 60 * 1000;
  const jstDate = new Date(utcNow.getTime() + jstOffset);
  const month = jstDate.getUTCMonth() + 1;
  const date = jstDate.getUTCDate();
  
  const subject = `[AI News] ${month}月${date}日のダイジェスト（${newArticles.length}件）`;

  // Build beautiful HTML body, grouping articles by publication source
  const grouped = groupArticlesBySource(newArticles);
  let htmlContent = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <style>
        body {
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
          color: #1e293b;
          line-height: 1.6;
          margin: 0;
          padding: 24px;
          background-color: #f8fafc;
        }
        .container {
          max-width: 640px;
          margin: 0 auto;
          background: #ffffff;
          border: 1px solid #e2e8f0;
          border-radius: 12px;
          padding: 32px;
          box-shadow: 0 4px 6px -1px rgb(0 0 0 / 0.05);
        }
        .header {
          border-bottom: 2px solid #3b82f6;
          padding-bottom: 16px;
          margin-bottom: 24px;
        }
        .title {
          font-size: 22px;
          font-weight: 700;
          color: #0f172a;
          margin: 0;
        }
        .subtitle {
          font-size: 13px;
          color: #64748b;
          margin: 4px 0 0 0;
        }
        .source-section {
          background-color: #fafafa;
          border-left: 4px solid #3b82f6;
          padding: 12px 16px;
          margin: 24px 0 12px 0;
          font-size: 15px;
          font-weight: 600;
          color: #1e3a8a;
          border-radius: 0 6px 6px 0;
        }
        .article {
          margin-bottom: 20px;
          padding-bottom: 16px;
          border-bottom: 1px dashed #e2e8f0;
        }
        .article:last-child {
          border-bottom: none;
          margin-bottom: 8px;
        }
        .art-title {
          font-size: 15px;
          font-weight: 600;
          margin: 0 0 4px 0;
        }
        .art-title a {
          color: #2563eb;
          text-decoration: none;
        }
        .art-title a:hover {
          text-decoration: underline;
        }
        .art-meta {
          font-size: 11px;
          color: #94a3b8;
          margin: 0 0 6px 0;
        }
        .art-summary {
          font-size: 13px;
          color: #334155;
          margin: 0;
        }
        .footer {
          margin-top: 36px;
          border-top: 1px solid #e2e8f0;
          padding-top: 16px;
          font-size: 11px;
          color: #94a3b8;
          text-align: center;
        }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h1 class="title">AI Developer Journals Digest</h1>
          <p class="subtitle">${newArticles.length} updates found during JST timeline sweep</p>
        </div>
  `;

  for (const [sourceName, sourceArticles] of Object.entries(grouped)) {
    htmlContent += `<div class="source-section">${sourceName}</div>`;
    for (const art of sourceArticles) {
      // Format show timestamp
      let formattedDate = '';
      try {
        const artDate = new Date(art.publishedAt);
        const artJst = new Date(artDate.getTime() + jstOffset);
        formattedDate = `${artJst.getUTCFullYear()}-${String(artJst.getUTCMonth() + 1).padStart(2, '0')}-${String(artJst.getUTCDate()).padStart(2, '0')} ${String(artJst.getUTCHours()).padStart(2, '0')}:${String(artJst.getUTCMinutes()).padStart(2, '0')} JST`;
      } catch {
        formattedDate = art.publishedAt;
      }

      htmlContent += `
        <div class="article">
          <h3 class="art-title">
            <a href="${art.link}" target="_blank" rel="noopener noreferrer">${art.title}</a>
          </h3>
          <p class="art-meta">Published: ${formattedDate}</p>
          <p class="art-summary">${art.summary || 'No summary description provided.'}</p>
        </div>
      `;
    }
  }

  htmlContent += `
        <div class="footer">
          This mail was generated automatically by AI News Digest running on Google Cloud.
        </div>
      </div>
    </body>
    </html>
  `;

  if (!mailConfig) {
    console.warn(JSON.stringify({
      severity: 'WARNING',
      message: `[Email Simulation Mode] SMTP environment configs (SMTP_USER, SMTP_PASS, DIGEST_TO) are empty. The email dispatch was simulated successfully in preview mode.`,
      subject,
      recipient: 'gentakanashi0425@gmail.com (Simulation Fallback)'
    }));
    return true;
  }

  // Create transporter pointing securely to Gmail SMTP services
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    host: 'smtp.gmail.com',
    port: 465,
    secure: true, // Use SSL
    auth: {
      user: mailConfig.smtpUser,
      pass: mailConfig.smtpPass
    }
  });

  const info = await transporter.sendMail({
    from: `"AI News Digest" <${mailConfig.smtpUser}>`,
    to: mailConfig.digestTo,
    subject: subject,
    html: htmlContent
  });

  console.log(JSON.stringify({
    severity: 'INFO',
    message: `Digest email dispatch completed successfully!`,
    messageId: info.messageId,
    recipient: mailConfig.digestTo,
    subject
  }));

  return true;
}
