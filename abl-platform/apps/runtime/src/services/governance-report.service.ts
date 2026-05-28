import type { Response } from 'express';
import { createLogger } from '@abl/compiler/platform';
import type { GovernanceAuditService } from './governance-audit.service.js';

const log = createLogger('governance');

const REPORT_MAX_ROWS = parseInt(process.env.GOVERNANCE_REPORT_MAX_ROWS ?? '10000', 10);

export class GovernanceReportService {
  constructor(private readonly auditService: GovernanceAuditService) {}

  async streamCsvReport(
    tenantId: string,
    projectId: string,
    period: string,
    res: Response,
  ): Promise<void> {
    const Papa = (await import('papaparse')).default;

    const auditPage = await this.auditService.getAuditEvents(
      tenantId,
      projectId,
      period,
      1,
      REPORT_MAX_ROWS,
    );

    const rows = auditPage.events.map((e) => ({
      eventRef: e.eventRef,
      timestamp: e.timestamp,
      pipelineType: e.pipelineType,
      metric: e.metric,
      agentName: e.agentName,
      agentVersion: e.agentVersion ?? '',
      threshold: e.threshold,
      thresholdAtTime: e.thresholdAtTime,
      actualValue: e.actualValue,
      severity: e.severity,
      eventType: e.eventType,
      overrideId: e.overrideId ?? '',
      reviewStatus: e.reviewStatus ?? '',
    }));

    const csv = Papa.unparse(rows);

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="governance-report-${period}.csv"`);
    res.write(csv);
    res.end();
  }

  async streamPdfReport(
    tenantId: string,
    projectId: string,
    period: string,
    res: Response,
  ): Promise<void> {
    const buf = await Promise.race([
      this.generatePdfBuffer(tenantId, projectId, period),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('PDF generation timeout')), 30000),
      ),
    ]);

    if (buf.length > 50_000_000) {
      res.status(413).json({
        success: false,
        error: {
          code: 'GOVERNANCE_REPORT_TOO_LARGE',
          message: 'Report exceeds 50MB limit — reduce the period or use CSV export',
        },
      });
      return;
    }

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="governance-report-${period}.pdf"`);
    res.setHeader('Content-Length', String(buf.length));
    res.end(buf);
  }

  private async generatePdfBuffer(
    tenantId: string,
    projectId: string,
    period: string,
  ): Promise<Buffer> {
    const PDFDocument = (await import('pdfkit')).default;
    const { PassThrough } = await import('node:stream');

    const auditPage = await this.auditService.getAuditEvents(
      tenantId,
      projectId,
      period,
      1,
      Math.min(500, REPORT_MAX_ROWS),
    );

    return new Promise<Buffer>((resolve, reject) => {
      const doc = new PDFDocument({
        autoFirstPage: true,
        margins: { top: 50, bottom: 50, left: 72, right: 72 },
      });
      const stream = new PassThrough();
      const chunks: Buffer[] = [];

      stream.on('data', (chunk: Buffer) => chunks.push(chunk));
      stream.on('finish', () => resolve(Buffer.concat(chunks)));
      stream.on('error', reject);

      doc.pipe(stream);

      // Cover page
      doc.fontSize(20).text('Governance Compliance Report', { align: 'center' });
      doc.moveDown();
      doc.fontSize(12).text(`Period: ${period}`, { align: 'center' });
      doc.fontSize(10).text(`Generated: ${new Date().toISOString()}`, { align: 'center' });
      doc.addPage();

      // Audit events
      doc.fontSize(14).text('Audit Events', { underline: true });
      doc.moveDown(0.5);
      if (auditPage.events.length === 0) {
        doc.fontSize(10).text('No breach events in this period.');
      } else {
        doc.fontSize(9);
        for (const e of auditPage.events) {
          doc.text(
            `[${e.severity.toUpperCase()}] ${e.pipelineType} / ${e.metric} | Agent: ${e.agentName} | Actual: ${e.actualValue} | Threshold: ${e.thresholdAtTime} | ${e.timestamp}`,
            { continued: false },
          );
        }
      }

      doc.end();
    });
  }
}
